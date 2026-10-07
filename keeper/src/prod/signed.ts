// Keeper-signed prices for the TESTNET trial-end fallback oracle (contracts/src/testnet/
// KeeperSignedPyth.sol; docs/RUNBOOK.md "Testnet: trial-end fallback").
//
// After the Pyth API trial ends the keeper can no longer fetch signed Pyth updates from Hermes.
// The owner (Safe behind the timelock) then points the clearinghouse at KeeperSignedPyth with a
// timelocked `setPyth`, and this module takes Hermes' place behind the same interface the loops
// and the /hermes proxy use (`latest`, `firstAtOrAfter`, `status`):
//
//   source   where the numbers come from (SIGNED_PRICE_SOURCE):
//              pyth-mainnet (default)  the price Pyth STORES on Monad MAINNET (read-only eth_call
//                                      getPriceUnsafe on SIGNED_SOURCE_RPC; third parties push SOL /
//                                      BTC / MON there every ~15–30 s). Real Pyth numbers, relayed.
//              sim                     a geometric random walk (SIGNED_SIM_VOL, annualised) from
//                                      SIGNED_SIM_START_<BASE> or the first mainnet read.
//   signer   PRICE_SIGNER_PRIVATE_KEY (an allowed signer of the oracle; holds no MON, sends no tx).
//            Every SIGNED_TICK_MS (1 s) it appends one message per feed, publishTime = chain time,
//            prevPublishTime = the feed's previous message, so "the first message at/after t" is
//            unique — exactly Pyth's parsePriceFeedUpdatesUnique rule. A request is answered with ONE
//            blob abi.encode("PKS1", Msg[], signature) over the requested feeds, signed (EIP-191)
//            over keccak256(abi.encode(DOMAIN_TAG, chainId, oracle, msgs)).
//   restart  a state file (SIGNER_STATE_FILE) records a horizon 10 s past the last signed message;
//            after a restart the first message's prevPublishTime is max(horizon, the oracle's stored
//            publishTime), so a message signed before the restart can never compete with a new one
//            as "the first at/after t" (orders whose execAfter fell into the gap expire; users cancel).
//   stale    if the source is older than SIGNED_SOURCE_MAX_AGE_S (300 s) nothing new is signed:
//            the contract's staleness checks and the keeper's oracle:stale alerts take over.
//
// This is a TESTNET demo oracle: honest only as long as the signer key is. Never on mainnet.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPublicClient,
  encodeAbiParameters,
  http,
  keccak256,
  toHex,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { envStr, REPO_ROOT, rpcHost } from "../env";
import { pythAbi } from "./abi";
import { envNum, KNOWN, MAINNET_RPC_URL, normaliseKey, type Client } from "./config";
import type { PriceUpdate } from "./hermes";
import type { PriceMessage } from "./pyth-wire";

export const KSP_MAGIC = "0x504b5331" as const; // "PKS1"
export const KSP_DOMAIN_TAG = keccak256(toHex("Paraclr.KeeperSignedPyth.v1"));

const MSG_COMPONENTS = [
  { name: "id", type: "bytes32" },
  { name: "price", type: "int64" },
  { name: "conf", type: "uint64" },
  { name: "expo", type: "int32" },
  { name: "publishTime", type: "uint64" },
  { name: "prevPublishTime", type: "uint64" },
] as const;

export interface KspMsg {
  id: Hex;
  price: bigint;
  conf: bigint;
  expo: number;
  publishTime: bigint;
  prevPublishTime: bigint;
}

/** keccak256(abi.encode(DOMAIN_TAG, chainId, oracle, msgs)) — KeeperSignedPyth.digest(msgs). */
export function kspDigest(chainId: number, oracle: Address, msgs: KspMsg[]): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "tuple[]", components: MSG_COMPONENTS }],
      [KSP_DOMAIN_TAG, BigInt(chainId), oracle, msgs],
    ),
  );
}

export function encodeKspUpdate(msgs: KspMsg[], signature: Hex): Hex {
  return encodeAbiParameters([{ type: "bytes4" }, { type: "tuple[]", components: MSG_COMPONENTS }, { type: "bytes" }], [KSP_MAGIC, msgs, signature]);
}

