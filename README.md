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

Built for **Monad Metropolis** (Onchain Finance & Trading track). You trade on it in the browser with a passkey (or
email, a social login or an external wallet, through Privy) and AUSD-denominated margin: a desktop trading terminal
that collapses to a touch layout with swipe-to-trade on phones, installable as a web app.

> **Status (2026-10-10).** The production contracts have run on **Monad testnet** since 2026-10-07 with Agora's
> testnet AUSD and Pyth prices: test funds, no real value (addresses
> [below](#deployed-contracts-monad-testnet-chain-id-10143)). Its auction step was lowered from the contract default
> of 25 to **5 bps per block** through the timelock on 2026-10-08; an Envio indexer feeds the app's order history.
> The measured crash runs in [Results](#results) come from the demo stack on local anvil; the Monad testnet
> Conflict X-rays from the demo stack deployed on testnet. A
> **capped, unaudited beta with real Agora AUSD on Monad mainnet** is built as a separate contract set and launches
> only if its [launch gate](#production-beta-monad-mainnet-gated) passes; until `deployments/143.json` with
> `"production": true` is committed, nothing of ours is on mainnet. Every number in this repo and in the app is
> labelled **Monad mainnet**, **Monad testnet**, **local anvil (not Monad)** or **simulation**.
>
> Mainnet beta label, used everywhere: **Unaudited beta · capped · use only what you can afford to lose.** Not
> audited: internal review and Slither only. Read the [risk disclosure](src/app/risk/page.tsx) (`/risk`) and the
> [draft terms](src/app/terms/page.tsx) (`/terms`); both are drafts that need legal review before launch.

---

## The problem: liquidation is a race

On a typical on-chain perps venue an underwater account goes to whichever bot lands the liquidation first, for a
penalty fixed in advance. Bots compete on gas and ordering rather than on price, so the penalty never falls when a
taker would have accepted less, and nothing of that competition flows back to the trader. The trader can pay more
than a competitive price for the takeover.

## The auction

Contract defaults (owner-configurable): step **25 bps per block**, cap **500 bps**, backstop pool minimum discount
**75 bps**, maintenance margin **2.5%**. The **live testnet deployment runs a 5 bps step** since 2026-10-08 (set
through the timelock; see [Deployed contracts](#deployed-contracts-monad-testnet-chain-id-10143)): the cap is
reached in 100 blocks (≈ 35 s at Monad's ~0.35 s blocks) and the pool minimum at block 15 (≈ 5 s), which gives a
keeper on a shared RPC time to take at a small discount. The anvil bench runs below used the default 25.

1. **Start.** `startAuctions(lane, accounts)`: anyone can put an account below maintenance margin into auction. It is
   frozen (no withdraw, no new or closed positions); deposits still work.
2. **Tick.** `discountBps = min(500, step × (block.number − startBlock))`, step 25 by default (5 on the live
   testnet). Only the block number moves it.
3. **Take.** At discount `d` the taker inherits every position at the current mark and is paid
   `P = d × notional`. The trader's equity `E` (collateral + PnL at mark) pays `P`, and the trader keeps
   **`max(0, E − P)`** as free collateral. If `E < P` and the backstop pool takes, the lane's insurance fund pays
   the shortfall, then lane bad debt does. An external taker is paid only `min(P, max(E, 0))` from the trader's own
   equity, so the lane never subsidizes an outside taker (this closes self-liquidation; see
   `test_SelfLiquidationAttack_NetsNothingFromLane`). A trader never loses more than `E`. Takers:
   - the **lane backstop pool**, `backstopTakeBatch(lane, accounts)`, once `d ≥ minDiscountBps` (75 by default:
     block +3 at the 25 bps step, block +15 ≈ 5 s at the live testnet's 5 bps; below the old 1% fixed fee) and the
     pool can carry the positions;
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

Two stacks share the app and the keeper code. The **production stack** is what runs on Monad testnet today
(`NEXT_PUBLIC_CHAIN_MODE=monad-testnet`): `ParaclrClearinghouseProd` behind a timelock and a Safe, Agora's AUSD as
collateral, **Pyth** prices pulled through the keeper's `/hermes` proxy (the API key never reaches browsers),
**delayed orders** (`commitOrder` / `executeOrder`, filled by the keeper at the first Pyth update after the delay),
funding and fees, caps, the same per-lane auctions and backstop pools, and an **Envio** indexer for order history and
activity. Sign-in is through Privy: passkey, email, Google / X / Discord / GitHub (where enabled in the Privy
dashboard) or an external wallet, each unlocking an embedded wallet. The **demo stack** below (anvil, or the demo
deployment on testnet) is the crash-run and X-ray evidence; its labelled burner wallet is offered only where Privy is
not configured, never on the live testnet with Privy set and never on mainnet (`src/lib/auth/session.ts`).

```
  Web app (Next.js, src/)                      keeper/ (Node; the only holder of operator keys)
  +--------------------------------+           +----------------------------------------------+
  | Privy sign-in -> embedded      |  HTTP     | price loop: simulated GBM -> MockOracle ~1s  |
  |   wallet (burner: demo only)   |---------->| /faucet: test gas + 10,000 test AUSD         |
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

## Indexer: Envio

[`indexer/`](indexer/README.md) is an [Envio HyperIndex](https://docs.envio.dev) indexer for the production
clearinghouse on Monad testnet. It reads the chain through Envio's **HyperSync** from the deploy block and records
every order (commit, fill, failure, cancel: fill price, realized PnL, fee, seconds to fill), every per-lane auction
and its outcome (taken by a backstop pool or externally, cured, expired; discount, payment, equity returned),
position changes, collateral and backstop flows, plus running totals per account, lane, market, day and protocol.

It runs on **Envio Cloud** (indexer `paraclr-testnet`, deployed from the `envio` branch). Its GraphQL API
(`NEXT_PUBLIC_ENVIO_GRAPHQL_URL`, currently `https://indexer.dev.hyperindex.xyz/b6db2a9/v1/graphql`) feeds the app's
**order history** (Trade tab, Positions | History) and **activity since deploy** with the latest auctions (Clearing
tab). Positions, balances and solvency are still read from the contract itself. Its totals were checked against the
chain: AUSD held = insurance + backstop + deposits, and the executed-order count matches the keeper.
`cd indexer && pnpm test` runs the handler tests on simulated events.

## What's on-chain and what's simulated (demo stack)

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
| Login / wallet | Privy sign-in if `NEXT_PUBLIC_PRIVY_APP_ID` is set, otherwise a simulated passkey | Privy sign-in (passkey, email, Google / X / Discord / GitHub where enabled, external wallet) with an embedded wallet. A labelled demo burner key in localStorage only where Privy is not configured; hidden on the live testnet once Privy is set, never on mainnet |
| Chainlink Data Streams | Not used | `ChainlinkStreamsOracle` adapter is written and unit-tested against a **mock** verifier. Not deployed, not used in the demo |
| Scoped session keys | Not implemented | Not implemented |

---

## Production beta: Monad mainnet (gated)

The demo stack above (`ParaclrClearinghouseDemo`, `NaiveClearinghouseDemo`, `MockOracle`, `MockAUSD`, the faucet, the
price pusher, the crash runner, the X-ray and the bench) **stays as it is**: it is the hackathon evidence. Production is
a **separate contract set** in `contracts/src/prod/`, specified in [`docs/PRODUCTION_PLAN.md`](docs/PRODUCTION_PLAN.md).

**Status (2026-10-10):** not on mainnet. The launch gate below has passed; the launch waits on Pyth price data for
mainnet (the Hermes trial key the testnet runs on ends ~2026-10-20). The landing page reads `deployments/143.json` at
build time and shows "Live on Monad mainnet · unaudited beta · capped", with the contract table and beta limits, only
when that file exists with `"production": true`. Otherwise it shows "Mainnet beta: pending launch gate". The same
contract set is what runs on Monad testnet today (`deployments/10143.json`).

### What changes for real money

| | Demo stack (testnet / anvil) | Production set (mainnet beta) |
|---|---|---|
| Collateral | `MockAUSD`, 6-decimal test token with a faucet | Agora **AUSD** on Monad mainnet, immutable token address, no mint, no faucet |
| Prices | Simulated GBM feed pushed to `MockOracle` by the keeper | **Pyth** pull oracle, verified on chain: expo-normalised, staleness bound, confidence check (`conf / price ≤ maxConfBps`), non-positive prices rejected, excess update fee refunded |
| Orders | `openPosition` fills immediately at the oracle price | **Delayed orders**: `commitOrder` escrows margin and an execution fee; `executeOrder` (anyone) must use the first Pyth update published at least `MIN_EXEC_DELAY` after the commit, within `MAX_EXEC_DELAY`, against the trader's acceptable price; `cancelOrder` only after `MAX_EXEC_DELAY` |
| Fees and funding | None | Trading fee (bps of notional) to lane insurance; execution fee (MON) to the executor; per-market funding from the **global** skew (sum of the 8 lanes' OI), written by a rate-limited `updateFunding` and settled when a position is touched |
| Caps | None | Max leverage, deposit cap per account, TVL cap per lane, OI cap per lane and market (sized against that lane's insurance + backstop), min position size |
| Liquidations | Per-block auctions, backstop pools, solvency ledgers | The same, priced with verified Pyth prices |
| Admin | Owner EOA, `seedAccounts`, `setOracle` | Owner = timelock driven by a multisig; guardian can only `pause()`; no `seedAccounts`, no shared-state flag, no `MockOracle` |
| Keeper | Price pusher, faucet, sweeper, crash runner, demo takers | Order executor, funding updater, auction sweeper, monitoring and alerts. No faucet, price pusher, demo takers or crash |

Why delayed orders: with a pull oracle, a trader who sees a newer price off chain could otherwise trade against the
older on-chain price, or pick which signed update to submit. Here the fill price is the first update published after
the delay, so neither the trader nor the executor chooses it, and a cancel is only possible after the window, so there
is no free option. That closes the classic oracle front-run. It doesn't remove every form of MEV.

### Who can do what

| Role | Can | Cannot |
|---|---|---|
| Owner: multisig → `TimelockController` | Change parameters, caps, fees, the oracle configuration and roles; unpause. Every change waits out the timelock delay (`TIMELOCK_MIN_DELAY_SECONDS`, 24 h in the env template) | Act instantly or skip the delay |
| Guardian (hot key) | `pause()`: blocks deposits and new increase orders | Unpause, change parameters, or stop withdrawals, reduce/close orders and liquidations (they keep working while paused) |
| 8 lane keepers + ops (hot keys) | Execute orders and run auctions with Pyth updates (earning execution fees); update funding | Choose the fill price, change parameters, pause |
| Anyone | Execute pending orders, start auctions, take an auction from an account in the same lane | Change an order's terms or fill it beyond its acceptable price |
| Deployer | Nothing after deploy: ownership moves to the timelock and deployer powers are renounced | |

This is the design in `docs/PRODUCTION_PLAN.md`; the deployed code is the final word.

### Launch gate (no exceptions)

Mainnet launch with real AUSD happens only if **all** of these pass:

1. The full Foundry suite for the production set, including fuzz and invariant tests (oracle edge cases, order timing,
   funding, caps, pause semantics, timelock-only admin, reentrancy, lane storage isolation).
2. Slither, with every high and medium finding fixed or justified in writing.
3. An adversarial internal review, with every critical finding fixed.
4. A full rehearsal on an anvil fork of Monad mainnet against the real AUSD and Pyth contracts.
5. Caps set to the beta values.

Otherwise the hackathon submission stays on testnet with no real value, and production ships only after an external
audit. **Not audited: internal review and Slither only.**

### Deploy and launch, in outline

The operator runbook (pause, key rotation, top-ups, incident response, timelock procedures) is
[`docs/RUNBOOK.md`](docs/RUNBOOK.md); keeper hosting (secrets, HTTPS, CORS, health checks, restarts) is
[`keeper/HOSTING.md`](keeper/HOSTING.md). The steps, in order:

1. `cp keeper/.env.mainnet.example keeper/.env.mainnet` (mode 600, gitignored). Fill in the owner multisig **address**,
   the timelock delay and the beta caps. Use a dedicated RPC.
2. `npm run keeper:init -- --network mainnet` generates fresh hot keys (deployer, guardian, ops, 8 lane keepers) into
   that file and prints addresses only.
3. `npm run keeper:fund -- --network mainnet` previews MON top-ups from measured gas, then sends after confirmation.
4. `npm run rehearse:mainnet`: deploy and run the whole production set on a local fork of Monad mainnet (real AUSD and
   Pyth, test balances via storage cheats, real Hermes updates), writing only to rehearsal output dirs.
5. Pass the launch gate above.
6. `npm run deploy:mainnet` runs `contracts/script/DeployProd.s.sol`: re-verifies AUSD, Pyth, decimals and feed ids on
   chain, deploys, sets the beta caps, wires roles, hands ownership to the timelock, renounces deployer powers and
   writes `deployments/143.json` with `"production": true`.
7. Host the keeper (`keeper/HOSTING.md`) and the app with `NEXT_PUBLIC_CHAIN_MODE=monad-mainnet`.
8. Commit `deployments/143.json` and rebuild: the landing page switches to "Live on Monad mainnet" and lists the
   contracts with Monadscan links.

Exact flags and confirmation prompts are in `docs/RUNBOOK.md`; mainnet commands require an explicit confirmation flag
and print balances and costs first.

### Deployed contracts (Monad mainnet, chain id 143)

None: nothing of ours is on Monad mainnet. The launch gate has passed and the launch is pending on Pyth price data
for mainnet; when it happens, `deployments/143.json` (`"production": true`) is the list of addresses and the landing
page renders it with Monadscan links. The external contracts it will re-verify: Agora AUSD
`0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a`, Pyth `0x2880aB155794e7179c9eE2e38200202908C17B43`.

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

### 3a. Monad testnet (chain id 10143): what's live

`deployments/10143.json` is the **production** contract set (`"production": true`); the demo keeper refuses it.
The production keeper runs it (`keeper/.env.testnet` from `keeper/.env.testnet.example`; keys, funding and deploy in
[`docs/RUNBOOK.md`](docs/RUNBOOK.md) section 14, hosting in [`keeper/HOSTING.md`](keeper/HOSTING.md)):

```bash
npm run keeper -- --network testnet --yes-testnet   # order executor, funding, auction sweeper, /hermes Pyth proxy
# the app against it (the committed deployments/10143.json; .env.local):
#   NEXT_PUBLIC_CHAIN_MODE=monad-testnet
#   NEXT_PUBLIC_KEEPER_URL=https://<keeper host>              # /hermes, /orders, /health
#   NEXT_PUBLIC_ENVIO_GRAPHQL_URL=<Envio endpoint>            # order history + activity (indexer/README.md)
#   NEXT_PUBLIC_MONAD_TESTNET_RPC_URL=<dedicated RPC>         # recommended; the public RPC rate-limits
npm run dev
```

Use a dedicated RPC for the keeper; on the public RPC set `KEEPER_RPC_BATCH_SIZE=10` (and `KEEPER_LOG_RANGE=4` on
QuickNode's free plan). Test funds only: AUSD from Agora's faucet contract (the app's "Get testnet AUSD"), MON from
faucet.monad.xyz. Monad charges for the gas **limit**, so the keeper keeps limits tight.

### 3b. Demo stack on Monad testnet (bench + Conflict X-ray)

The demo stack (`ParaclrClearinghouseDemo`, `NaiveClearinghouseDemo`, `MockOracle`, `MockAUSD`) also runs on
testnet, from its own deployment file so it never touches the production one. It is where the Monad testnet X-rays
come from. Keys and steps in [`keeper/README.md`](keeper/README.md#monad-testnet-runbook):

```bash
npm run keeper:init                                   # keeper/.env with fresh demo keys (never commit it)
npm run keeper:fund -- --send                         # top up every role from the operator
DEPLOYMENTS_OUT=deployments/demo/10143.json npm run deploy:monad   # demo contracts (commit the file)
DEPLOYMENTS_OUT=deployments/demo/10143.json npm run keeper         # price loop, faucet, sweeper, crash API
DEPLOYMENTS_OUT=deployments/demo/10143.json npm run bench -- --accounts 100 --yes   # bench/results + bench/xray/10143-*
```

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

| Network | Shock | Accounts | Went to auction | Backstop / external (demo bots) / cured / expired | Avg discount | Time underwater p50 / max | Equity returned to traders | Taken from traders: auction vs old fixed-fee path | Lane-funded shortfall | Evidence |
|---|---|---|---|---|---|---|---|---|---|---|
| local anvil (31337), **not Monad** | −20% | 524 | 96 | 80 / 13 / 0 / 3 | 76.61 bps | 4 / 21 blocks (20,988 ms) | 5,101.41 AUSD | 4,642.19 vs 7,082.64 AUSD | 292,780.30 AUSD | `bench/results/31337-2026-10-06T22-53-30Z.json` |
| local anvil (31337), **not Monad** | −20% | 524 | 96 | 80 / 13 / 0 / 3 | 76.61 bps | 4 / 21 blocks (8,407 ms) | 5,101.41 AUSD | 4,642.19 vs 7,082.64 AUSD | 292,780.30 AUSD | `bench/results/31337-2026-10-06T22-54-24Z.json` |
| local anvil (31337), **not Monad** | −5% | 524 | 7 | 1 / 6 / 0 / 0 | 64.29 bps | 4 / 4 blocks (4,024 ms) | 5,640.10 AUSD | 2,937.70 vs 4,526.41 AUSD | 0 AUSD | `bench/results/31337-2026-10-06T22-54-58Z.json` |

The anvil runs are 500 seeded synthetic accounts plus 24 keeper-run demo takers (`auctions.externalTakers.demo:
true`); every external take was made by those bots. "Taken from traders by the auction" is `traderEquityAtStart −
traderResidualReturned`, directly comparable with the keeper's counterfactual for the old 1% fixed-fee path. The
lane-funded shortfall is `auctions.badDebt`: what lane insurance (then lane bad debt) paid where a backstop take's
payment exceeded the account's equity, which happens with deeply underwater accounts after a −20% shock.

There is no Monad testnet row: the two crash runs of the demo stack on testnet (2026-10-08, 100 accounts, −20% and
−30%) are kept in [`bench/diagnostics/`](bench/diagnostics/README.md) with their caveat. Their keeper ran over the
15-request/s public RPC and needed ~40 s to take, so every auction in the first run hit the 500 bps cap: they measure
the keeper's latency, not the auction design. That is why the live deployment's step went to 5 bps and its keeper to a
dedicated RPC. Their X-rays are valid and are in the table below.

### Conflict X-ray

| Network · method | Design | Txs | Dependency edges | Across lanes | Longest chain | Evidence |
|---|---|---|---|---|---|---|
| **Monad testnet** · live `debug_traceTransaction` | Paraclr lanes | 12 | 1 | **0** | 2 | `bench/xray/10143-run-muz0vh3f-wciq2.json` (−30% run) |
| **Monad testnet** · live `debug_traceTransaction` | Naive shared state | 17 | 6 | **6** | 3 | same file |
| **Monad testnet** · live `debug_traceTransaction` | Paraclr lanes | 23 | 1 | **0** | 2 | `bench/xray/10143-run-muyzuvuh-l9hto.json` (−20% run) |
| **Monad testnet** · live `debug_traceTransaction` | Naive shared state | 22 | 6 | **4** | 3 | same file |
| local anvil, **not Monad** · live `debug_traceTransaction` | Paraclr lanes | 52 | 34 | 0 | 4 | `bench/xray/31337-run-muxa08r6-x9rft.json` (−20% run) |
| local anvil, **not Monad** · live `debug_traceTransaction` | Naive shared state | 49 | 311 | 277 | 18 | same file |
| local anvil, **not Monad** · live `debug_traceTransaction` | Paraclr lanes | 18 | 11 | 0 | 5 | `bench/xray/31337-run-muxa18h8-ef0ay.json` (−5% run) |
| local anvil, **not Monad** · live `debug_traceTransaction` | Naive shared state | 18 | 27 | 16 | 6 | same file |

Edges are drawn only between transactions in the same block (`edgeScope: "same-block"`). Within-lane edges exist by
design (the takers and the sweeper of one lane share that lane's aggregates); the lane claim is **zero cross-lane
edges**. anvil executes sequentially, so these graphs show dependencies, not anything about Monad's parallel
execution or its re-execution counts.

The Monad testnet X-rays come from the demo stack deployed on Monad testnet (`deployments/demo/10143.json`) and were
traced live on Monad. Their transactions spread over more blocks than on anvil (6 and 17 blocks), so the naive build
shows fewer same-block conflicts there; the lanes still show none across lanes. The auction economics of those two
runs are in [`bench/diagnostics/`](bench/diagnostics/README.md), not in the table above: the keeper that resolved them
was limited by a 15-request/s public RPC, which measures the keeper more than the design.

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

The production contract set runs on Monad testnet with Agora's testnet AUSD and Pyth prices: test funds, no real
value. Addresses from [`deployments/10143.json`](deployments/10143.json) (deploy block 69,041,758); operations in
[`docs/RUNBOOK.md`](docs/RUNBOOK.md) section 14.

| Contract / role | Address | Explorer |
|---|---|---|
| `ParaclrClearinghouseProd` (v5) | `0xbC1fD0165FBfF4EF32337E42D0e2Ad59bF52b203` | `https://testnet.monadexplorer.com/address/0xbC1fD0165FBfF4EF32337E42D0e2Ad59bF52b203` |
| `TimelockController` (600 s), the owner | `0xdD66E8118e0a1096D8eEC5b0A0eE9612890047Ab` | `https://testnet.monadexplorer.com/address/0xdD66E8118e0a1096D8eEC5b0A0eE9612890047Ab` |
| Owner Safe (proposes and executes through the timelock) | `0xCC62247E59A3872013e2dB7A52696A3117F2e4c3` | `https://testnet.monadexplorer.com/address/0xCC62247E59A3872013e2dB7A52696A3117F2e4c3` |
| Guardian (pause only) | `0x35b9f469988ef7748DcD6CC232e6f3b665cCBFC8` | `https://testnet.monadexplorer.com/address/0x35b9f469988ef7748DcD6CC232e6f3b665cCBFC8` |
| AUSD (Agora, testnet, external) | `0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC` | `https://testnet.monadexplorer.com/address/0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC` |
| Pyth (external) | `0x2880aB155794e7179c9eE2e38200202908C17B43` | `https://testnet.monadexplorer.com/address/0x2880aB155794e7179c9eE2e38200202908C17B43` |
| Agora AUSD faucet (external; `requestFunds(address)`, 10,000 AUSD per call) | `0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C` | `https://testnet.monadexplorer.com/address/0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C` |

Markets: SOL/AUSD and BTC/AUSD (MON isn't listed: the Pyth data access these prices run on doesn't cover it). Caps:
50 AUSD per account, 500 AUSD per lane, 10x. Auction: **step 5 bps per block** (set through the timelock on
2026-10-08; the contract default is 25), cap 500 bps, backstop pool minimum 75 bps. Envio indexer (HyperIndex on
Envio Cloud, `paraclr-testnet`): `https://indexer.dev.hyperindex.xyz/b6db2a9/v1/graphql` (the app's
`NEXT_PUBLIC_ENVIO_GRAPHQL_URL`; each Envio deployment gets its own URL, see [`indexer/README.md`](indexer/README.md)).
The Pyth prices run on a Hermes trial key that ends ~2026-10-20; the planned switch to a keeper-signed fallback oracle
through the timelock is [`docs/RUNBOOK.md`](docs/RUNBOOK.md) section 14.6.

The measured crash runs in [Results](#results) come from the demo stack (`ParaclrClearinghouseDemo`,
`NaiveClearinghouseDemo`, `MockOracle`, `MockAUSD`) on local anvil, labelled as such. The same demo stack is deployed
on Monad testnet from [`deployments/demo/10143.json`](deployments/demo/10143.json) (since 2026-10-08, kept apart from
the production file): the Monad testnet X-rays were traced there.

---

## Repo map

```
contracts/          Foundry: ParaclrClearinghouse(+Demo), NaiveClearinghouseDemo, MockOracle, ChainlinkStreamsOracle,
                    MockAUSD; unit, auction and invariant tests; deploy script
contracts/src/prod/ the production set for the mainnet beta (Pyth, real AUSD, delayed orders, fees, funding, caps,
                    timelock + guardian); DeployProd.s.sol writes deployments/143.json
keeper/             Node keeper: price loop, faucet, per-lane sweeper, crash runner, Conflict X-ray, bench CLI;
                    keeper/src/prod/: mainnet executor, funding, Hermes client, alerts. Hosting: keeper/HOSTING.md
indexer/            Envio HyperIndex: orders, auctions, positions, flows and totals over GraphQL (Envio Cloud)
bench/results/      RunReport JSON from bench runs, committed as evidence
bench/xray/         XrayReport JSON (lanes vs naive), committed as evidence
deployments/        <chainId>.json: deployed addresses + market ids, read by the app
scripts/            dev-chain, deploy, export-abi (npm run abi -> src/lib/chain/abi/*.ts, generated)
src/app/            Next.js 16 App Router: landing page (/), the app (/app), /pnl (shared PnL card; its image at
                    /api/pnl-card), /risk and /terms (drafts), manifest.ts (installable web app, no service worker),
                    opengraph-image / twitter-image (the share card)
                    /arena: public "crash the market" page, driven by an arena-mode keeper (keeper/README.md)
src/components/     landing/, auth/, trade/, clearing/ (auctions, X-ray), backstop/, solvency/, shell/
src/lib/            chain clients and ABIs, in-browser simulation, price sources
docs/               PRODUCTION_PLAN.md, TESTNET_PLAN.md (the testnet production deployment), FAIR_LIQUIDATION_PLAN.md,
                    ONCHAIN_PLAN.md (build contracts), RUNBOOK.md (operations; section 14 = Monad testnet),
                    DESIGN.md (brand and design system), SUBMISSION.md, x/ (social drafts)
```

## Known limitations

- **Not audited**: internal review and Slither only, for the demo and the production set alike. The mainnet beta is
  capped for that reason.
- Demo stack: AUSD is a stand-in token, prices are simulated and pushed on-chain, crash-run accounts are synthetic, and
  external takes in the bench runs are keeper-run demo bots.
- Production set: keepers, the guardian and the ops key are run by one operator; anyone can execute orders and
  auctions, but nobody is obliged to. The owner is a multisig behind a timelock. `/terms` and `/risk` are drafts
  pending legal review.
- MEV-resistant pricing, not MEV-free: takers can still compete on ordering within a block.
- Backstop exposure is reduced by an operator/keeper role (`backstopReduce`), not by a market. LPs carry the price
  risk of inherited positions until then.
- Each lane's insurance fund is the counterparty for that lane's positions. One position per market per account. The
  demo stack has no funding payments or trading fees (the production set has both).
- Imbalanced lanes (one busy lane) cap the parallelism of a run. 8 lanes is a design choice, not a Monad limit.
- The Conflict X-ray shows dependencies, not Monad's re-execution counts.
- See [`contracts/README.md`](contracts/README.md) for contract-level limitations.

## Affiliation

We are entering the Monad Metropolis hackathon. Sponsor tools are used through their public SDKs and services (Privy,
Envio HyperIndex, HyperSync and Envio Cloud) and public contracts (Agora's AUSD, Pyth). We have no partnership with or
endorsement from Monad, Agora, Pyth, Privy, Envio, Chainlink or any other sponsor.
