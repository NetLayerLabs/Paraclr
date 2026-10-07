// One head poller shared by every production loop (executor, funding, sweeper, monitor).
//
// Polls `eth_getBlockByNumber("latest")` and hands each NEW head (number + timestamp) to the
// subscribers, one at a time per subscriber (a slow subscriber skips heads instead of queueing
// them). Chain time — not the keeper's wall clock — is the clock for every timing decision, so the
// same code is right on mainnet (chain time ≈ wall clock) and on a time-warped anvil fork.

import type { Client } from "./config";

export interface Head {
  number: number;
  /** Block timestamp (s). */
  timestamp: number;
  /** Keeper wall clock when first seen (ms). */
  seenAt: number;
}

type Subscriber = { name: string; fn: (h: Head) => Promise<void>; busy: boolean; minIntervalMs: number; lastRun: number };

export class HeadWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private readonly subs: Subscriber[] = [];
  head: Head | null = null;
  private errors = 0;
  lastError: string | null = null;

  constructor(
    private readonly client: Client,
    private readonly pollMs: number,
    private readonly onError: (where: string, err: unknown) => void,
  ) {}

  /** `minIntervalMs` throttles a subscriber (e.g. the monitor runs every few seconds, not every block). */
  subscribe(name: string, fn: (h: Head) => Promise<void>, minIntervalMs = 0): void {
    this.subs.push({ name, fn, busy: false, minIntervalMs, lastRun: 0 });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Resolves once no subscriber is running. */
  async idle(): Promise<void> {
    while (this.subs.some((s) => s.busy)) await new Promise((r) => setTimeout(r, 25));
  }

  status() {
    return {
      head: this.head,
      lagMs: this.head ? Date.now() - this.head.seenAt : null,
      errors: this.errors,
      lastError: this.lastError,
      subscribers: this.subs.map((s) => ({ name: s.name, busy: s.busy, lastRun: s.lastRun })),
    };
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const b = await this.client.getBlock({ blockTag: "latest" });
      const number = Number(b.number);
      if (this.head && number <= this.head.number) return;
      this.head = { number, timestamp: Number(b.timestamp), seenAt: Date.now() };
      this.lastError = null;
      const h = this.head;
      for (const s of this.subs) {
        if (s.busy || Date.now() - s.lastRun < s.minIntervalMs) continue;
        s.busy = true;
        s.lastRun = Date.now();
        s.fn(h)
          .catch((err: unknown) => this.onError(s.name, err))
          .finally(() => {
            s.busy = false;
          });
      }
    } catch (err) {
      this.errors++;
      this.lastError = (err as Error)?.message?.split("\n")[0] ?? String(err);
      this.onError("head", err);
    } finally {
      this.polling = false;
    }
  }
}