/** Sign `msgs` for `oracle` on `chainId` and return the update blob. */
export async function signKspUpdate(signer: LocalAccount, chainId: number, oracle: Address, msgs: KspMsg[]): Promise<Hex> {
  if (!signer.signMessage) throw new Error("the price signer account cannot sign messages");
  const sig = await signer.signMessage({ message: { raw: kspDigest(chainId, oracle, msgs) } });
  return encodeKspUpdate(msgs, sig);
}

/** PRICE_SIGNER_PRIVATE_KEY, or null. */
export function loadPriceSigner(): LocalAccount | null {
  const v = envStr("PRICE_SIGNER_PRIVATE_KEY");
  return v ? privateKeyToAccount(normaliseKey("PRICE_SIGNER_PRIVATE_KEY", v)) : null;
}

interface SourcePrice {
  price: bigint;
  conf: bigint;
  expo: number;
  /** Publish time at the source (Pyth-stored time on mainnet; the sim's step time). */
  sourceTime: number;
}

export interface SignedSourceOptions {
  signer: LocalAccount;
  oracle: Address;
  chainId: number;
  /** The chain the oracle lives on (chain time + the oracle's stored publish times). */
  client: Client;
  feeds: Array<{ symbol: string; feed: Hex }>;
}

export class SignedPriceSource {
  readonly kind = "keeper-signed";
  readonly source: "pyth-mainnet" | "sim";
  private readonly tickMs = Math.max(250, envNum("SIGNED_TICK_MS", 1_000));
  private readonly pollMs = Math.max(500, envNum("SIGNED_SOURCE_POLL_MS", 2_000));
  private readonly maxSourceAgeS = envNum("SIGNED_SOURCE_MAX_AGE_S", 300);
  private readonly historyS = envNum("SIGNED_HISTORY_S", 900);
  private readonly sourceRpc = envStr("SIGNED_SOURCE_RPC") ?? MAINNET_RPC_URL;
  private readonly stateFile: string;
  private feeds: Array<{ symbol: string; feed: Hex }>;
  private readonly history = new Map<string, PriceMessage[]>();
  private readonly lastPrice = new Map<string, SourcePrice>();
  private readonly prev = new Map<string, number>();
  private chainOffsetS = 0;
  private timers: NodeJS.Timeout[] = [];
  private stateWrittenAt = 0;
  private stateWarned = false;
  private readonly sigCache = new Map<string, Hex>();
  private readonly src: Client;
  stats = { signed: 0, requests: 0, sourceErrors: 0, lastSourceError: null as string | null, lastSignedAt: 0, staleSkips: 0 };

  constructor(private readonly opts: SignedSourceOptions) {
    const s = (envStr("SIGNED_PRICE_SOURCE") ?? "pyth-mainnet").toLowerCase();
    if (s !== "pyth-mainnet" && s !== "sim") throw new Error(`SIGNED_PRICE_SOURCE must be pyth-mainnet or sim, got "${s}"`);
    this.source = s;
    this.feeds = opts.feeds.map((f) => ({ symbol: f.symbol, feed: f.feed.toLowerCase() as Hex }));
    this.stateFile =
      envStr("SIGNER_STATE_FILE") ?? join(REPO_ROOT, "keeper", `.signer-state-${opts.chainId}-${opts.oracle.slice(2, 10).toLowerCase()}.json`);
    this.src = createPublicClient({ transport: http(this.sourceRpc, { batch: true, retryCount: 2, timeout: 8_000 }) }) as unknown as Client;
  }

  get signer(): Address {
    return this.opts.signer.address;
  }

  get oracle(): Address {
    return this.opts.oracle;
  }

  /** Live feed set (a timelocked feed swap). */
  setFeeds(feeds: Array<{ symbol: string; feed: Hex }>): void {
    this.feeds = feeds.map((f) => ({ symbol: f.symbol, feed: f.feed.toLowerCase() as Hex }));
  }

  /** Initial chain-time offset, restart continuity, first source read; then the loops. */
  async start(): Promise<void> {
    await this.syncClock();
    const now = this.now();
    const saved = this.readState();
    for (const f of this.feeds) {
      const stored = await this.opts.client
        .readContract({ address: this.opts.oracle, abi: pythAbi, functionName: "getPriceUnsafe", args: [f.feed] })
        .then((p) => Number(p.publishTime), () => 0);
      const horizon = saved?.[f.feed] ?? now - 1; // no state file: assume a message may exist up to now − 1
      this.prev.set(f.feed, Math.max(horizon, stored));
    }
    await this.poll();
    this.tick();
    this.timers.push(setInterval(() => void this.poll(), this.pollMs));
    this.timers.push(setInterval(() => this.tick(), this.tickMs));
    this.timers.push(setInterval(() => void this.syncClock(), 2_000));
    for (const t of this.timers) t.unref?.();
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.writeState(true);
  }

