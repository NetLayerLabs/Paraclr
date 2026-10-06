# Paraclr

**The fair-liquidation clearinghouse for Monad.**

Every block, underwater accounts in each of Paraclr's 8 lanes go to a **per-block Dutch auction** backed by that
lane's **backstop LPs**, and traders get back the equity the auction doesn't use. The discount is set by the block
clock, not by gas bidding. For every crash we publish a measured **Conflict X-ray**, the storage-dependency graph of
the transactions that resolved it, side by side with a deliberately naive shared-state build of the same contract. A
**live solvency proof** checks the books every block.

Underneath, the clearinghouse shards its mutable risk state into 8 lanes (`uint160(account) % 8`), so the 8 lanes'
auction transactions write disjoint storage and can resolve in the same block. Lanes are the engine. The product is
fair, fast liquidation you can check.

Built for **Monad Metropolis** (Onchain Finance & Trading track). You trade on it in the browser with a passkey and
AUSD-denominated margin: a desktop trading terminal that collapses to a touch layout with swipe-to-trade on phones.

> Status: hackathon build, testnet only, unaudited. Every number in this repo and in the app is labelled
> **Monad testnet**, **local anvil (not Monad)** or **simulation**.

---

## The problem: liquidation is a race

On a typical on-chain perps venue an underwater account goes to whichever bot lands the liquidation first, for a
penalty fixed in advance. Bots compete on gas and ordering rather than on price, so the penalty never falls when a
taker would have accepted less, and nothing of that competition flows back to the trader. The trader can pay more
than a competitive price for the takeover.

## The auction

Contract defaults (owner-configurable): step **25 bps per block**, cap **500 bps**, backstop pool minimum discount
**75 bps**, maintenance margin **2.5%**.

1. **Start.** `startAuctions(lane, accounts)`: anyone can put an account below maintenance margin into auction. It is
   frozen (no withdraw, no new or closed positions); deposits still work.
2. **Tick.** `discountBps = min(500, 25 × (block.number − startBlock))`. Only the block number moves it.
3. **Take.** At discount `d` the taker inherits every position at the current mark and is paid
   `P = d × notional`. The trader's equity `E` (collateral + PnL at mark) pays `P`, and the trader keeps
   **`max(0, E − P)`** as free collateral. If `E < P` and the backstop pool takes, the lane's insurance fund pays
   the shortfall, then lane bad debt does. An external taker is paid only `min(P, max(E, 0))` from the trader's own
   equity, so the lane never subsidizes an outside taker (this closes self-liquidation; see
   `test_SelfLiquidationAttack_NetsNothingFromLane`). A trader never loses more than `E`. Takers:
   - the **lane backstop pool**, `backstopTakeBatch(lane, accounts)`, once `d ≥ minDiscountBps` (75 by default,
     block +3, about 1.2 s at 400 ms blocks; below the old 1% fixed fee) and the pool can carry the positions;
   - an **external taker**, `take(account)`, from an account in the same lane that stays above initial margin.
4. **Cure.** `cancelAuction(account)` once the account is healthy again (top-up or price recovery).
5. **Expire.** Untaken at the 500 bps cap (for example, an empty pool): `expireBatch(lane, accounts)` closes it at mark
   through the old fixed-fee path (1% of notional); any shortfall hits lane insurance, then lane bad debt.

**MEV-resistant pricing, not MEV-free.** Paying more gas can't buy a bigger discount; it can only land a take earlier,
at a smaller one. Ordering still matters when two takers want the same account in the same block, so we don't claim
there is no MEV, and we don't claim there are no gas wars.

## Backstop LPs

Each lane has its own backstop pool, in lane-local storage. LPs deposit AUSD into a lane's pool for shares at NAV.
The pool takes that lane's auctions at its threshold, earns the discount payment and inherits the positions.

- `NAV = cash + unrealized PnL of the inherited positions at mark`.
- `backstopReduce(lane, market, size)` (operator/keeper role) closes inherited exposure at mark.
- Withdrawals are blocked if they would leave the pool under margin for its exposure.
- Returns are shown as **earned since deploy** (discount earned, notional absorbed, PnL), never as an APY.
- On testnet the operator seeds every pool with test AUSD.

