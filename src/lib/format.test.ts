// Run: npx tsx src/lib/format.test.ts
import assert from "node:assert/strict";
import { fmtAusd, fmtBps, fmtBpsParam, fmtCountdown, fmtDuration, fmtMon, fmtMs, fmtNumber, fmtSigned, MINUS, timeAgo } from "./format";

// bps: a measured value keeps 2 decimals, a configured rate is trimmed.
assert.equal(fmtBps(45), "0.45%");
assert.equal(fmtBps(100), "1.00%");
assert.equal(fmtBps(null), "-");
assert.equal(fmtBpsParam(5), "0.05%");
assert.equal(fmtBpsParam(75), "0.75%");
assert.equal(fmtBpsParam(100), "1%");
assert.equal(fmtBpsParam(150), "1.5%");

// Negatives use U+2212; zero is unsigned; thousands are grouped.
assert.equal(fmtSigned(12.3), "+12.30");
assert.equal(fmtSigned(-4.05), `${MINUS}4.05`);
assert.equal(fmtSigned(-0.001), "0.00");
assert.equal(fmtAusd(1234.5), "1,234.50");
assert.equal(fmtAusd(-1234.5), `${MINUS}1,234.50`);
assert.equal(fmtNumber(-0.001, 2), "0.00");

// MON: up to 4 decimals trimmed; tiny amounts keep 2 significant digits.
assert.equal(fmtMon(0.3), "0.3");
assert.equal(fmtMon(0.123456), "0.1235");
assert.equal(fmtMon(1234.5), "1,234.5");
assert.equal(fmtMon(0), "0");
assert.equal(fmtMon(0.0000012), "0.0000012");

// Units: a space before the unit.
assert.equal(fmtCountdown(42), "42 s");
assert.equal(fmtCountdown(180), "3:00");
assert.equal(fmtDuration(45), "45 s");
assert.equal(fmtDuration(125), "2 min 05 s");
assert.equal(fmtDuration(4800), "1 h 20 min");
assert.equal(fmtMs(120), "120 ms");
assert.equal(fmtMs(1234), "1.23 s");
assert.equal(fmtMs(25_400), "25 s");
assert.equal(timeAgo(42_000), "42 s ago");
assert.equal(timeAgo(240_000), "4 min ago");

console.log("format.ts: all cases pass");