  /** Chain time (s): the latest block's timestamp advanced by wall time since it was read. */
  now(): number {
    return Math.floor(Date.now() / 1000 + this.chainOffsetS);
  }

  private async syncClock(): Promise<void> {
    try {
      const b = await this.opts.client.getBlock({ blockTag: "latest" });
      this.chainOffsetS = Number(b.timestamp) - Date.now() / 1000;
    } catch {
      /* keep the previous offset */
    }
  }

  // ---------------------------------------------------------------- source

  private async poll(): Promise<void> {
    try {
      if (this.source === "pyth-mainnet") {
        const got = await Promise.all(
          this.feeds.map((f) => this.src.readContract({ address: KNOWN.pyth, abi: pythAbi, functionName: "getPriceUnsafe", args: [f.feed] })),
        );
        got.forEach((p, i) =>
          this.lastPrice.set(this.feeds[i].feed, { price: BigInt(p.price), conf: BigInt(p.conf), expo: Number(p.expo), sourceTime: Number(p.publishTime) }),
        );
      } else {
        await this.simStep();
      }
    } catch (err) {
      this.stats.sourceErrors++;
      this.stats.lastSourceError = ((err as Error)?.message ?? String(err)).split("\n")[0].slice(0, 200);
    }
  }

  private simAt = 0;
  private async simStep(): Promise<void> {
    const vol = envNum("SIGNED_SIM_VOL", 0.8);
    const nowS = Date.now() / 1000;
    for (const f of this.feeds) {
      let p = this.lastPrice.get(f.feed);
      if (!p) {
        const base = f.symbol.split("/")[0];
        const start = envStr(`SIGNED_SIM_START_${base}`);
        if (start) {
          const px = BigInt(Math.round(Number(start) * 1e8));
          p = { price: px, conf: px / BigInt(10_000), expo: -8, sourceTime: Math.floor(nowS) };
        } else {
          const q = await this.src.readContract({ address: KNOWN.pyth, abi: pythAbi, functionName: "getPriceUnsafe", args: [f.feed] });
          p = { price: BigInt(q.price), conf: BigInt(q.conf), expo: Number(q.expo), sourceTime: Math.floor(nowS) };
        }
      } else {
        const dt = Math.max(0, nowS - (this.simAt || nowS)) / (365 * 86_400);
        const z = gauss();
        const factor = Math.exp(vol * Math.sqrt(dt) * z - (vol * vol * dt) / 2);
        const px = BigInt(Math.max(1, Math.round(Number(p.price) * factor)));
        p = { price: px, conf: px / BigInt(10_000), expo: p.expo, sourceTime: Math.floor(nowS) };
      }
      this.lastPrice.set(f.feed, p);
    }
    this.simAt = nowS;
  }

  // ---------------------------------------------------------------- signing

  /** Append one message per feed at the current chain second (if the source is fresh). */
  private tick(): void {
    const t = this.now();
    for (const f of this.feeds) {
      const p = this.lastPrice.get(f.feed);
      if (!p) continue;
      // the source's own age, measured on the wall clock (the source chain is not this chain)
      if (Date.now() / 1000 - p.sourceTime > this.maxSourceAgeS) {
        this.stats.staleSkips++;
        continue;
      }
      const prev = this.prev.get(f.feed) ?? t - 1;
      if (t <= prev) continue;
      const m: PriceMessage = { id: f.feed, price: p.price, conf: p.conf, expo: p.expo, publishTime: t, prevPublishTime: prev, emaPrice: p.price, emaConf: p.conf };
      const h = this.history.get(f.feed) ?? [];
      h.push(m);
      while (h.length && h[0].publishTime < t - this.historyS) h.shift();
      this.history.set(f.feed, h);
      this.prev.set(f.feed, t);
      this.stats.signed++;
      this.stats.lastSignedAt = Date.now();
    }
    if (Date.now() - this.stateWrittenAt > 5_000) this.writeState(false);
  }

