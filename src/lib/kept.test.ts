// Run: npx tsx src/lib/kept.test.ts
// Hand-computed cases for the "what you kept" helper, plus the published bench totals.

import assert from "node:assert/strict";
import { fmtPenaltyPct, keptVsFixed, keptVsFixedRaw } from "./kept";

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

// 1. Taken at 50 bps: notional 1,500, equity 30. Fixed 1% = 15. Taker paid 7.5, residual 22.5.
let r = keptVsFixed({ notional: 1500, equityAtStart: 30, traderResidual: 22.5 })!;
close(r.fixedPenalty, 15);
close(r.auctionCost, 7.5);
close(r.kept, 7.5);
assert.equal(r.basis, "residual");

// 2. Same account, projected from the discount instead of measured: same numbers.
r = keptVsFixed({ notional: 1500, equityAtStart: 30, discountBps: 50 })!;
close(r.auctionCost, 7.5);
close(r.kept, 7.5);
assert.equal(r.basis, "discount");

// 3. Equity below the penalty: both paths take everything, nothing kept, nothing lost.
r = keptVsFixed({ notional: 1000, equityAtStart: 5, traderResidual: 0 })!;
close(r.fixedPenalty, 5);
close(r.auctionCost, 5);
close(r.kept, 0);

// 4. The auction can cost more (prices moved against the account before the take): negative kept.
r = keptVsFixed({ notional: 1000, equityAtStart: 50, traderResidual: 30 })!;
close(r.fixedPenalty, 10);
close(r.auctionCost, 20);
close(r.kept, -10);

// 5. Projection is capped at equity, like the contract: min(notional × d, max(E, 0)).
r = keptVsFixed({ notional: 1000, equityAtStart: 3, discountBps: 500 })!;
close(r.auctionCost, 3);
close(r.fixedPenalty, 3);

// 6. Negative equity at start: nothing to take on either path.
r = keptVsFixed({ notional: 1000, equityAtStart: -4, traderResidual: 0 })!;
close(r.fixedPenalty, 0);
close(r.kept, 0);

// 7. Missing inputs never produce a number.
assert.equal(keptVsFixed({ notional: 1000, equityAtStart: 30 }), null);
assert.equal(keptVsFixed({ notional: NaN, equityAtStart: 30, traderResidual: 1 }), null);
assert.equal(keptVsFixed({ notional: 1000, equityAtStart: 30, traderResidual: Infinity }), null);

// 8. Integer units, as on chain (indexer test fixture: equity 3 AUSD, notional 150 AUSD → 1.5).
const raw = keptVsFixedRaw({ notional: BigInt(150_000_000), equityAtStart: BigInt(3_000_000), traderResidual: BigInt(2_250_000) })!;
assert.equal(raw.fixedPenalty, BigInt(1_500_000));
assert.equal(raw.auctionCost, BigInt(750_000));
assert.equal(raw.kept, BigInt(750_000));
// Floor division like the contract: 1% of 123.456789 AUSD = 1.234567 (not .568).
assert.equal(keptVsFixedRaw({ notional: BigInt(123_456_789), equityAtStart: BigInt(10_000_000), traderResidual: BigInt(10_000_000) })!.fixedPenalty, BigInt(1_234_567));

// 9. Bench totals (bench/results/31337-2026-10-06T22-54-58Z.json, the −5% run, all 7 taken):
//    legacy 4,526.407993 vs auctions 8,577.800009 − 5,640.098391 → kept 1,588.706375 AUSD.
//    The formula is linear, so the per-account sum must equal fixed − (equity − residual) of the totals.
const legacy = BigInt("4526407993");
const took = BigInt("8577800009") - BigInt("5640098391");
assert.equal(took, BigInt("2937701618"));
assert.equal(legacy - took, BigInt("1588706375"));

assert.equal(fmtPenaltyPct(), "1%");
assert.equal(fmtPenaltyPct(50), "0.5%");

console.log("kept.ts: all cases pass");
