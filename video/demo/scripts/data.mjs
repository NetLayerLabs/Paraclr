// Pulls every number the film shows from the repo's committed evidence into src/data.json.
//   node scripts/data.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const APP = join(ROOT, "../..");
const rd = (p) => JSON.parse(readFileSync(join(APP, p), "utf8"));
const AUSD = (s) => Number(BigInt(s)) / 1e6;

const BENCH = "bench/results/10143-2026-10-10T22-40-07Z.json";
const XRAY = "bench/xray/10143-run-mv2ze6l6-xzyi6.json";
const DEPLOY = "deployments/10143.json";
const b = rd(BENCH), x = rd(XRAY), dep = rd(DEPLOY);

const a = b.auctions;
const equity = AUSD(a.traderEquityAtStart);
const returned = AUSD(a.traderResidualReturned);
const taken = Math.round((equity - returned) * 100) / 100;
const fixed = Math.round(AUSD(a.legacyCounterfactual.traderLoss) * 100) / 100;

const design = (d) => {
  const ln = (t) => (t.lane == null ? 99 : t.lane); // the one lane-less tx (seedAccounts, the demo top-up) goes last
  const txs = [...d.txs].sort((p, q) => (ln(p) - ln(q)) || (p.block - q.block) || (p.index - q.index));
  const idx = new Map(txs.map((t, i) => [t.hash, i]));
  const edges = d.edges.map((e) => {
    const i = idx.get(e.from), j = idx.get(e.to);
    return [i, j, txs[i].lane !== txs[j].lane ? 1 : 0];
  });
  return { design: d.design, contract: d.contract, lanes: txs.map((t) => t.lane), edges, summary: d.summary };
};

const out = {
  open: {
    // External source (not in the repo): CoinGlass's own post on 2025-10-11 for the 24 h to then.
    source: "CoinGlass, 24h liquidation data",
    usdBillions: 19.13, traders: 1618240,
  },
  params: {
    file: DEPLOY,
    stepBps: dep.params.auctionStepBps, poolMinBps: dep.params.backstopMinDiscountBps, capBps: dep.params.auctionMaxDiscountBps,
    fixedFeeBps: dep.params.liquidationFeeBps, execFeeMon: Number(BigInt(dep.params.executionFeeWei)) / 1e18,
    maxDepositAusd: dep.params.maxDepositPerAccountAusd, minExecDelaySeconds: dep.params.minExecDelaySeconds,
    owner: dep.owner, timelock: dep.timelock, timelockDelaySeconds: dep.params.timelockMinDelaySeconds,
  },
  kept: {
    file: BENCH, network: b.network, measuredOn: b.bench.measuredOn, startedAt: b.bench.startedAt,
    blockMs: b.bench.observedBlockIntervalMs, shockBps: b.shock.bps,
    liquidated: b.totals.liquidated, accounts: b.bench.accountsSeeded,
    equityAtStart: equity, returned, taken, fixed,
    pctLess: Math.round((1 - taken / fixed) * 1000) / 10,
    avgDiscountBps: a.avgDiscountBps,
  },
  xray: {
    file: XRAY, runId: x.runId, method: x.method, network: x.network, edgeScope: x.edgeScope,
    lanes: design(x.designs.find((d) => d.design === "paraclr-lanes")),
    naive: design(x.designs.find((d) => d.design === "naive-shared")),
  },
};
writeFileSync(join(ROOT, "src/data.json"), JSON.stringify(out, null, 1));
console.log(JSON.stringify({ ...out, xray: { ...out.xray, lanes: out.xray.lanes.summary, naive: out.xray.naive.summary } }, null, 1));