## Conflict X-ray

After a crash run the keeper traces every transaction of the resolution phase (`debug_traceTransaction` with
`prestateTracer`, with and without `diffMode`), then runs the **identical crash on `NaiveClearinghouseDemo`**: the same
contract code with a constructor flag that maps every per-lane aggregate (insurance, bad debt, open interest, backstop
pool, solvency ledger, auction counters) to one shared storage key. Identical logic; only storage keying differs.

- **Edge `i → j`**: `j` read or wrote a storage slot that `i`, earlier in the same block, wrote. That is the condition
  under which Monad's optimistic parallel execution re-executes `j`.
- **It does not show** Monad's internal re-execution count, which isn't observable from outside the node, or speed.
- **Method is always labelled**: a live trace, or (if the RPC has no debug API) a replay on a local anvil fork at the
  parent block, `method: "anvil-fork-replay"`.
- **Exclusions are listed in every report**: each sender's own nonce and gas balance, the coinbase fee credit,
  transient storage, and transactions outside the design's resolution phase.

Reports are written to `bench/xray/<chainId>-<runId>.json` and served by the keeper at `GET /runs/:id/xray`. The landing
page renders the newest committed X-ray at build time, preferring a Monad testnet one (`10143-*.json`).

## Solvency proof

Each lane keeps its own ledger in lane-local storage. `solvency()` sums them:

```
AUSD.balanceOf(clearinghouse) == Σ lanes ( collateral + insurance + backstop cash + keeper rewards owed − bad debt )

function solvency() view returns (uint256 ausdHeld, uint256 liabilities, int256 surplus, bool solvent)
// surplus = ausdHeld − liabilities (0 unless someone sends AUSD in directly); solvent = surplus ≥ 0
```

`laneLedger(lane)` returns one lane's terms. The app's header reads `solvency()` every block. The identity is covered
by Foundry invariant tests (`contracts/test/invariant/`) and asserted after the crash-scenario unit tests.

---

## Lanes: the engine

Monad executes the transactions in a block **optimistically in parallel**, then commits the results in the original
order. If a transaction read state that an earlier transaction in the same block wrote, Monad re-executes it with the
correct inputs; the result is always identical to sequential execution. The parallelism pays off only when
transactions **don't depend on each other's writes**.

- A contract **can't** pick which of Monad's execution threads runs a transaction. Lanes are a **storage layout**, not
  threads.
- Everything resolving an underwater account writes exists once per lane: insurance, bad debt, open interest per
  market, the backstop pool, auction state and the solvency ledger. Global numbers are views that sum the lanes.
- Nothing is shared on the hot path: keeper rewards sit in a per-keeper slot, the reentrancy lock is EIP-1153
  transient storage, and resolving auctions moves AUSD between internal balances only, never through ERC-20 transfers.
  The oracle and config are only read.
- Each lane's sweeper key sends that lane's `startAuctions` / `backstopTakeBatch` / `expireBatch`, so the 8 lanes'
  transactions have disjoint write sets. Transactions within one lane still depend on each other, by design.
- `test_ParallelSafety_LaneBatchesTouchDisjointStorage` records storage accesses with `vm.record` and asserts that a
  lane-3 and a lane-5 batch have no write/write or read/write overlap. The Conflict X-ray is the same check, measured
  on a whole crash.
- Every batch reads the oracle price; shared reads are fine. A price *write* in the same block would make the lanes
  depend on it, so the keeper pauses its price loop for the whole crash run (`priceLoopPaused: true` in every
  RunReport).

---

## Architecture

