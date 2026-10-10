// Arena book + admin-route tests: `npm run test:keeper` (node --test through tsx). No chain needed.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Hex } from "viem";
import { generateArenaBook, isAdminRoute } from "./arena";
import type { MarketRef } from "./context";

const MARKETS: MarketRef[] = [
  { symbol: "MON/AUSD", id: "0xdd355e1e200907f25579f161298943654a31cf972ae5a91444419ee8ab0a7995" as Hex },
  { symbol: "SOL/AUSD", id: "0x71404ecadb92f5a36fa398992a182993209814fdb029f79c89cc01dad48a01f6" as Hex },
  { symbol: "BTC/AUSD", id: "0x628531487c91f9cd06c8d62aab932566f40de1dc235b08c6ace72becc017e727" as Hex },
];
const MM_BPS = 250; // MAINTENANCE_MARGIN_BPS

/** Equity and maintenance margin after a uniform shock, in 6dp AUSD, for a one-position account. */
function afterShock(a: ReturnType<typeof generateArenaBook>[number], bps: number) {
  const p = a.positions[0];
  const n0 = p.margin * p.leverage; // entry notional
  const n1 = (n0 * BigInt(bps)) / BigInt(10_000);
  const pnl = p.isLong ? n1 - n0 : n0 - n1;
  return { equity: a.collateral + pnl, mm: (n1 * BigInt(MM_BPS)) / BigInt(10_000) };
}

describe("generateArenaBook", () => {
  for (const seed of [1, 42, 654906431, 2_000_000_000]) {
    it(`seed ${seed}: perLane accounts in every lane, liquidatable exactly when designed to be`, () => {
      const book = generateArenaBook(MARKETS, seed, 3, 8_000);
      assert.equal(book.length, 24);
      const lanes = Array(8).fill(0);
      for (const a of book) {
        assert.equal(Number(BigInt(a.account) % BigInt(8)), a.lane);
        lanes[a.lane]++;
        assert.equal(a.positions.length, 1);
        const p = a.positions[0];
        assert.ok(p.leverage >= BigInt(2) && p.leverage <= BigInt(20), "leverage within MAX_LEVERAGE");
        assert.ok(a.collateral >= p.margin, "initial margin check at open");
        const { equity, mm } = afterShock(a, 8_000);
        if (a.profile === "healthy") assert.ok(equity >= mm, `${a.account} should stay healthy`);
        else assert.ok(equity < mm, `${a.account} (${a.profile}) should be liquidatable`);
        if (a.profile === "underwater" || a.profile === "cure") assert.ok(equity > BigInt(0), "positive equity left");
      }
      assert.deepEqual(lanes, Array(8).fill(3));
      assert.equal(new Set(book.map((a) => a.account.toLowerCase())).size, 24);
      assert.equal(book.filter((a) => a.profile === "cure").length, 1);
    });
  }

  it("is deterministic per seed and differs across seeds", () => {
    const a = generateArenaBook(MARKETS, 7, 2, 8_000);
    const b = generateArenaBook(MARKETS, 7, 2, 8_000);
    const c = generateArenaBook(MARKETS, 8, 2, 8_000);
    assert.deepEqual(a, b);
    assert.notDeepEqual(a.map((x) => x.account), c.map((x) => x.account));
    assert.equal(generateArenaBook(MARKETS, 7, 2, 8_000, false).filter((x) => x.profile === "cure").length, 0);
  });

  it("most of the book goes underwater on a −20% shock", () => {
    let under = 0;
    let total = 0;
    for (let seed = 100; seed < 140; seed++) {
      for (const a of generateArenaBook(MARKETS, seed, 3, 8_000)) {
        total++;
        if (a.profile !== "healthy") under++;
      }
    }
    assert.ok(under / total > 0.65 && under / total < 0.9, `underwater share ${under / total}`);
  });
});

describe("isAdminRoute", () => {
  it("locks the on-demand chain writers only", () => {
    for (const p of ["/crash", "/recover", "/price-loop", "/demo-takers", "/faucet"]) assert.equal(isAdminRoute("POST", p), true);
    for (const p of ["/arena/crash", "/arena", "/runs"]) assert.equal(isAdminRoute("POST", p), false);
    for (const p of ["/demo-takers", "/sweeper", "/solvency", "/backstop", "/health"]) assert.equal(isAdminRoute("GET", p), false);
  });
});
