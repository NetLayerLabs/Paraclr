// Alerting to ALERT_WEBHOOK_URL (Discord, Slack or any JSON webhook) + an in-memory log for
// GET /alerts and /health.
//
// Every alert has a stable `key` (e.g. "balance:keeper[3]", "oracle:stale:MON/AUSD"). An alert
// fires when its key becomes active, re-fires at most every ALERT_REPEAT_MS while it stays
// active, and sends one "resolved" message when it clears. So a stuck condition pages once per
// repeat window, not once per block.
//
// Payload: `{ content, text, alert }` — `content` is what Discord shows, `text` what Slack shows,
// `alert` is the structured record for anything else (PagerDuty/Telegram relays etc.).
// Webhook URLs often embed a secret token: the URL is never logged.

import { envStr } from "../env";
import { envNum } from "./config";

export type Severity = "info" | "warning" | "critical";

export interface AlertRecord {
  key: string;
  severity: Severity;
  message: string;
  at: number;
  /** "firing" (new or repeated) or "resolved". */
  state: "firing" | "resolved";
  details?: Record<string, unknown>;
}

interface Active {
  severity: Severity;
  message: string;
  since: number;
  lastSentAt: number;
  details?: Record<string, unknown>;
}

const ICON: Record<Severity, string> = { info: "ℹ️", warning: "⚠️", critical: "🚨" };

export class Alerter {
  private readonly active = new Map<string, Active>();
  readonly log: AlertRecord[] = [];
  private readonly url: string | undefined;
  private readonly repeatMs: number;
  private webhookFailures = 0;
  private lastWebhookError: string | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly label: string,
    opts: { url?: string; repeatMs?: number } = {},
  ) {
    this.url = opts.url ?? envStr("ALERT_WEBHOOK_URL");
    this.repeatMs = opts.repeatMs ?? envNum("ALERT_REPEAT_MS", 30 * 60_000);
  }

  get configured(): boolean {
    return Boolean(this.url);
  }

  /** Raise (or keep raising) `key`. Sends when new, when severity escalates, or after the repeat window. */
  fire(key: string, severity: Severity, message: string, details?: Record<string, unknown>): void {
    const now = Date.now();
    const prev = this.active.get(key);
    const escalated = prev && rank(severity) > rank(prev.severity);
    if (prev && !escalated && now - prev.lastSentAt < this.repeatMs) {
      prev.message = message;
      prev.details = details;
      return;
    }
    this.active.set(key, { severity, message, since: prev?.since ?? now, lastSentAt: now, details });
    this.emit({ key, severity, message, at: now, state: "firing", details });
  }

  /** Clear `key` if it is active (sends one "resolved"). */
  resolve(key: string, message?: string): void {
    const prev = this.active.get(key);
    if (!prev) return;
    this.active.delete(key);
    const mins = Math.max(1, Math.round((Date.now() - prev.since) / 60_000));
    this.emit({
      key,
      severity: "info",
      message: message ?? `resolved after ~${mins} min: ${prev.message}`,
      at: Date.now(),
      state: "resolved",
    });
  }

  /** Fire when `cond`, else resolve — the common monitor pattern. */
  set(cond: boolean, key: string, severity: Severity, message: string, details?: Record<string, unknown>): void {
    if (cond) this.fire(key, severity, message, details);
    else this.resolve(key);
  }

  /** One-off event (no active state): e.g. "order 12 expired", "pause observed". */
  event(key: string, severity: Severity, message: string, details?: Record<string, unknown>): void {
    this.emit({ key, severity, message, at: Date.now(), state: "firing", details });
  }

  activeAlerts(): Array<{ key: string; severity: Severity; message: string; since: number }> {
    return [...this.active.entries()].map(([key, a]) => ({ key, severity: a.severity, message: a.message, since: a.since }));
  }

  status() {
    return {
      webhook: this.configured,
      webhookFailures: this.webhookFailures,
      lastWebhookError: this.lastWebhookError,
      active: this.activeAlerts(),
      recent: this.log.slice(-50),
    };
  }

  /** Wait for queued webhook posts (tests, shutdown). */
  flush(): Promise<void> {
    return this.queue;
  }

  private emit(rec: AlertRecord): void {
    this.log.push(rec);
    if (this.log.length > 500) this.log.shift();
    const line = `[alert] ${rec.state === "resolved" ? "RESOLVED" : rec.severity.toUpperCase()} ${rec.key}: ${rec.message}`;
    if (rec.severity === "critical" && rec.state === "firing") console.error(line);
    else console.log(line);
    if (!this.url) return;
    const url = this.url;
    const text = `${rec.state === "resolved" ? "✅" : ICON[rec.severity]} **Paraclr keeper · ${this.label}** · ${rec.state === "resolved" ? "resolved" : rec.severity} · \`${rec.key}\`\n${rec.message}`;
    this.queue = this.queue.then(async () => {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: text.slice(0, 1_900), text, alert: { ...rec, source: this.label } }, (_k, v) =>
            typeof v === "bigint" ? v.toString() : v,
          ),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`webhook answered HTTP ${res.status}`);
      } catch (err) {
        this.webhookFailures++;
        const msg = (err as Error)?.message ?? String(err);
        if (msg !== this.lastWebhookError) console.error(`[alert] webhook delivery failed: ${msg}`);
        this.lastWebhookError = msg;
      }
    });
  }
}

function rank(s: Severity): number {
  return s === "critical" ? 2 : s === "warning" ? 1 : 0;
}