  private readState(): Record<string, number> | null {
    try {
      if (!existsSync(this.stateFile)) return null;
      const s = JSON.parse(readFileSync(this.stateFile, "utf8")) as { oracle?: string; chainId?: number; horizon?: Record<string, number> };
      if (s.chainId !== this.opts.chainId || s.oracle?.toLowerCase() !== this.opts.oracle.toLowerCase()) return null;
      return s.horizon ?? null;
    } catch {
      return null;
    }
  }

  /** Horizon = last signed publishTime + 10 s (+ the tick period), written before it can be reached. */
  private writeState(final: boolean): void {
    const horizon: Record<string, number> = {};
    for (const [feed, t] of this.prev) horizon[feed] = final ? t : t + 10 + Math.ceil(this.tickMs / 1000);
    try {
      writeFileSync(this.stateFile, JSON.stringify({ chainId: this.opts.chainId, oracle: this.opts.oracle, signer: this.signer, writtenAt: new Date().toISOString(), horizon }, null, 2), { mode: 0o600 });
      this.stateWrittenAt = Date.now();
    } catch (err) {
      if (!this.stateWarned) console.warn(`[signed] cannot write ${this.stateFile} (set SIGNER_STATE_FILE to a writable path): ${(err as Error).message}`);
      this.stateWarned = true;
      this.stateWrittenAt = Date.now();
    }
  }

  private async build(picked: PriceMessage[]): Promise<PriceUpdate> {
    const msgs: KspMsg[] = picked.map((m) => ({ id: m.id, price: m.price, conf: m.conf, expo: m.expo, publishTime: BigInt(m.publishTime), prevPublishTime: BigInt(m.prevPublishTime) }));
    const key = picked.map((m) => `${m.id}:${m.publishTime}`).join("|");
    let blob = this.sigCache.get(key);
    if (!blob) {
      blob = await signKspUpdate(this.opts.signer, this.opts.chainId, this.opts.oracle, msgs);
      this.sigCache.set(key, blob);
      if (this.sigCache.size > 2_000) this.sigCache.clear();
    }
    return { data: [blob], messages: new Map(picked.map((m) => [m.id, m])), parsedLocally: true, source: `keeper-signed (${this.source})`, fetchedAt: Date.now() };
  }

  private series(id: Hex): PriceMessage[] {
    const h = this.history.get(id.toLowerCase());
    if (!h) throw new Error(`keeper-signed source: feed ${id} is not signed by this keeper`);
    return h;
  }

  /** Newest message per feed (a Hermes `latest`). */
  async latest(ids: readonly Hex[]): Promise<PriceUpdate> {
    this.stats.requests++;
    const picked = ids.map((id) => {
      const h = this.series(id);
      const m = h[h.length - 1];
      if (!m) throw new Error(`keeper-signed source: no price for ${id} yet (source ${this.source}${this.stats.lastSourceError ? `: ${this.stats.lastSourceError}` : ""})`);
      return m;
    });
    return this.build(picked);
  }

  /** The first message at/after `publishTime` per feed (Hermes `/v2/updates/price/{t}`), or null. */
  async firstAtOrAfter(publishTime: number, ids: readonly Hex[]): Promise<PriceUpdate | null> {
    this.stats.requests++;
    const picked: PriceMessage[] = [];
    for (const id of ids) {
      const m = this.series(id).find((x) => x.publishTime >= publishTime);
      if (!m) return null;
      picked.push(m);
    }
    return this.build(picked);
  }

  status() {
    const now = this.now();
    const newest = Object.fromEntries(this.feeds.map((f) => [f.symbol, this.history.get(f.feed)?.at(-1)?.publishTime ?? null]));
    const healthy = this.feeds.every((f) => {
      const t = this.history.get(f.feed)?.at(-1)?.publishTime;
      return t !== undefined && now - t <= 10;
    });
    return {
      kind: this.kind,
      endpoints: [this.source === "pyth-mainnet" ? `pyth-mainnet via ${rpcHost(this.sourceRpc)}` : "sim"],
      apiKey: false,
      healthy,
      signer: this.signer,
      oracle: this.oracle,
      source: this.source,
      newestPublishTime: newest,
      sourceTime: Object.fromEntries(this.feeds.map((f) => [f.symbol, this.lastPrice.get(f.feed)?.sourceTime ?? null])),
      ...this.stats,
    };
  }
}

function gauss(): number {
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
