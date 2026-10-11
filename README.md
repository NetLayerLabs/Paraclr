# Paraclr

**The fair-liquidation clearinghouse for Monad.**

## About

Paraclr is a perpetuals clearinghouse on Monad that fixes one problem: when a position goes underwater, liquidation
bots race on gas for a penalty fixed in advance, and the trader's remaining equity pays for that race. Paraclr prices
every liquidation with a **per-lane Dutch auction whose discount rises with the block number**, so gas buys only an
earlier take at a smaller discount, and the trader keeps whatever equity the auction doesn't use; the risk state is
split into 8 lanes of lane-local storage, so the lanes' auctions don't touch each other's storage and can run in
parallel on Monad. It is **live on Monad testnet** (test funds, no real value): [app](https://paraclr.xyz/app),
[arena](https://paraclr.xyz/arena), [evidence](#results).

### How to try it (judges, about 5 minutes)

1. **Sign in.** Open [paraclr.xyz/app](https://paraclr.xyz/app) and sign in with a **passkey** (or email, a social
   login or an external wallet, through Privy). Each sign-in gets one embedded wallet; a reload keeps you signed in.
2. **Gas drip.** Press **"Get 0.3 test MON for gas"**: the keeper sends a fresh wallet 0.3 testnet MON, once per
   address. That covers gas and the **0.1 MON execution fee** each order pays its executor.
3. **Claim AUSD.** Press **"Claim test AUSD"**: Agora's testnet faucet contract sends 10,000 test AUSD. Its rate limit
   is global (one drip per 60 s across all users), so retry after a minute if it says so.
4. **Deposit.** Deposit up to the testnet cap of **50 AUSD** per account (an exact-amount approve, then the deposit).
5. **Trade.** Open a SOL/AUSD or BTC/AUSD position (up to 10x, at least 10 AUSD). It is a **delayed order**: the
   keeper fills it at the first Pyth price published at least 3 s after your commit. History comes from the Envio
   indexer.
6. **Watch the arena.** Open [paraclr.xyz/arena](https://paraclr.xyz/arena) and press **"Crash the market"**: a −20%
   oracle shock on the demo stack on Monad testnet, then 8 lanes of auctions clearing next to the shared-state build,
   then the measured [Conflict X-ray](#conflict-x-ray). See [Arena](#arena-crash-it-yourself) for its limits.

## Overview

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
that collapses to a touch layout with swipe-to-trade on phones, installable as a web app. What Monad, Agora AUSD,
Pyth, Privy and Envio each do in Paraclr, with code paths and addresses, is in [Built on](#built-on).

> **Status (2026-10-11).** The production contracts have run on **Monad testnet** since 2026-10-07 with Agora's
> testnet AUSD and Pyth prices: test funds, no real value (addresses
> [below](#deployed-contracts-monad-testnet-chain-id-10143)). Its auction step was lowered from the contract default
> of 25 to **5 bps per block** through the timelock on 2026-10-08; an Envio indexer feeds the app's order history.
> The headline crash run in [Results](#results) was measured on **Monad testnet** (demo stack, 2026-10-10): 22
> auctions, their resolution transactions in 11 blocks (8.8 s), **28% less taken from traders** than a fixed 1%
> liquidation, 0 cross-lane edges vs 18 for the shared-state build. The public [Arena](#arena-crash-it-yourself) is
> live on Monad testnet; its first crash measured 0 cross-lane edges vs 49. The larger local-anvil runs are kept
> alongside. A
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

### Typical liquidation vs Paraclr

"Typical" is the common first-bot-wins, fixed-penalty pattern, not any one venue. Paraclr's column describes the
contracts in this repo, which are live on Monad testnet.

| | Typical perp liquidation | Paraclr |
|---|---|---|
| Who takes the account | The first bot to land a transaction | The first taker at the current discount, or the lane's backstop pool at its threshold |
| How the price is set | A fixed fee, set before the crash | A discount set by the block clock: 0, then +5 bps per block on the live testnet (contract default 25). The trader keeps `E − P` |
| What a higher gas bid buys | Priority for the whole fee | Only an earlier take, at a smaller discount |
| Where a shortfall lands | Usually a venue-wide insurance fund or pool | Its own lane: lane insurance first, then lane bad debt |
| State layout | Shared global state: one set of aggregates | 8 lanes with lane-local ledgers, pools and open interest |
| Parallel execution | "Parallel" as a claim | A measured Conflict X-ray of each crash (dependencies, not re-executions) |
| Solvency | Up to each venue | `solvency()`: AUSD held vs the 8 lane ledgers, read every block |

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

## Arena: crash it yourself

[`/arena`](src/app/arena/page.tsx) ([paraclr.xyz/arena](https://paraclr.xyz/arena)) is live on Monad testnet. Anyone
presses "Crash the market" and every viewer watches the same run on the demo stack
([`deployments/demo/10143.json`](deployments/demo/10143.json)): a fresh book seeded identically into the lanes build
and the shared-state build, one −20% oracle shock, the sweeper resolving every auction on both, the Conflict X-ray,
then a price reset. It is driven by the demo keeper in arena mode ([`keeper/src/arena.ts`](keeper/src/arena.ts),
[`keeper/README.md`](keeper/README.md#arena-mode---arena)).

- **Live configuration:** 1 account per lane (`ARENA_PER_LANE=1`) and at most 8 crashes per UTC day
  (`ARENA_DAILY_MAX=8`), with a cooldown after each cycle and one crash per visitor per window (the code defaults are
  3 and 40).
- **Keeper auto-refill:** after each cycle the operator tops every lane keeper below `ARENA_KEEPER_REFILL_MON` back up
  to it (0.7 MON by default on Monad, 3 blocks apart for Monad's reserve rule); below the gas guard the page says
  "Arena is refuelling" instead of starting a run that can't finish.
- **Measured:** the first public Arena crash (2026-10-10) had **0 cross-lane dependency edges vs 49** for the
  shared-state build ([`bench/xray/10143-run-mv2ze6l6-xzyi6.json`](bench/xray/10143-run-mv2ze6l6-xzyi6.json)); the
  benchmark crash on the same stack had **0 vs 18**
  ([`bench/xray/10143-run-mv2za35r-mfh66.json`](bench/xray/10143-run-mv2za35r-mfh66.json)) and took **28% less from
  traders** than the fixed 1% path
  ([`bench/results/10143-2026-10-10T22-40-07Z.json`](bench/results/10143-2026-10-10T22-40-07Z.json)).
- Arena accounts are synthetic and keyless; nothing a visitor deposits in the app is touched by a crash.

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

## Built on

Paraclr is contracts, a keeper and an app built on five projects. This section says exactly what each one does here,
where the code is and which addresses it uses. Addresses on Monad testnet are from
[`deployments/10143.json`](deployments/10143.json) unless noted; the full list is in
[Deployed contracts](#deployed-contracts-monad-testnet-chain-id-10143).

### [Monad](https://www.monad.xyz)

An EVM-compatible Layer 1 that executes the transactions in a block optimistically in parallel and re-executes any
transaction whose inputs an earlier one in the same block changed.

**How Paraclr uses it**

- **Chain.** The production contract set runs on Monad testnet (chain id 10143) since deploy block 69,041,758:
  `ParaclrClearinghouseProd` at `0xbC1fD0165FBfF4EF32337E42D0e2Ad59bF52b203`. The demo stack used for crash runs and
  X-rays is deployed separately ([`deployments/demo/10143.json`](deployments/demo/10143.json)). Mainnet (chain id
  143) is [gated](#production-beta-monad-mainnet-gated).
- **Storage laid out for parallel execution.** Everything an auction writes is keyed by lane (`uint160(account) % 8`):
  `Lane[8] _lanes`, `LaneLedger[8] _ledgers`, `AuctionCounters[8]`, `_laneOI`, `_lanePrice`, `_auctionList` and
  `_pools` in [`contracts/src/prod/ParaclrClearinghouseProd.sol`](contracts/src/prod/ParaclrClearinghouseProd.sol),
  whose header lists the only writers of every global slot. The reentrancy lock is EIP-1153 transient storage. See
  [Lanes: the engine](#lanes-the-engine).
- **Measured on Monad testnet.** The [Conflict X-ray](#conflict-x-ray) traces every resolution transaction with
  `debug_traceTransaction` ([`keeper/src/xray.ts`](keeper/src/xray.ts), [`keeper/src/xray-run.ts`](keeper/src/xray-run.ts))
  and compares it with a shared-state build of the same contract: **0 vs 18** cross-lane dependency edges in the
  2026-10-10 benchmark crash ([`bench/xray/10143-run-mv2za35r-mfh66.json`](bench/xray/10143-run-mv2za35r-mfh66.json)),
  **0 vs 49** in the first public Arena crash
  ([`bench/xray/10143-run-mv2ze6l6-xzyi6.json`](bench/xray/10143-run-mv2ze6l6-xzyi6.json)).
- **Auctions timed in blocks.** The discount rises per block, not per second; at the testnet's 5 bps step and ~0.35 s
  blocks the backstop minimum is reached at block 15 (≈ 5 s) and the 500 bps cap at block 100 (≈ 35 s)
  ([`docs/RUNBOOK.md`](docs/RUNBOOK.md) section 14). The public [`/arena`](src/app/arena/page.tsx) page runs the crash
  on Monad testnet for anyone, lanes next to the shared-state build ([`keeper/src/arena.ts`](keeper/src/arena.ts)).
- **Monad specifics the keeper handles.** Gas is billed on the gas **limit**, so every limit is `estimateGas` plus a
  small margin ([`keeper/src/sender.ts`](keeper/src/sender.ts), [`keeper/src/prod/budget.ts`](keeper/src/prod/budget.ts));
  the reserve-balance rule (below 10 MON a value-carrying transaction must be the sender's first in 3 blocks) is
  enforced per key ([`keeper/src/prod/reserve.ts`](keeper/src/prod/reserve.ts), [`keeper/src/takers.ts`](keeper/src/takers.ts));
  account checks are batched through Multicall3 and JSON-RPC batches ([`keeper/src/network.ts`](keeper/src/network.ts));
  the public RPC's per-second caps (`-32007`) are retried with backoff ([`keeper/src/rpc-retry.ts`](keeper/src/rpc-retry.ts)).
  The production contract is larger than EIP-170's 24,576 bytes and relies on Monad's 128 KB code-size limit
  ([`contracts/foundry.toml`](contracts/foundry.toml)).

**Why it matters for fair liquidations.** In a crash every lane's auctions resolve in the same blocks; because their
write sets are disjoint, Monad has no reason to re-execute one lane's resolution because of another's, and the X-ray
publishes that claim as a measured graph rather than an assertion.

### [Agora AUSD](https://www.agora.finance)

AUSD is a US-dollar stablecoin issued by Agora.

**How Paraclr uses it**

- **The single collateral and quote asset.** Margin, PnL, trading fees, lane insurance and backstop LP deposits are
  all AUSD, 6 decimals, at an immutable token address set at deploy.
- **Testnet.** Agora's testnet AUSD `0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC`. The app's "Claim test AUSD" calls
  Agora's faucet contract `0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C` (`requestFunds(address)`, 10,000 test AUSD per
  call) from the user's wallet; limits are read from the contract
  ([`src/lib/chain/prod/agoraFaucet.ts`](src/lib/chain/prod/agoraFaucet.ts)).
- **Mainnet beta.** Agora AUSD `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a` with 6 decimals
  ([`keeper/src/prod/config.ts`](keeper/src/prod/config.ts)); `DeployProd.s.sol` re-verifies the token and its
  decimals on chain before deploying.
- **Exact-amount approvals.** Every deposit asks for `approve` of the exact amount, never unlimited
  ([`src/lib/chain/prod/actions.ts`](src/lib/chain/prod/actions.ts)).
- **Disclosed risk.** The [risk disclosure](src/app/risk/page.tsx) (`/risk`) states that AUSD can lose its peg and may
  carry issuer controls such as freezing addresses, and that Paraclr does not issue, back or redeem it.

**Why it matters for fair liquidations.** A single collateral asset keeps the solvency identity exact
(`AUSD.balanceOf(clearinghouse)` equals the sum of the lanes' ledgers, see [Solvency proof](#solvency-proof)), so an
auction moves internal AUSD balances only and never needs an ERC-20 transfer on the hot path.

### [Pyth](https://www.pyth.network)

A pull oracle: signed price updates are fetched off chain (from Hermes) and verified on chain by the Pyth contract.

**How Paraclr uses it**

- **Contract and feeds.** Pyth `0x2880aB155794e7179c9eE2e38200202908C17B43` on Monad testnet (the same address on
  mainnet). Feeds: SOL/USD `0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d` and BTC/USD
  `0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43` for the SOL/AUSD and BTC/AUSD markets.
- **Verified on chain.** `ParaclrClearinghouseProd` normalises the exponent, rejects non-positive prices, prices with
  `conf / price` above `maxConfBps` (200 = 2% on testnet), supplied updates older than `maxPriceAge` (30 s) and stored
  prices older than `maxStoredPriceAge` (15 s). Per lane and market, prices never move backwards.
- **Delayed orders.** `commitOrder` escrows margin and the execution fee (0.1 MON per order on testnet);
  `executeOrder` fills at the **first** Pyth update published at or after the commit's delay (3 s on testnet,
  `parsePriceFeedUpdatesUnique`), so neither the trader nor the executor picks the price.
  The keeper fetches that update from Hermes ([`keeper/src/prod/hermes.ts`](keeper/src/prod/hermes.ts)) and
  pushes stored prices only when an execution needs them (`PYTH_PUSH_MODE=on-demand`,
  [`keeper/src/prod/pricepush.ts`](keeper/src/prod/pricepush.ts)).
- **Auctions and user calls.** The sweeper attaches a fresh update to every auction transaction. The app gets updates
  through the keeper's `/hermes` proxy, which holds the API key server-side
  ([`src/lib/chain/prod/priceUpdate.ts`](src/lib/chain/prod/priceUpdate.ts) for transactions,
  [`src/lib/chain/prod/pythPrices.ts`](src/lib/chain/prod/pythPrices.ts) for display); the proxy cannot alter a price,
  only withhold one.
- **Trial-end fallback.** The testnet runs on a Hermes trial key that ends ~2026-10-20. The planned switch, through the
  timelock, is `KeeperSignedPyth` ([`contracts/src/testnet/KeeperSignedPyth.sol`](contracts/src/testnet/KeeperSignedPyth.sol),
  testnet only, not deployed yet), with prices labelled "simulated after the Pyth trial"
  ([`docs/RUNBOOK.md`](docs/RUNBOOK.md) section 14.6).

**Why it matters for fair liquidations.** An auction's discount is only fair if the mark it is measured against is
current and verifiable; every auction transaction carries a signed Pyth update that the contract checks for age and
confidence before any equity is computed.

### [Privy](https://www.privy.io)

Authentication and embedded wallets for web apps.

**How Paraclr uses it**

- **Sign-in.** Passkey (the primary button), email, Google, X, Discord, GitHub or an external wallet
  (`loginMethods` in [`src/components/auth/AuthProvider.tsx`](src/components/auth/AuthProvider.tsx); a method also has
  to be enabled in the Privy dashboard).
- **Embedded wallets.** `createOnLogin: "users-without-wallets"`: every non-wallet sign-in gets one embedded wallet on
  the app's chain, and the app waits for it rather than creating a second
  ([`src/components/auth/PrivyAuth.tsx`](src/components/auth/PrivyAuth.tsx)).
- **Transaction signer.** `PrivyWalletBridge` registers the signed-in wallet's EIP-1193 provider as the app's signer
  ([`src/lib/chain/signer.ts`](src/lib/chain/signer.ts)); transactions go to the app's own RPC. Embedded-wallet
  confirmation popups are on for mainnet only; an external wallet confirms every transaction itself.
- **Session restore.** `PrivySessionRestore` restores the app session after a reload while Privy still holds one.
- **No burner where it counts.** The demo burner key is offered only where Privy is not configured, never on the live
  testnet with Privy set and never on mainnet ([`src/lib/auth/session.ts`](src/lib/auth/session.ts)).

**Why it matters for fair liquidations.** A trader who can top up from a phone in seconds can cure an auction
(`cancelAuction` once healthy) before a taker does; a passkey wallet removes the seed-phrase step from that path.

### [Envio](https://envio.dev)

HyperIndex is Envio's indexing framework; HyperSync is its chain-data API, which HyperIndex reads from.

**How Paraclr uses it**

- **Indexer.** [`indexer/`](indexer/README.md) is a HyperIndex project (`envio` 3.14.0) on the production
  clearinghouse from its deploy block, read through HyperSync with the public RPC as fallback
  ([`indexer/config.yaml`](indexer/config.yaml), 21 events).
- **Entities.** `Order`, `Auction`, `PositionChange`, `CollateralFlow`, `BackstopFlow`, plus running totals in
  `Account`, `Lane`, `Market`, `DailyStat` and `Protocol`, and `GuardianAction`
  ([`indexer/schema.graphql`](indexer/schema.graphql), handlers in
  [`indexer/src/handlers/ParaclrClearinghouse.ts`](indexer/src/handlers/ParaclrClearinghouse.ts)). Orders record fill
  price, realized PnL, fee and seconds to fill; auctions record taker, discount, payment and equity returned.
- **Hosting.** Envio Cloud, indexer `paraclr-testnet` (deployed from the `envio` branch). GraphQL:
  `https://indexer.dev.hyperindex.xyz/b6db2a9/v1/graphql`, the app's `NEXT_PUBLIC_ENVIO_GRAPHQL_URL`; each deployment
  gets its own URL ([`indexer/README.md`](indexer/README.md)).
- **What the app reads from it** ([`src/lib/indexer.ts`](src/lib/indexer.ts)): order history (Trade tab, Positions |
  History), each account's finished auctions for the "what you kept" comparison, and activity since deploy with the latest auctions (Clearing tab).
  Positions, balances and solvency are still read from the contract.
- **Checked against the chain.** AUSD held = insurance + backstop + deposits, and the executed-order count matches the
  keeper. `cd indexer && pnpm test` runs the handler tests on simulated events.

**Why it matters for fair liquidations.** Every auction's outcome (who took it, at what discount, how much equity went
back to the trader) is queryable after the fact, so the auction's fairness can be audited from history, not only
watched live.

### Supporting stack

| Project | Used for | Where |
|---|---|---|
| [Safe](https://safe.global) + [OpenZeppelin TimelockController](https://docs.openzeppelin.com/contracts/5.x/api/governance#TimelockController) | Owner of the production contracts: the Safe `0xCC62247E59A3872013e2dB7A52696A3117F2e4c3` proposes and executes every change through the timelock `0xdD66E8118e0a1096D8eEC5b0A0eE9612890047Ab` (600 s delay on testnet); the keeper never holds the owner key and only writes Safe Transaction Builder files | [`keeper/src/prod/timelock.ts`](keeper/src/prod/timelock.ts), [`docs/RUNBOOK.md`](docs/RUNBOOK.md) |
| [OpenZeppelin Contracts](https://www.openzeppelin.com/solidity-contracts) 5.6.1 | `Ownable`, `SafeERC20`, `SafeCast`, ECDSA in the fallback oracle, `TimelockController` in the deploy script (vendored, not edited) | [`contracts/lib/openzeppelin-contracts/`](contracts/lib/openzeppelin-contracts/VENDORED.md) |
| [Foundry](https://getfoundry.sh) | 256 tests across 53 test files plus 23 invariant tests (solvency identities; 256 runs × depth 100), fuzzing at 1,024 runs, and storage-access checks (`test_ParallelSafety_*`, `vm.record`); `anvil` for the local demo chain and mainnet-fork rehearsals | [`contracts/test/`](contracts/test/), [`contracts/foundry.toml`](contracts/foundry.toml) |
| [viem](https://viem.sh) | Chain reads and user transactions in the app; the keeper's signing, receipts, Multicall3 batching and the storage traces behind the X-ray | [`src/lib/chain/`](src/lib/chain/), [`keeper/src/`](keeper/src/) |
| [Next.js](https://nextjs.org) 16 | The landing page, the trading app, `/arena`, `/pnl`, `/risk` and `/terms` (App Router, CSS Modules) | [`src/app/`](src/app/) |

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
mainnet (the Hermes trial key the testnet runs on ends ~2026-10-20). This section lives only here: the landing page
no longer has a production-beta section. Its status bar reads `deployments/143.json` at build time and shows "Live on
Monad mainnet · unaudited beta · capped" (and the Results contract list switches to mainnet) only when that file
exists with `"production": true`. Until then it shows the testnet deployment with "Mainnet beta: launch pending". The
same contract set is what runs on Monad testnet today (`deployments/10143.json`).

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

All five passed on the v5 contract (sha256 `1643014507ea…`): the review is in
[`contracts/REVIEW.md`](contracts/REVIEW.md), the Slither results and accepted risks in
[`contracts/SECURITY_NOTES.md`](contracts/SECURITY_NOTES.md), and the 43/43 mainnet-fork rehearsal in
[`bench/rehearsal/`](bench/rehearsal/).

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
QuickNode's free plan). Test funds only: AUSD from Agora's faucet contract (the app's "Claim test AUSD"), MON from
the keeper's visitor drip (0.3 MON once per address, `POST /drip`, its own key `DRIP_PRIVATE_KEY`; see
`keeper/.env.testnet.example`) or faucet.monad.xyz. Monad charges for the gas **limit**, so the keeper keeps limits
tight.

Tests: `npm run contracts:test` (Foundry), `npm run test:keeper` (keeper unit tests), `cd indexer && pnpm test`
(indexer handlers). `npm run sandbox` runs the production set on a local fork of Monad testnet
([`docs/RUNBOOK.md`](docs/RUNBOOK.md) section 14.7).

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
| **Monad testnet (10143)** | −20% | 232 (100 seeded this run) | 22 | 18 / 4 / 0 / 0 | 103.41 bps | 24 / 32 blocks (9,337 ms) | 1,511.79 AUSD | 1,052.41 vs 1,464.26 AUSD | 59,951.50 AUSD | `bench/results/10143-2026-10-10T22-40-07Z.json` |
| local anvil (31337), **not Monad** | −20% | 524 | 96 | 80 / 13 / 0 / 3 | 76.61 bps | 4 / 21 blocks (20,988 ms) | 5,101.41 AUSD | 4,642.19 vs 7,082.64 AUSD | 292,780.30 AUSD | `bench/results/31337-2026-10-06T22-53-30Z.json` |
| local anvil (31337), **not Monad** | −20% | 524 | 96 | 80 / 13 / 0 / 3 | 76.61 bps | 4 / 21 blocks (8,407 ms) | 5,101.41 AUSD | 4,642.19 vs 7,082.64 AUSD | 292,780.30 AUSD | `bench/results/31337-2026-10-06T22-54-24Z.json` |
| local anvil (31337), **not Monad** | −5% | 524 | 7 | 1 / 6 / 0 / 0 | 64.29 bps | 4 / 4 blocks (4,024 ms) | 5,640.10 AUSD | 2,937.70 vs 4,526.41 AUSD | 0 AUSD | `bench/results/31337-2026-10-06T22-54-58Z.json` |

The anvil runs are 500 seeded synthetic accounts plus 24 keeper-run demo takers (`auctions.externalTakers.demo:
true`); every external take was made by those bots. "Taken from traders by the auction" is `traderEquityAtStart −
traderResidualReturned`, directly comparable with the keeper's counterfactual for the old 1% fixed-fee path. The
lane-funded shortfall is `auctions.badDebt`: what lane insurance (then lane bad debt) paid where a backstop take's
payment exceeded the account's equity, which happens with deeply underwater accounts after a −20% shock.

**The Monad testnet run (2026-10-10).** Demo stack on Monad testnet, auction step 5 bps per block, the same
100-account book seeded into both designs (`--seed 670643987`; the clearinghouse also held 132 accounts from earlier
runs, which is why 232 were scanned), −20% shock in block 69946941, auctions driven by the bench's in-process sweeper
with batched (Multicall3) account checks over the public RPC. The resolution transactions landed in 11 blocks, 8.8 s
from the first resolution submit to the last receipt. The auction took 1,052.41 AUSD from traders where the old fixed 1%
path would have taken 1,464.26: **411.85 AUSD (28%) less taken from traders**. Per account, 3 lost less, 19 lost the
same and none lost more. The 19 were nearly bankrupt after the
shock, so both paths take everything left; the gain comes from the accounts that still had equity. The lane-funded
shortfall is large because the synthetic book's leverage mix leaves many accounts below zero at −20%; the naive build
had the same (62,638.87 AUSD).

The two earlier testnet runs (2026-10-08) are kept in [`bench/diagnostics/`](bench/diagnostics/README.md) with their
caveat: their keeper checked accounts one `eth_call` at a time over the 15-request/s public RPC and needed ~40 s to
take, so every auction in the first run hit the 500 bps cap. They measured the keeper's latency, which the batched
sweeper fixed (above). Their X-rays are valid and are in the table below.

### Conflict X-ray

| Network · method | Design | Txs | Dependency edges | Across lanes | Longest chain | Evidence |
|---|---|---|---|---|---|---|
| **Monad testnet** · live `debug_traceTransaction` | Paraclr lanes | 18 | 0 | **0** | 1 | `bench/xray/10143-run-mv2ze6l6-xzyi6.json` (first public Arena crash, −20%, 2026-10-10) |
| **Monad testnet** · live `debug_traceTransaction` | Naive shared state | 25 | 49 | **49** | 8 | same file |
| **Monad testnet** · live `debug_traceTransaction` | Paraclr lanes | 23 | 2 | **0** | 2 | `bench/xray/10143-run-mv2za35r-mfh66.json` (−20% run, 2026-10-10) |
| **Monad testnet** · live `debug_traceTransaction` | Naive shared state | 24 | 20 | **18** | 4 | same file |
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
traced live on Monad. In the two 2026-10-08 runs (`muz0vh3f`, `muyzuvuh`) the transactions spread over more blocks
than on anvil (6 and 17 blocks), so the naive build shows fewer same-block conflicts there; the lanes still show none
across lanes. The auction economics of those two runs are in [`bench/diagnostics/`](bench/diagnostics/README.md), not
in the table above: the keeper that resolved them was limited by a 15-request/s public RPC, which measures the keeper
more than the design.

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
50 AUSD per account, 500 AUSD per lane, 10x, 10 AUSD minimum position. Fees: trading fee 5 bps of notional,
execution fee **0.1 MON per order** (`executionFeeWei`), orders fill 3 to 60 s after commit. Auction: **step 5 bps per block** (set through the timelock on
2026-10-08; the contract default is 25), cap 500 bps, backstop pool minimum 75 bps. Envio indexer (HyperIndex on
Envio Cloud, `paraclr-testnet`): `https://indexer.dev.hyperindex.xyz/b6db2a9/v1/graphql` (the app's
`NEXT_PUBLIC_ENVIO_GRAPHQL_URL`; each Envio deployment gets its own URL, see [`indexer/README.md`](indexer/README.md)).
The Pyth prices run on a Hermes trial key that ends ~2026-10-20; the planned switch to a keeper-signed fallback oracle
through the timelock is [`docs/RUNBOOK.md`](docs/RUNBOOK.md) section 14.6.

The measured crash runs in [Results](#results) and the [Arena](#arena-crash-it-yourself) use the demo stack
(`ParaclrClearinghouseDemo`, `NaiveClearinghouseDemo`, `MockOracle`, `MockAUSD`), not the production contracts. It is
deployed on Monad testnet from [`deployments/demo/10143.json`](deployments/demo/10143.json) (since 2026-10-08, kept
apart from the production file; clearinghouse `0x5b40ae35d3AD71A80542B7ea45DC7eEeCc7E21c5`, naive build
`0x3A158F70C24661A84C0e597dF23c2bFbC074981c`): the headline run and every Monad testnet X-ray were measured there. The
local-anvil runs are labelled as such.

---

## Repo map

```
contracts/          Foundry: ParaclrClearinghouse(+Demo), NaiveClearinghouseDemo, MockOracle, ChainlinkStreamsOracle,
                    MockAUSD; unit, auction and invariant tests; deploy script
contracts/src/prod/ the production set, live on Monad testnet and gated for the mainnet beta (Pyth, AUSD, delayed
                    orders, fees, funding, caps, timelock + guardian); DeployProd.s.sol writes deployments/<chainId>.json
contracts/src/testnet/ KeeperSignedPyth, the planned fallback oracle after the Pyth trial (testnet only)
keeper/             Node keeper: price loop, faucet, per-lane sweeper, crash runner, Conflict X-ray, arena mode,
                    bench CLI; keeper/src/prod/: order executor, funding, Hermes proxy, visitor gas drip, alerts.
                    Hosting: keeper/HOSTING.md
indexer/            Envio HyperIndex: orders, auctions, positions, flows and totals over GraphQL (Envio Cloud)
bench/results/      RunReport JSON from bench runs, committed as evidence
bench/xray/         XrayReport JSON (lanes vs naive), committed as evidence
bench/diagnostics/  the two 2026-10-08 testnet runs and their caveat; bench/rehearsal/: mainnet/testnet fork rehearsals
deployments/        <chainId>.json: deployed addresses + market ids, read by the app (demo/10143.json: demo stack)
scripts/            dev-chain, deploy, deploy-mainnet, sandbox, rehearse-*, testnet-oracle, export-abi
                    (npm run abi -> src/lib/chain/abi/*.ts, generated), brand-assets.mjs (regenerates the logo PNGs)
public/brand/       Paraclr and NetLayer Labs logo PNGs (mark, header lockup; ink and white) and their source artwork
src/app/            Next.js 16 App Router: landing page (/), the app (/app), /pnl (shared PnL card; its image at
                    /api/pnl-card), /risk and /terms (drafts), manifest.ts (installable web app, no service worker),
                    opengraph-image / twitter-image (the share card)
                    /arena: public "crash the market" page, driven by an arena-mode keeper (keeper/README.md)
src/components/     landing/ (8 sections: hero, problem, auction, X-ray, results, built on, FAQ, CTA), auth/ (Privy),
                    prod/ (testnet/mainnet trading), arena/, trade/, clearing/ (auctions, X-ray), backstop/,
                    solvency/, brand/, shell/
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
- Testnet only. Nothing of ours is on Monad mainnet; the capped mainnet beta is pending (see
  [Production beta](#production-beta-monad-mainnet-gated)).
- Testnet prices run on a Pyth Hermes trial key that ends ~2026-10-20. After the planned switch to the keeper-signed
  fallback oracle, prices are labelled "simulated after the Pyth trial" ([`docs/RUNBOOK.md`](docs/RUNBOOK.md) 14.6).
- Testnet caps are small on purpose: 50 AUSD per account, 500 AUSD per lane, two markets (SOL/AUSD, BTC/AUSD). The
  gas drip is 0.3 MON once per address; the Arena allows 8 crashes per UTC day and pauses while it refuels.
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

## License

[MIT](LICENSE) © 2026 NetLayer Labs. Vendored libraries under `contracts/lib/` keep their own licenses.
