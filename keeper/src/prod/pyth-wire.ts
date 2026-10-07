// Pyth "accumulator update" (PNAU) wire-format parser.
//
// Hermes returns update data as opaque hex blobs; the Pyth contract verifies the Wormhole VAA
// and the Merkle proofs on chain. The keeper parses the blob locally only to READ the price
// messages it carries (feed id, price, conf, expo, publishTime, prevPublishTime) so it can
// check BEFORE sending a tx that the update is the one the contract will accept
// (e.g. `prevPublishTime < minPublishTime <= publishTime` for parsePriceFeedUpdatesUnique)
// and that its confidence is inside the contract's bound. Nothing here is trusted for
// security: the contract re-verifies everything.
//
// Layout (pyth-crosschain, AccumulatorUpdateData / WormholeMerkle):
//   "PNAU" | major u8 | minor u8 | trailingHeaderLen u8 | trailingHeader | updateType u8 (0)
//   vaaLen u16 | vaa | numUpdates u8 | numUpdates × (msgLen u16 | msg | numProofs u8 | numProofs × bytes20)
// Price feed message (type 0):
//   type u8 | id bytes32 | price i64 | conf u64 | expo i32 | publishTime i64 | prevPublishTime i64
//   | emaPrice i64 | emaConf u64

import type { Hex } from "viem";

export const PNAU_MAGIC = "504e4155";

export interface PriceMessage {
  /** 0x-prefixed lowercase 32-byte feed id. */
  id: Hex;
  price: bigint;
  conf: bigint;
  expo: number;
  publishTime: number;
  prevPublishTime: number;
  emaPrice: bigint;
  emaConf: bigint;
}

export interface ParsedUpdate {
  /** Wormhole guardian set index of the VAA (informational). */
  guardianSetIndex: number;
  /** Pythnet slot from the VAA payload (AUWV). */
  slot: bigint;
  messages: PriceMessage[];
}