```
  Web app (Next.js, src/)                      keeper/ (Node; the only holder of operator keys)
  +--------------------------------+           +----------------------------------------------+
  | passkey -> Privy embedded      |  HTTP     | price loop: simulated GBM -> MockOracle ~1s  |
  |   wallet (or labelled burner)  |---------->| /faucet: test gas + 10,000 test AUSD         |
  | trade: deposit / openPosition  | /faucet   | sweeper: every block, one key per lane:      |
  | clearing: auctions per lane,   | /crash    |   startAuctions, backstopTakeBatch,          |
  |   Conflict X-ray, Simulated    | /runs/:id |   cancelAuction, expireBatch                 |
  | backstop tab, solvency badge   | /xray     | /crash: 1 oracle shock tx, then the sweeper; |
  +---------------+----------------+ /solvency |   X-ray vs the naive build                   |
                  | viem           | /backstop | bench CLI -> bench/results + bench/xray      |
                  v                            +----------------------+-----------------------+
  +--------------------------------------------------------------------v------------------------+
  |  Monad testnet (10143)        or        local anvil (31337, dev/CI only, not Monad)         |
  |                                                                                             |
  |  MockOracle --getPrice--> ParaclrClearinghouseDemo <--deposit-- MockAUSD (6 dp)             |
  |                           NaiveClearinghouseDemo (same code, shared keys: X-ray baseline)   |
  |  +--------+--------+--------+--------+--------+--------+--------+--------+                  |
  |  | lane 0 | lane 1 | lane 2 | lane 3 | lane 4 | lane 5 | lane 6 | lane 7 |                  |
  |  +--------+--------+--------+--------+--------+--------+--------+--------+                  |
  |   each lane: insurance, bad debt, OI per market, backstop pool, auctions, ledger, accounts  |
  +---------------------------------------------------------------------------------------------+
```

## What's on-chain and what's simulated

| Piece | `sim` mode (default) | `anvil` / `monad` modes |
|---|---|---|
| Positions, collateral, margin | In-browser store | **On-chain** in `ParaclrClearinghouseDemo` |
| Liquidations | In-browser model, labelled "Simulated" | **Real** auctions: `startAuctions`, `backstopTakeBatch`, `take`, `cancelAuction`, `expireBatch`, sent by the keeper's 8 lane keys or by anyone. Timings are **measured** by the keeper |
| Backstop pools, solvency ledgers | Not modelled | **On-chain**, lane-local; read live by the app |
| Conflict X-ray | Not available | **Measured** from traces of real txs, labelled with its method |
| Flash crash | Client-side price drop | One `MockOracle` tx (`8000` bps = −20%) sent by the operator key |
| ~500 accounts | Generated in the browser | Seeded with `seedAccounts` (demo-only, owner-funded). These are **synthetic accounts**, not 500 users or 500 funded wallets |
| Prices | In-browser GBM simulator | The **simulated** GBM feed is pushed on-chain to `MockOracle` by the keeper. The oracle is the on-chain source of truth, but it is **not a real market feed** |
| AUSD | Simulated balance | `MockAUSD`, a 6-decimal testnet stand-in. **Not Agora's AUSD** |
| Login / wallet | Privy passkey if `NEXT_PUBLIC_PRIVY_APP_ID` is set, otherwise a simulated passkey | Privy passkey with an embedded wallet, or a demo burner key held in localStorage (labelled) |
| Chainlink Data Streams | Not used | `ChainlinkStreamsOracle` adapter is written and unit-tested against a **mock** verifier. Not deployed, not used in the demo |
| Scoped session keys | Not implemented | Not implemented |

---

## Quickstart

