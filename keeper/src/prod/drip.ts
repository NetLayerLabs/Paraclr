// Visitor gas drip (Monad TESTNET only): `POST /drip {address}` sends a fresh wallet a little
// testnet MON once, so a judge who signs in with a new passkey wallet can pay gas and the order
// execution fee without leaving the app. Never on mainnet (hard-disabled for a realValue profile).
//
//   DRIP_PRIVATE_KEY       the drip wallet's key (its OWN key, not a keeper/ops/guardian/signer key).
//                          Unset → the drip is disabled and /health says so.
//   DRIP_AMOUNT_MON        0.3   sent once per address, ever
//   DRIP_MIN_BALANCE_MON   0.05  only to addresses holding less than this
//   DRIP_DAILY_MON         10    global budget per UTC day (queued + sent)
//   DRIP_PER_IP            3     drips per client IP per rolling 24 h
//   DRIP_STATE_FILE        keeper/.drip-state-<chain>[-fork].json (dripped addresses; gitignored)
//   KEEPER_TRUST_PROXY     0     number of reverse proxies in front of the keeper: with N ≥ 1 the
//                                client IP is the N-th X-Forwarded-For entry from the right
//                                (what the last proxy appended); 0 = the socket address.
//
// Monad reserve balance (reserve.ts): a key below 10 MON may send a VALUE transfer only as its
// first tx in 3 blocks. Drips therefore go through one serial queue: send, wait for the receipt,
// then ≥ 3 blocks (ctx.reserve spaces the next value tx) before the next one.
//
// The policy is a pure function (decideDrip) with unit tests next to it (drip.test.ts).