class Reader {
  private o = 0;
  constructor(private readonly b: Uint8Array) {}
  get offset() {
    return this.o;
  }
  need(n: number) {
    if (this.o + n > this.b.length) throw new Error(`pyth update truncated at byte ${this.o} (+${n})`);
  }
  u8() {
    this.need(1);
    return this.b[this.o++];
  }
  u16() {
    this.need(2);
    const v = (this.b[this.o] << 8) | this.b[this.o + 1];
    this.o += 2;
    return v;
  }
  u32() {
    this.need(4);
    const v = ((this.b[this.o] << 24) >>> 0) + (this.b[this.o + 1] << 16) + (this.b[this.o + 2] << 8) + this.b[this.o + 3];
    this.o += 4;
    return v;
  }
  i32() {
    const v = this.u32();
    return v >= 0x80000000 ? v - 0x100000000 : v;
  }
  u64() {
    this.need(8);
    let v = BigInt(0);
    for (let i = 0; i < 8; i++) v = (v << BigInt(8)) | BigInt(this.b[this.o + i]);
    this.o += 8;
    return v;
  }
  i64() {
    const v = this.u64();
    return v >= BigInt("0x8000000000000000") ? v - BigInt("0x10000000000000000") : v;
  }
  bytes(n: number) {
    this.need(n);
    const v = this.b.subarray(this.o, this.o + n);
    this.o += n;
    return v;
  }
  skip(n: number) {
    this.need(n);
    this.o += n;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || /[^0-9a-fA-F]/.test(h)) throw new Error("pyth update is not hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(b: Uint8Array): Hex {
  return `0x${Buffer.from(b).toString("hex")}` as Hex;
}

/** Parse one accumulator update blob (hex). Throws on anything that is not a PNAU v1 WormholeMerkle update. */
export function parseAccumulatorUpdate(data: Hex | string): ParsedUpdate {
  const r = new Reader(hexToBytes(data));
  const magic = Buffer.from(r.bytes(4)).toString("hex");
  if (magic !== PNAU_MAGIC) throw new Error(`not a Pyth accumulator update (magic ${magic})`);
  const major = r.u8();
  r.u8(); // minor
  if (major !== 1) throw new Error(`unsupported PNAU major version ${major}`);
  r.skip(r.u8()); // trailing header
  const updateType = r.u8();
  if (updateType !== 0) throw new Error(`unsupported PNAU update type ${updateType}`);

  const vaaLen = r.u16();
  const vaa = new Reader(r.bytes(vaaLen));
  vaa.u8(); // VAA version
  const guardianSetIndex = vaa.u32();
  const sigs = vaa.u8();
  vaa.skip(sigs * 66);
  vaa.skip(4 + 4 + 2 + 32 + 8 + 1); // timestamp, nonce, emitter chain, emitter address, sequence, consistency
  let slot = BigInt(0);
  try {
    const payloadMagic = Buffer.from(vaa.bytes(4)).toString("hex");
    if (payloadMagic === "41555756") {
      vaa.u8(); // AUWV update type
      slot = vaa.u64();
    }
  } catch {
    /* slot is informational */
  }

  const n = r.u8();
  const messages: PriceMessage[] = [];
  for (let i = 0; i < n; i++) {
    const len = r.u16();
    const msg = new Reader(r.bytes(len));
    const type = msg.u8();
    r.skip(r.u8() * 20); // merkle proof
    if (type !== 0) continue; // not a price feed message (e.g. TWAP)
    messages.push({
      id: toHex(msg.bytes(32)).toLowerCase() as Hex,
      price: msg.i64(),
      conf: msg.u64(),
      expo: msg.i32(),
      publishTime: Number(msg.i64()),
      prevPublishTime: Number(msg.i64()),
      emaPrice: msg.i64(),
      emaConf: msg.u64(),
    });
  }
  return { guardianSetIndex, slot, messages };
}

/** Every price message in a list of update blobs, keyed by lowercase feed id (last one wins). */
export function messagesById(updates: readonly (Hex | string)[]): Map<string, PriceMessage> {
  const out = new Map<string, PriceMessage>();
  for (const u of updates) for (const m of parseAccumulatorUpdate(u).messages) out.set(m.id, m);
  return out;
}

/** price × 10^expo normalised to 18 decimals (what the contract computes on chain). */
export function toWad(price: bigint, expo: number): bigint {
  const shift = 18 + expo;
  if (shift >= 0) return price * BigInt(10) ** BigInt(shift);
  return price / BigInt(10) ** BigInt(-shift);
}

/** conf / price in bps (rounded up), the contract's `maxConfBps` comparison. */
export function confBps(m: Pick<PriceMessage, "price" | "conf">): number {
  if (m.price <= BigInt(0)) return Number.POSITIVE_INFINITY;
  return Number((m.conf * BigInt(10_000) + m.price - BigInt(1)) / m.price);
}

/** Human float for logs / health (never used for on-chain math). */
export function toFloat(price: bigint, expo: number): number {
  return Number(price) * 10 ** expo;
}

/**
 * Re-encode an accumulator update with only the messages for `ids` (same header, same VAA, each
 * kept message with its own Merkle proof) — exactly what Hermes serves when asked for a subset of
 * feeds. Used by the rehearsal's Hermes replay to turn a harvested 52-feed update into the
 * 1–3-feed update a keeper would have fetched. The result is still verified by the real Pyth
 * contract (the proofs are per message against the signed root).
 */
export function subsetUpdate(data: Hex | string, ids: readonly string[]): Hex {
  const bytes = hexToBytes(data);
  const r = new Reader(bytes);
  r.skip(4 + 1 + 1);
  r.skip(r.u8());
  r.u8();
  const vaaLen = r.u16();
  r.skip(vaaLen);
  const headEnd = r.offset; // through the VAA
  const want = new Set(ids.map((i) => i.toLowerCase()));
  const kept: Uint8Array[] = [];
  const n = r.u8();
  for (let i = 0; i < n; i++) {
    const start = r.offset;
    const len = r.u16();
    const msg = r.bytes(len);
    r.skip(r.u8() * 20);
    const id = msg[0] === 0 && msg.length >= 33 ? toHex(msg.subarray(1, 33)).toLowerCase() : "";
    if (want.has(id)) kept.push(bytes.subarray(start, r.offset));
  }
  if (kept.length === 0) throw new Error("subsetUpdate: none of the requested feeds is in the update");
  const out = new Uint8Array(headEnd + 1 + kept.reduce((s, k) => s + k.length, 0));
  out.set(bytes.subarray(0, headEnd), 0);
  out[headEnd] = kept.length;
  let o = headEnd + 1;
  for (const k of kept) {
    out.set(k, o);
    o += k.length;
  }
  return toHex(out);
}

/** Find every embedded PNAU blob in arbitrary ABI-encoded calldata (bytes are length-prefixed). */
export function extractUpdatesFromCalldata(input: Hex): Hex[] {
  const h = input.slice(2).toLowerCase();
  const out: Hex[] = [];
  let from = 0;
  for (;;) {
    const at = h.indexOf(PNAU_MAGIC, from);
    if (at < 0) break;
    from = at + 8;
    // ABI `bytes` = 32-byte length word immediately before the data; data starts word-aligned
    // relative to the args (offset 8 = after the 4-byte selector), so check alignment.
    if ((at - 8) % 64 !== 0 || at < 72) continue;
    const len = Number.parseInt(h.slice(at - 64, at), 16);
    if (!Number.isFinite(len) || len <= 0 || at + len * 2 > h.length) continue;
    const blob = `0x${h.slice(at, at + len * 2)}` as Hex;
    try {
      parseAccumulatorUpdate(blob);
      out.push(blob);
      from = at + len * 2;
    } catch {
      /* not a full update at this offset */
    }
  }
  return out;
}