Requirements: Node 20.9+ (Next.js 16), and [Foundry](https://book.getfoundry.sh/) (`forge`, `anvil`) for the chain
modes.

### 1. Simulation only (no chain)

```bash
npm install
npm run dev            # landing page at http://localhost:3000, app at /app (NEXT_PUBLIC_CHAIN_MODE unset = sim)
```

### 2. Local chain (anvil): full on-chain flow, zero config

```bash
npm install
npm run dev:chain                              # anvil :8545 + deploy + keeper :8787
NEXT_PUBLIC_CHAIN_MODE=anvil npm run dev       # second terminal: the app against anvil
npm run bench -- --accounts 500                # optional: seed + crash + X-ray
                                               # -> bench/results/31337-<ts>.json, bench/xray/31337-<runId>.json
```

On anvil every role uses anvil's public dev mnemonic. Details in [`keeper/README.md`](keeper/README.md) and
[`contracts/README.md`](contracts/README.md). Numbers from this mode are **local anvil, not Monad**.

### 3. Monad testnet (chain id 10143)

The full runbook (key generation, funding, deploy, keeper, bench) is in [`keeper/README.md`](keeper/README.md):

```bash
npm run keeper:init                            # keeper/.env with fresh keys (never commit it)
npm run keeper:fund -- --send                  # top up every role from the operator
npm run deploy:monad                           # writes deployments/10143.json (commit it)
npm run keeper                                 # price loop, faucet, sweeper, crash API
NEXT_PUBLIC_CHAIN_MODE=monad npm run dev       # app against Monad testnet
npm run bench -- --accounts 500 --yes          # writes bench/results/10143-*.json + bench/xray/10143-*.json
```

Monad charges for the gas **limit**, so the keeper keeps limits tight.

---

## Results

<!--
Fill ONLY from committed bench/results/*.json and bench/xray/*.json. Never type a number that isn't in a file.
  jq '{network, chainId, accounts: .totals.accountsScanned, auctions, underwater: (.underwater | del(.perAccount)),
       blocks: .totals.blocks, wallClockMs: .totals.wallClockMs, gas: .totals.totalGasUsed}' bench/results/<file>.json
  jq '.designs[] | {design, summary}' bench/xray/<file>.json
-->

Each row is one `npm run bench` run. The raw `RunReport` JSON, with every tx hash and timing, is committed in
[`bench/results/`](bench/results/); X-ray reports are in [`bench/xray/`](bench/xray/). The landing page renders the
same files at build time.

### Auction runs (RunReport v2)

| Network | Accounts | Went to auction | Backstop / external / cured / expired | Avg discount | Time underwater p50 / max | Equity returned to traders | Old fixed-fee path, counterfactual | Evidence |
|---|---|---|---|---|---|---|---|---|
| **Monad testnet** (10143) | `[TBD]` | `[TBD]` | `[TBD]` | `[TBD] bps` | `[TBD] / [TBD] blocks` | `[TBD] AUSD` | `[TBD] AUSD` | `bench/results/10143-[TBD].json` |
| local anvil (31337), **not Monad** | `[TBD]` | `[TBD]` | `[TBD]` | `[TBD] bps` | `[TBD] / [TBD] blocks` | `[TBD] AUSD` | `[TBD] AUSD` | `bench/results/31337-[TBD].json` |

### Conflict X-ray

| Network · method | Design | Txs | Dependency edges | Across lanes | Longest chain | Evidence |
|---|---|---|---|---|---|---|
| `[TBD]` | Paraclr lanes | `[TBD]` | `[TBD]` | `[TBD]` | `[TBD]` | `bench/xray/[TBD].json` |
| `[TBD]` | Naive shared state | `[TBD]` | `[TBD]` | `[TBD]` | `[TBD]` | same file |

### Pre-auction runs (fixed-fee `liquidateBatch`, Oct 4)

These ran the old path (close at mark, 1% fee) before the auction existed. Kept as evidence that the lane batches
landed together; they say nothing about auctions or about Monad.

| Network | Accounts scanned | Liquidated | Lane batch txs | Block(s) | All in one block? | Wall-clock (ms) | Total gas used | Evidence |
|---|---|---|---|---|---|---|---|---|
| local anvil (31337), **not Monad** | 2,000 | 404 | 8 | #69 | yes | 336 | 27,274,852 | `bench/results/31337-2026-10-04T15-15-06Z.json` |
| local anvil (31337), **not Monad** | 500 | 91 | 8 | #45 | yes | 339 | 6,697,402 | `bench/results/31337-2026-10-04T15-14-32Z.json` |
| local anvil (31337), **not Monad** | 500 | 90 | 8 | #28 | yes | 983 | 6,648,662 | `bench/results/31337-2026-10-04T15-13-54Z.json` |

How to read it:

- **Time underwater** runs from the shock block to the block the account was resolved (taken, cured or expired), per
  account; the ms figure is on the keeper's clock and includes RPC round trips.
- **Old fixed-fee path, counterfactual** is computed by the keeper on the same accounts at auction start: what the
  previous close-at-mark, 1%-fee path would have taken from the same traders. Compare it with what the auction
  actually paid takers; we don't pre-judge which is smaller.
- **Wall-clock** (pre-auction runs) runs from the first lane batch submitted to the last batch receipt on the keeper's
  clock. It includes RPC round trips and block inclusion, so it is **not** EVM execution time.
- anvil executes sequentially. anvil rows check the contracts and the keeper end to end and say nothing about Monad's
  parallel execution.

---

## Deployed contracts (Monad testnet, chain id 10143)

<!-- Copy from deployments/10143.json after the testnet deploy. -->

| Contract | Address | Explorer |
|---|---|---|
| `ParaclrClearinghouseDemo` | `[TBD]` | `https://testnet.monadexplorer.com/address/[TBD]` |
| `NaiveClearinghouseDemo` (X-ray baseline only) | `[TBD]` | `https://testnet.monadexplorer.com/address/[TBD]` |
| `MockOracle` | `[TBD]` | `https://testnet.monadexplorer.com/address/[TBD]` |
| `MockAUSD` (testnet AUSD stand-in) | `[TBD]` | `https://testnet.monadexplorer.com/address/[TBD]` |
| Deploy block | `[TBD]` | |

`ParaclrClearinghouseDemo` extends `ParaclrClearinghouse` with one demo-only function, `seedAccounts` (owner only),
which creates synthetic accounts with collateral and open positions, funded from the owner's AUSD so the solvency
identity still holds. Auctions run the unchanged production code. `NaiveClearinghouseDemo` exists only so the X-ray
has a fair baseline; nothing in the app trades on it.

---

## Repo map

```
contracts/          Foundry: ParaclrClearinghouse(+Demo), NaiveClearinghouseDemo, MockOracle, ChainlinkStreamsOracle,
                    MockAUSD; unit, auction and invariant tests; deploy script
keeper/             Node keeper: price loop, faucet, per-lane sweeper, crash runner, Conflict X-ray, bench CLI
bench/results/      RunReport JSON from bench runs, committed as evidence
bench/xray/         XrayReport JSON (lanes vs naive), committed as evidence
deployments/        <chainId>.json: deployed addresses + market ids, read by the app
scripts/            dev-chain, deploy, export-abi (npm run abi -> src/lib/chain/abi/*.ts, generated)
src/app/            Next.js 16 App Router: landing page (/) and the app (/app)
src/components/     landing/, auth/, trade/, clearing/ (auctions, X-ray), backstop/, solvency/, shell/
src/lib/            chain clients and ABIs, in-browser simulation, price sources
docs/               FAIR_LIQUIDATION_PLAN.md, ONCHAIN_PLAN.md (build contracts), SUBMISSION.md, x/ (social drafts)
```

## Known limitations

- Testnet only and unaudited. AUSD is a stand-in token, prices are simulated and pushed on-chain, and crash-run
  accounts are synthetic.
- MEV-resistant pricing, not MEV-free: takers can still compete on ordering within a block.
- Backstop exposure is reduced by an operator/keeper role (`backstopReduce`), not by a market. LPs carry the price
  risk of inherited positions until then.
- Each lane's insurance fund is the counterparty for that lane's positions. One position per market per account. No
  funding payments, no trading fees.
- Imbalanced lanes (one busy lane) cap the parallelism of a run. 8 lanes is a design choice, not a Monad limit.
- The Conflict X-ray shows dependencies, not Monad's re-execution counts.
- See [`contracts/README.md`](contracts/README.md) for contract-level limitations.

## Affiliation

We are entering the Monad Metropolis hackathon. Sponsor tools are used through their public SDKs (Privy). We have no
partnership with or endorsement from Monad, Agora, Privy, Chainlink or any other sponsor.
