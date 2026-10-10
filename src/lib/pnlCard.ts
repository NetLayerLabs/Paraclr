// The PnL card shown when a position closes: its data, the query string the image route
// (/api/pnl-card) and the share page (/pnl) read, and the meme line for the outcome.
// Shared by the app (client), the image route and the share page (server).

export type CardNetwork = "testnet" | "mainnet" | "local" | "demo";

export interface PnlCardData {
  /** "SOL/AUSD" etc. */
  symbol: string;
  side: "long" | "short";
  leverage: number;
  entry: number;
  exit: number;
  /** Realized PnL, AUSD. */
  pnl: number;
  /** PnL as a % of the margin. */
  pnlPct: number;
  network: CardNetwork;
  /** Close time, unix seconds (also seeds the meme line). */
  at: number;
  /**
   * Only when the position ended in a liquidation auction (taken): AUSD the trader kept vs the
   * fixed-penalty liquidation (src/lib/kept.ts; negative = the auction cost more). Never set for a
   * voluntary close - no liquidation penalty applies there.
   */
  kept?: number;
}

const SYMBOLS = ["MON/AUSD", "SOL/AUSD", "BTC/AUSD"];
const NETWORKS: CardNetwork[] = ["testnet", "mainnet", "local", "demo"];

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const num = (v: string | null, lo: number, hi: number): number | null => {
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? clamp(n, lo, hi) : null;
};
const round = (n: number, d: number) => Number(n.toFixed(d));

export function cardQuery(d: PnlCardData): string {
  return new URLSearchParams({
    m: d.symbol,
    s: d.side === "long" ? "l" : "s",
    x: String(round(d.leverage, 2)),
    e: String(round(d.entry, 6)),
    c: String(round(d.exit, 6)),
    p: String(round(d.pnl, 2)),
    r: String(round(d.pnlPct, 2)),
    n: d.network,
    t: String(Math.floor(d.at)),
    ...(d.kept !== undefined && Number.isFinite(d.kept) ? { k: String(round(d.kept, 2)) } : {}),
  }).toString();
}

/** Parses and bounds a card query (it comes from a URL anyone can edit). Null if it isn't a card. */
export function parseCard(q: URLSearchParams): PnlCardData | null {
  const symbol = q.get("m") ?? "";
  if (!SYMBOLS.includes(symbol)) return null;
  const leverage = num(q.get("x"), 0.01, 100);
  const entry = num(q.get("e"), 0, 1e12);
  const exit = num(q.get("c"), 0, 1e12);
  const pnl = num(q.get("p"), -1e9, 1e9);
  const pnlPct = num(q.get("r"), -100_000, 100_000);
  const at = num(q.get("t"), 0, 4e9);
  if (leverage === null || entry === null || exit === null || pnl === null || pnlPct === null || at === null) return null;
  const network = q.get("n") as CardNetwork;
  // Optional: a malformed kept value drops the strip, not the card.
  const kept = q.has("k") ? num(q.get("k"), -1e9, 1e9) : null;
  return {
    symbol,
    side: q.get("s") === "s" ? "short" : "long",
    leverage,
    entry,
    exit,
    pnl,
    pnlPct,
    network: NETWORKS.includes(network) ? network : "demo",
    at,
    ...(kept !== null ? { kept } : {}),
  };
}

export type Mood = "moon" | "win" | "flat" | "loss" | "rekt";

export function moodOf(pnlPct: number): Mood {
  if (pnlPct >= 50) return "moon";
  if (pnlPct >= 5) return "win";
  if (pnlPct > -5) return "flat";
  if (pnlPct > -50) return "loss";
  return "rekt";
}

export const MOOD_TITLE: Record<Mood, string> = {
  moon: "Absolute send",
  win: "Bag secured",
  flat: "Round trip",
  loss: "Tuition paid",
  rekt: "Character development",
};

const LINES: Record<Mood, string[]> = {
  moon: [
    "Up only. Even the block clock blushed.",
    "Printed faster than a Monad block. Screenshot it before it’s gone.",
    "Main character energy. The lane pool sends its regards.",
    "Called it. Closed it. Framed it.",
    "That’s not a trade, that’s a highlight reel.",
  ],
  win: [
    "Green is a personality. Today it’s mine.",
    "In, out, paid. Clean as a lane-local write.",
    "Small W, still a W. Stacking them.",
    "Bought the dip, sold the rip, kept the receipt.",
    "Risk managed. Bag secured. Touching grass.",
  ],
  flat: [
    "Breakeven: the most expensive way to do nothing.",
    "Zen trade. The market and I agreed to disagree.",
    "Flat like a stablecoin. Very AUSD of me.",
    "Net zero. The fees say hi.",
    "Round trip complete. Took the scenic route.",
  ],
  loss: [
    "Paid tuition to the market. Class dismissed.",
    "Red today, research tomorrow.",
    "The chart zigged. I zagged. Respectfully.",
    "A loss with a plan is still a plan working.",
    "Down bad, still in the game.",
  ],
  rekt: [
    "That wasn’t a dip. That was a cliff dive.",
    "Leverage giveth. Leverage taketh.",
    "Wrote a poem for my margin. It was short.",
    "Rekt, but the liquidation was priced fairly. Growth.",
    "Into the auction we go. At least the block clock was honest.",
  ],
};

/** The meme line: same card, same line (seeded by the close time, market and PnL). */
export function narration(d: PnlCardData): string {
  const lines = LINES[moodOf(d.pnlPct)];
  let h = Math.floor(d.at) ^ Math.round(d.pnl * 100);
  for (const ch of d.symbol) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return lines[Math.abs(h) % lines.length]!;
}

export const NETWORK_TAG: Record<CardNetwork, string> = {
  testnet: "Monad testnet · test funds",
  mainnet: "Monad mainnet",
  local: "Local chain · test funds",
  demo: "Demo · simulated",
};

export function fmtPrice(n: number): string {
  const d = n >= 1000 ? 1 : n >= 1 ? 3 : 5;
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function fmtSignedAusd(n: number): string {
  const s = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (n >= 0 ? "+" : "−") + s;
}

/** The card's auction strip, e.g. "Kept +12.40 AUSD vs a fixed 1% liquidation". */
export function keptStrip(kept: number, penaltyPct: string): string {
  const v = Math.abs(kept).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return kept > -0.005
    ? `Kept +${v} AUSD vs a fixed ${penaltyPct} liquidation`
    : `Cost ${v} AUSD more than a fixed ${penaltyPct} liquidation`;
}

export function fmtSignedPct(n: number): string {
  return (n >= 0 ? "+" : "−") + Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 1, minimumFractionDigits: 1 }) + "%";
}

/**
 * Which orders just moved to "filled" with their fill details known, given the phase last seen per
 * order key. Updates `last` in place. An order seen as filled before its details are known keeps
 * its previous phase, so it is reported once they arrive; an order first seen already filled (one
 * restored from storage) is never reported.
 */
export function newlyFilled<T extends { key: string; phase: string; fillPrice: number | null; realizedPnl: number | null }>(
  last: Map<string, string>,
  orders: readonly T[],
): T[] {
  const out: T[] = [];
  for (const o of orders) {
    const prev = last.get(o.key);
    const detailed = o.fillPrice !== null && o.realizedPnl !== null;
    const justFilled = o.phase === "filled" && prev !== undefined && prev !== "filled";
    if (justFilled && !detailed) continue;
    last.set(o.key, o.phase);
    if (justFilled) out.push(o);
  }
  return out;
}