import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { formatEther, getAddress, isAddress, parseEther, type Address, type Hex, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { envStr, REPO_ROOT } from "../env";
import { waitForReceipt } from "../sender";
import { envNum, normaliseKey, rel } from "./config";
import { short, type ProdContext } from "./context";

// ---------------------------------------------------------------------------
// Policy (pure)
// ---------------------------------------------------------------------------

export type DripStatus = "queued" | "sending" | "sent" | "failed";

export interface DripRecord {
  /** Lowercase address. */
  address: string;
  /** Short hash of the client IP (never the IP itself). */
  ip: string;
  /** ms epoch of the request. */
  at: number;
  /** Wei, as a decimal string (JSON). */
  amountWei: string;
  status: DripStatus;
  txHash?: Hex;
  block?: number;
  error?: string;
}

export interface DripLedger {
  byAddress: Record<string, DripRecord>;
}

export interface DripPolicy {
  amountWei: bigint;
  minBalanceWei: bigint;
  dailyBudgetWei: bigint;
  perIpMax: number;
  ipWindowMs: number;
}

/** On-chain facts for one request (absent = ledger-only precheck, before any RPC call). */
export interface DripChainFacts {
  recipientBalance: bigint;
  recipientHasCode: boolean;
  walletBalance: bigint;
  /** Worst-case gas cost of one drip transfer (21,000 × maxFeePerGas). */
  gasCostWei: bigint;
}

export interface DripRequest {
  address: string;
  ip: string;
  now: number;
  chain?: DripChainFacts;
}

export type DripCode =
  | "disabled"
  | "bad_address"
  | "already_dripped"
  | "in_progress"
  | "contract"
  | "has_balance"
  | "ip_limit"
  | "budget_exhausted"
  | "drip_empty";

export type DripDecision = { ok: true } | { ok: false; code: DripCode; status: number; error: string };

const DAY_MS = 86_400_000;
const live = (r: DripRecord) => r.status !== "failed";

export function utcDay(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

/** Wei reserved or spent today (UTC): queued, sending and sent drips requested today. */
export function spentToday(ledger: DripLedger, now: number): bigint {
  const d = utcDay(now);
  let s = BigInt(0);
  for (const r of Object.values(ledger.byAddress)) if (live(r) && utcDay(r.at) === d) s += BigInt(r.amountWei);
  return s;
}

/** Wei not yet sent (queued or sending): already promised out of the drip wallet's balance. */
export function pendingWei(ledger: DripLedger): { wei: bigint; count: number } {
  let wei = BigInt(0);
  let count = 0;
  for (const r of Object.values(ledger.byAddress)) {
    if (r.status === "queued" || r.status === "sending") {
      wei += BigInt(r.amountWei);
      count++;
    }
  }
  return { wei, count };
}

export function ipCount(ledger: DripLedger, ip: string, now: number, windowMs: number): number {
  return Object.values(ledger.byAddress).filter((r) => live(r) && r.ip === ip && now - r.at < windowMs).length;
}

const fmt = (wei: bigint) => Number(formatEther(wei)).toLocaleString("en-US", { maximumFractionDigits: 4 });

/**
 * Decide one drip request. `gate` is the deployment-level switch (key present, not mainnet).
 * Without `req.chain` only the ledger checks run (cheap rejection before any RPC call).
 */
export function decideDrip(gate: { enabled: boolean; reason?: string }, ledger: DripLedger, req: DripRequest, policy: DripPolicy): DripDecision {
  const no = (code: DripCode, status: number, error: string): DripDecision => ({ ok: false, code, status, error });
  if (!gate.enabled) return no("disabled", 403, `The gas drip is off: ${gate.reason ?? "not configured"}.`);
  if (!isAddress(req.address)) return no("bad_address", 400, "body must be { address: 0x… }");
  const prev = ledger.byAddress[req.address.toLowerCase()];
  if (prev?.status === "sent") return no("already_dripped", 409, "This address already received its test MON from the drip (once per address).");
  if (prev?.status === "queued" || prev?.status === "sending") return no("in_progress", 409, "A drip to this address is already on its way.");
  if (ipCount(ledger, req.ip, req.now, policy.ipWindowMs) >= policy.perIpMax) {
    return no("ip_limit", 429, `Drip limit reached for your network (${policy.perIpMax} per 24 h). Use faucet.monad.xyz.`);
  }
  if (spentToday(ledger, req.now) + policy.amountWei > policy.dailyBudgetWei) {
    return no("budget_exhausted", 429, `Today's drip budget (${fmt(policy.dailyBudgetWei)} MON) is used up. Use faucet.monad.xyz or try tomorrow (UTC).`);
  }
  const c = req.chain;
  if (!c) return { ok: true };
  if (c.recipientHasCode) return no("contract", 400, "That address is a contract: the drip only funds wallets (EOAs).");
  if (c.recipientBalance >= policy.minBalanceWei) {
    return no("has_balance", 409, `This wallet already holds ${fmt(c.recipientBalance)} MON (the drip is for wallets under ${fmt(policy.minBalanceWei)} MON).`);
  }
  const pend = pendingWei(ledger);
  const need = pend.wei + policy.amountWei + c.gasCostWei * BigInt(pend.count + 1);
  if (c.walletBalance < need) return no("drip_empty", 503, "The drip wallet is out of test MON right now. Use faucet.monad.xyz.");
  return { ok: true };
}

/** The client IP for rate limiting: socket address, or the N-th X-Forwarded-For entry from the right. */
export function clientIp(req: Pick<IncomingMessage, "headers" | "socket">, trustProxyHops: number): string {
  const sock = req.socket?.remoteAddress ?? "?";
  if (trustProxyHops <= 0) return sock;
  const raw = req.headers["x-forwarded-for"];
  const list = (Array.isArray(raw) ? raw.join(",") : (raw ?? "")).split(",").map((s) => s.trim()).filter(Boolean);
  return list[list.length - trustProxyHops] ?? list[0] ?? sock;
}

export function hashIp(ip: string): string {
  return createHash("sha256").update(`paraclr-drip:${ip}`).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Service (queue, persistence, chain)
// ---------------------------------------------------------------------------

export class DripError extends Error {
  constructor(
    readonly code: DripCode | "rate_limited",
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface DripChainPort {
  getBalance(address: Address): Promise<bigint>;
  hasCode(address: Address): Promise<boolean>;
  gasCostWei(): Promise<bigint>;
  /** Send `value` to `to` (serialized by the caller); resolves once mined. */
  transfer(to: Address, value: bigint): Promise<{ hash: Hex; mined: Promise<{ ok: boolean; block: number | null }> }>;
}

export function policyFromEnv(): DripPolicy {
  const mon = (name: string, fallback: number) => parseEther(String(envNum(name, fallback)));
  return {
    amountWei: mon("DRIP_AMOUNT_MON", 0.3),
    minBalanceWei: mon("DRIP_MIN_BALANCE_MON", 0.05),
    dailyBudgetWei: mon("DRIP_DAILY_MON", 10),
    perIpMax: Math.max(0, Math.floor(envNum("DRIP_PER_IP", 3))),
    ipWindowMs: DAY_MS,
  };
}

export function loadDripKey(): LocalAccount | null {
  const v = envStr("DRIP_PRIVATE_KEY");
  return v ? privateKeyToAccount(normaliseKey("DRIP_PRIVATE_KEY", v)) : null;
}

const MAX_RECORDS = 50_000;

export class GasDrip {
  readonly policy: DripPolicy;
  readonly gate: { enabled: boolean; reason?: string };
  private ledger: DripLedger = { byAddress: {} };
  private queue: string[] = [];
  private running = false;
  private waiters = new Map<string, Array<() => void>>();
  private buckets = new Map<string, { tokens: number; at: number }>();
  walletBalance: bigint | null = null;
  private balanceAt = 0;
  stats = { sent: 0, failed: 0, refused: 0 };

  constructor(
    private readonly opts: {
      account: LocalAccount | null;
      /** Hard refusal (mainnet), even with a key. */
      refuse?: string;
      port: DripChainPort | null;
      stateFile: string | null;
      explorer: string;
      trustProxyHops: number;
      policy?: DripPolicy;
      log?: (msg: string) => void;
    },
  ) {
    this.policy = opts.policy ?? policyFromEnv();
    this.gate = opts.refuse
      ? { enabled: false, reason: opts.refuse }
      : !opts.account || !opts.port
        ? { enabled: false, reason: "no DRIP_PRIVATE_KEY on this keeper" }
        : this.policy.amountWei <= BigInt(0)
          ? { enabled: false, reason: "DRIP_AMOUNT_MON is 0" }
          : { enabled: true };
    this.load();
    // Anything left queued/sending by a previous process is unknown: forget it (the address can ask again;
    // a transfer that did land shows up as has_balance).
    for (const r of Object.values(this.ledger.byAddress)) {
      if (r.status === "queued" || (r.status === "sending" && !r.txHash)) {
        r.status = "failed";
        r.error = "keeper restarted before sending";
      } else if (r.status === "sending" && r.txHash) {
        r.status = "sent"; // broadcast before the restart: count it (once per address)
      }
    }
  }

  get address(): Address | null {
    return this.opts.account?.address ?? null;
  }

  private log(msg: string): void {
    (this.opts.log ?? console.log)(`[drip] ${msg}`);
  }

  private load(): void {
    const f = this.opts.stateFile;
    if (!f || !existsSync(f)) return;
    try {
      const raw = JSON.parse(readFileSync(f, "utf8")) as Partial<DripLedger>;
      if (raw && typeof raw.byAddress === "object" && raw.byAddress) this.ledger = { byAddress: raw.byAddress };
    } catch (err) {
      this.log(`WARNING could not read ${rel(f)} (${short(err)}): starting with an empty drip ledger`);
    }
  }

  private save(): void {
    const f = this.opts.stateFile;
    if (!f) return;
    const entries = Object.entries(this.ledger.byAddress);
    if (entries.length > MAX_RECORDS) {
      // keep the newest; old addresses keep their on-chain balance as the main guard
      this.ledger.byAddress = Object.fromEntries(entries.sort((a, b) => b[1].at - a[1].at).slice(0, MAX_RECORDS));
    }
    try {
      writeFileSync(`${f}.tmp`, JSON.stringify(this.ledger) + "\n", { mode: 0o600 });
      renameSync(`${f}.tmp`, f);
    } catch (err) {
      this.log(`WARNING could not write ${rel(f)}: ${short(err)}`);
    }
  }

  /** Cheap per-IP request limiter (any /drip request: each costs a few RPC calls). */
  private limit(ip: string, now: number): void {
    const b = this.buckets.get(ip) ?? { tokens: 10, at: now };
    b.tokens = Math.min(10, b.tokens + ((now - b.at) / 60_000) * 10); // 10 / min, burst 10
    b.at = now;
    if (b.tokens < 1) throw new DripError("rate_limited", 429, "Too many requests - try again in a minute.");
    b.tokens -= 1;
    this.buckets.set(ip, b);
    if (this.buckets.size > 10_000) this.buckets.clear();
  }

  private refuse(d: Exclude<DripDecision, { ok: true }>): never {
    this.stats.refused++;
    throw new DripError(d.code, d.status, d.error);
  }

  /** POST /drip. Waits up to `waitMs` for the transfer to be broadcast, then reports its status. */
  async request(input: unknown, ipRaw: string, opts: { waitMs?: number; now?: number } = {}) {
    const now = opts.now ?? Date.now();
    if (!this.gate.enabled) {
      const off = decideDrip(this.gate, this.ledger, { address: "", ip: "", now }, this.policy);
      if (!off.ok) this.refuse(off);
    }
    const ip = hashIp(ipRaw);
    this.limit(ip, now);
    const address = typeof input === "string" ? input.trim() : "";
    const req: DripRequest = { address, ip, now };
    const pre = decideDrip(this.gate, this.ledger, req, this.policy);
    if (!pre.ok) {
      if (pre.code === "in_progress") return this.status(address); // idempotent while on its way
      this.refuse(pre);
    }
    const to = getAddress(address);
    const port = this.opts.port!;
    const [recipientBalance, recipientHasCode, walletBalance, gasCostWei] = await Promise.all([
      port.getBalance(to),
      port.hasCode(to),
      port.getBalance(this.address!),
      port.gasCostWei(),
    ]);
    this.walletBalance = walletBalance;
    this.balanceAt = Date.now();
    // re-decide on the ledger as it is NOW (another request may have queued meanwhile)
    const d = decideDrip(this.gate, this.ledger, { ...req, chain: { recipientBalance, recipientHasCode, walletBalance, gasCostWei } }, this.policy);
    if (!d.ok) {
      if (d.code === "in_progress") return this.status(address);
      this.refuse(d);
    }
    const key = to.toLowerCase();
    this.ledger.byAddress[key] = { address: key, ip, at: now, amountWei: this.policy.amountWei.toString(), status: "queued" };
    this.queue.push(key);
    this.save();
    const sent = new Promise<void>((resolve) => {
      const list = this.waiters.get(key) ?? [];
      list.push(resolve);
      this.waiters.set(key, list);
    });
    void this.run();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([sent, new Promise((r) => (timer = setTimeout(r, opts.waitMs ?? 8_000)))]);
    clearTimeout(timer);
    return this.status(to);
  }

  /** GET /drip/:address */
  status(addressRaw: string) {
    if (!isAddress(addressRaw)) throw new DripError("bad_address", 400, "not an address");
    const key = addressRaw.toLowerCase();
    const r = this.ledger.byAddress[key];
    const pos = this.queue.indexOf(key);
    return {
      address: getAddress(addressRaw),
      status: (r?.status ?? "none") as DripStatus | "none",
      amount: r ? formatEther(BigInt(r.amountWei)) : formatEther(this.policy.amountWei),
      txHash: r?.txHash ?? null,
      explorer: r?.txHash ? `${this.opts.explorer}/tx/${r.txHash}` : null,
      block: r?.block ?? null,
      position: pos >= 0 ? pos + 1 : null,
      error: r?.status === "failed" ? (r.error ?? "failed") : null,
    };
  }

  private wake(key: string): void {
    for (const w of this.waiters.get(key) ?? []) w();
    this.waiters.delete(key);
  }

  /** The serial queue: one transfer at a time (the transfer port spaces value txs ≥ 3 blocks). */
  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const key = this.queue[0];
        const r = this.ledger.byAddress[key];
        if (!r || r.status !== "queued") {
          this.queue.shift();
          this.wake(key);
          continue;
        }
        r.status = "sending";
        let mined: Promise<{ ok: boolean; block: number | null }> | null = null;
        try {
          const sub = await this.opts.port!.transfer(getAddress(key), BigInt(r.amountWei));
          r.txHash = sub.hash;
          mined = sub.mined;
          this.save();
          this.log(`${key.slice(0, 8)}…${key.slice(-4)} ← ${formatEther(BigInt(r.amountWei))} MON · tx ${sub.hash}`);
        } catch (err) {
          r.status = "failed";
          r.error = short(err);
          this.stats.failed++;
          this.log(`${key.slice(0, 8)}…${key.slice(-4)} send FAILED: ${r.error}`);
        }
        this.queue.shift();
        this.wake(key);
        if (mined) {
          const m = await mined.catch(() => ({ ok: false, block: null }));
          r.block = m.block ?? undefined;
          if (m.ok) {
            r.status = "sent";
            this.stats.sent++;
          } else {
            r.status = "failed";
            r.error = m.block === null ? "transfer not mined in time" : "transfer reverted";
            this.stats.failed++;
            this.log(`${key.slice(0, 8)}…${key.slice(-4)} tx ${r.txHash} ${r.error}`);
          }
        }
        this.save();
        if (this.address) {
          this.walletBalance = await this.opts.port!.getBalance(this.address).catch(() => this.walletBalance);
          this.balanceAt = Date.now();
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Refresh the drip wallet's balance for /health (called from a head subscription). */
  async refreshBalance(maxAgeMs = 15_000): Promise<void> {
    if (!this.gate.enabled || !this.address || Date.now() - this.balanceAt < maxAgeMs) return;
    this.balanceAt = Date.now();
    this.walletBalance = await this.opts.port!.getBalance(this.address).catch(() => this.walletBalance);
  }

  clientIp(req: Pick<IncomingMessage, "headers" | "socket">): string {
    return clientIp(req, this.opts.trustProxyHops);
  }

  healthJson() {
    const p = this.policy;
    const pend = pendingWei(this.ledger);
    return {
      enabled: this.gate.enabled,
      reason: this.gate.enabled ? null : (this.gate.reason ?? null),
      address: this.address,
      amount: formatEther(p.amountWei),
      minBalance: formatEther(p.minBalanceWei),
      walletBalance: this.walletBalance === null ? null : formatEther(this.walletBalance),
      todaySpent: formatEther(spentToday(this.ledger, Date.now())),
      dailyBudget: formatEther(p.dailyBudgetWei),
      perIp: p.perIpMax,
      queued: pend.count,
      ...this.stats,
    };
  }
}

/** Wire the drip to the production context (testnet only; mainnet is refused). */
export function createGasDrip(ctx: ProdContext): GasDrip {
  const p = ctx.chain.profile;
  const account = loadDripKey();
  if (account) {
    const hot = [ctx.roles.deployer, ctx.roles.guardian, ctx.roles.ops, ...ctx.roles.keepers, ctx.sources.signed ? { address: ctx.sources.signed.signer } : null]
      .filter(Boolean)
      .map((a) => String(a!.address).toLowerCase());
    if (hot.includes(account.address.toLowerCase())) throw new Error("DRIP_PRIVATE_KEY must be its own key (not a keeper / ops / guardian / price-signer key)");
  }
  const refuse = p.realValue ? `refused on ${p.label} (the drip exists for testnet only)` : undefined;
  if (refuse && account) console.warn(`[drip] DRIP_PRIVATE_KEY is set but the drip is ${refuse}; ignoring it.`);
  const c = ctx.chain.client;
  const port: DripChainPort | null =
    account && !refuse
      ? {
          getBalance: (address) => c.getBalance({ address }),
          hasCode: (address) => c.getCode({ address }).then((x) => Boolean(x && x !== "0x")),
          gasCostWei: async () => BigInt(21_000) * (await ctx.senders.fees.get()).maxFeePerGas,
          transfer: async (to, value) => {
            const sender = ctx.senders.for(account);
            const gas = BigInt(21_000);
            const maxCost = gas * (await ctx.senders.fees.get()).maxFeePerGas;
            let mined!: Promise<{ ok: boolean; block: number | null }>;
            // ctx.reserve: below 10 MON, a value tx waits until ≥ 3 blocks after this key's previous tx.
            const sub = await ctx.reserve.send(account.address, value, maxCost, async () => {
              const s = await sender.send({ to, value, gas });
              const r = waitForReceipt(c, s.hash, { pollMs: ctx.config.receiptPollMs, timeoutMs: ctx.config.receiptTimeoutMs });
              mined = r.then(
                (o) => ({ ok: o.receipt.status === "success", block: Number(o.receipt.blockNumber) }),
                () => {
                  sender.resync();
                  return { ok: false, block: null };
                },
              );
              return { ...s, block: mined.then((m) => (m.block === null ? null : BigInt(m.block))) };
            });
            return { hash: sub.hash, mined };
          },
        }
      : null;
  const stateFile =
    envStr("DRIP_STATE_FILE") ?? join(REPO_ROOT, "keeper", `.drip-state-${ctx.chain.chainId}${ctx.chain.fork ? "-fork" : ""}.json`);
  const hops = Math.max(0, Math.floor(envNum("KEEPER_TRUST_PROXY", 0)));
  const drip = new GasDrip({ account, refuse, port, stateFile: account && !refuse ? stateFile : null, explorer: p.explorer, trustProxyHops: hops });
  if (drip.gate.enabled) {
    const pol = drip.policy;
    console.log(
      `[drip] ON · wallet ${drip.address} · ${formatEther(pol.amountWei)} MON once per address under ${formatEther(pol.minBalanceWei)} MON · ` +
        `${pol.perIpMax}/IP/24 h · ${formatEther(pol.dailyBudgetWei)} MON/day · state ${rel(stateFile)} · client IP ${hops ? `X-Forwarded-For (${hops} proxy hop${hops > 1 ? "s" : ""})` : "socket address"}`,
    );
  } else {
    console.log(`[drip] off: ${drip.gate.reason}`);
  }
  return drip;
}
