# Paraclr: the fair-liquidation clearinghouse for Monad

## Overview

**Paraclr** is a cross-margin perpetuals clearinghouse on Monad whose liquidations are **auction-priced**. Every block,
underwater accounts in each of its 8 lanes go to a **per-block Dutch auction** backed by that lane's **backstop LPs**;
traders get back the equity the auction doesn't use. For every crash we publish a measured **Conflict X-ray** (the
storage-dependency graph of the transactions that resolved it, side by side with a deliberately naive shared-state
build of the same contract) and a **live solvency proof** that checks the books every block.

**Lanes are the engine, not the headline.** Risk state is split into 8 lanes (`lane = uint160(account) % 8`), each with
its own insurance fund, bad debt, open interest, backstop pool, auction state and solvency ledger. That makes the 8
lanes' auction transactions write disjoint storage, which is what lets a crash resolve in the same few blocks under
Monad's optimistic parallel execution. Our differentiators are on top of that engine: **fair, auction-priced
liquidations**, **showing** conflict-freedom with a measured graph instead of claiming it, and a **solvency proof**.

Contracts can't choose which of Monad's execution threads runs a transaction. Lanes are a **storage layout**, not
threads.

The pitch for judges: trade → crash → auctions resolve per lane within seconds → the trader keeps their leftover equity
→ the X-ray of that crash, lanes vs naive, side by side → the solvency badge stays green. All on Monad testnet, with
every number read from a committed JSON file.

Every number must say where it came from: **Monad testnet**, **local anvil (not Monad)**, or **simulation**.

---

## Honesty rules (all copy, UI and docs)

From `docs/FAIR_LIQUIDATION_PLAN.md`:

- Say "auction-priced liquidations: the discount is set by the block clock, not by gas bidding" and "MEV-resistant
  pricing". **Never** claim "no MEV" or "no gas wars".
- The X-ray shows storage read/write dependencies between transactions, the condition under which Monad's optimistic
  execution re-executes. It does **not** show Monad's internal re-execution counts. Always label the method (live trace
  vs local replay).
- anvil numbers are labelled "local anvil — not Monad". No invented numbers.
- Backstop yield is shown as "earned since deploy", never annualized APY.
- Don't name or disparage other projects.

---

## Targets and prize facts

Source: https://monad.xyz/developers/hackathons/metropolis (checked 2026-10-04).
Submissions close **2026-10-13**; we aim to submit **Mon Oct 12**. Judging runs Oct 14–27 and winners are announced
Nov 3. Judges check that the work was done in the build window, which started Sept 1.

| Prize | Amount (as published) | Fit |
|---|---|---|
| **Onchain Finance & Trading** track (primary) | $30,000 split evenly between 3 teams | Core target: fair, auction-priced liquidations on-chain, with measured runs, an X-ray and a solvency proof |
| **Grand Champion** (across all tracks) | $25,000 | Core target: same story, plus a working product |
| Agora: Best Mobile Trading App on Monad (sponsor, on top) | $10,000 | Secondary: mobile-friendly terminal (swipe-to-trade), AUSD-denominated margin. **Risk:** we use a 6-dp testnet stand-in (`MockAUSD`), not Agora's AUSD. Check the criteria |
| Privy (sponsor, on top) | $5,000 | Passkey login plus Privy embedded wallet on Monad testnet. Check the criteria |
| Perpl: Best Analytics / Risk Tool (sponsor, on top) | $3,000 | Possible fit for the X-ray, auction lifecycle and solvency views. Eligibility not checked |
| Chainlink: Best workflow with CRE (sponsor, on top) | $3,000 | **Not targeted.** CRE is out of scope; our Data Streams adapter doesn't qualify |

Don't add these up into a "potential" headline figure.

---

## Mechanism

Contract defaults (owner-configurable): `auctionStepBps = 25`, `auctionMaxDiscountBps = 500`, per-lane backstop
`minDiscountBps = 75` (block +3, about 1.2 s at 400 ms blocks; below the legacy 1% fixed fee), maintenance margin 2.5%.

1. **Start.** `startAuctions(lane, accounts)` (anyone): accounts below maintenance enter auction and are frozen (no
   withdraw / open / close; deposits allowed). Out-of-lane accounts revert the call.
2. **Discount clock.** `discountBps = min(max, step × (block.number − startBlock))`.
3. **Take.** At discount `d` the taker inherits every position at the current mark and is paid `P = d × notional`.
   The trader keeps `max(0, E − P)` as free collateral, where `E` is collateral + PnL at mark. If `E < P` and the
   lane's backstop pool takes, the lane pays the shortfall (insurance, then lane bad debt); an external taker is paid
   only `min(P, max(E, 0))`, so the lane never subsidizes self-liquidation. The trader never loses more than `E`.
   - Lane backstop pool: `backstopTakeBatch(lane, accounts)`, once `d ≥ minDiscountBps` and the pool can carry the
     positions.
   - External taker: `take(account)` from a registered account in the same lane that stays above initial margin.
4. **Cure.** `cancelAuction(account)` once the account is healthy again.
5. **Expiry.** At the cap with no taker, `expireBatch(lane, accounts)` closes at mark through the old fixed-fee path
   (1% of notional), with any shortfall against the lane.

**Backstop pools** (one per lane, lane-local storage): LPs deposit AUSD for shares at NAV; `NAV = cash + unrealized
PnL of inherited positions`. An operator/keeper role can `backstopReduce(lane, market, size)` to close inherited
exposure at mark. Withdrawals that would leave the pool under margin for its exposure are blocked.

**Solvency:** `AUSD.balanceOf(clearinghouse) == Σ lanes (collateral + insurance + backstop cash + keeper rewards owed −
bad debt)`, exposed by `solvency() → (ausdHeld, liabilities, surplus, solvent)` and `laneLedger(lane)`, covered by
Foundry invariant tests.

**Naive baseline:** `NaiveClearinghouseDemo` is the same code with a constructor flag that maps every per-lane aggregate
to one shared key. Identical logic; only storage keying differs. It exists only for the X-ray.

The interface contract between build agents is `docs/FAIR_LIQUIDATION_PLAN.md` (extends `docs/ONCHAIN_PLAN.md`). The
contract API is in `contracts/README.md`.

---

## Architecture

```
  Web app (Next.js)                         keeper/ (Node; the only holder of operator keys)
  passkey -> Privy embedded wallet          price loop: simulated GBM -> MockOracle.setPrices (~1s)
  (or labelled demo burner key)             sweeper: every block, one key per lane: start, take,
  trade: deposit / openPosition                      cancel, expire
  clearing: auctions per lane · X-ray       POST /faucet    -> test MON gas + 10,000 test AUSD
  backstop tab · solvency badge             POST /crash     -> 1 shock tx, then the sweeper; X-ray
        |                                   GET  /runs/:id(/xray), /solvency, /backstop
        |                                   npm run bench   -> bench/results + bench/xray
        v                                              |
  +-------------------------------------------------------------------------------------+
  |  Monad testnet (10143)   |   local anvil (31337, dev/CI only, not Monad)             |
  |                                                                                     |
  |  MockOracle --getPrice--> ParaclrClearinghouseDemo <--deposit-- MockAUSD (6 dp)     |
  |                           NaiveClearinghouseDemo (X-ray baseline)                   |
  |   lane 0 | lane 1 | lane 2 | lane 3 | lane 4 | lane 5 | lane 6 | lane 7              |
  |   each lane: insurance, bad debt, OI per market, backstop pool, auctions, ledger    |
  |   global OI / solvency = sums of lanes at read time; keeper rewards = per-keeper     |
  |   slot; reentrancy lock = EIP-1153 transient storage                                |
  +-------------------------------------------------------------------------------------+
```

### Components

1. **Clearinghouse (Monad).** Deposits and withdrawals, positions up to 20x, 2.5% maintenance margin, per-lane Dutch
   auctions, per-lane backstop pools, `solvency()`. `test_ParallelSafety_LaneBatchesTouchDisjointStorage` uses
   `vm.record` to assert two lanes' batches have no write/write or read/write storage overlap.
2. **Keeper.** Pushes prices, runs the faucet, sweeps every lane's auctions every block from that lane's key, runs
   crash/bench runs (measuring submit and confirm times for every tx, and time underwater per account), and computes
   the Conflict X-ray (`debug_traceTransaction` with `prestateTracer`, or an anvil-fork replay when the RPC has no debug
   API, always labelled).
3. **AUSD margin.** All pairs (MON/AUSD, SOL/AUSD, BTC/AUSD in the app) are quoted and margined in one stable asset.
   On testnet this is `MockAUSD`, a stand-in token, not Agora's AUSD.
4. **Privy passkeys.** WebAuthn login with no seed phrase, plus an embedded wallet on Monad testnet. Demo mode uses a
   browser burner key that is labelled in the UI. Scoped session keys are **not implemented**.
5. **Prices.** In chain modes the on-chain `MockOracle` is the source of truth, fed **simulated** prices by the keeper.
   A Chainlink Data Streams adapter (`ChainlinkStreamsOracle`) is unit-tested against a mock verifier only; not
   deployed, not in the demo.

---

## UI

- **Landing page** (`/`): fair liquidations, the auction (discount-over-blocks diagram), backstop LPs, the Conflict
  X-ray rendered from the committed `bench/xray/*.json` at build time (Monad testnet preferred, "pending" until a file
  exists), the solvency identity, lanes as the engine, measured results from `bench/results/*.json`, FAQ.
- **App** (`/app`), a responsive web app with no device frame. Desktop (1024px and up) is a grid trading terminal;
  phones (under 640px) get a touch layout with a bottom tab bar and swipe-to-trade.
  - **Header:** network badge and a **solvency badge** that reads `solvency()` every block, with a detail panel.
  - **Trade:** pick a pair, margin and leverage, then click (desktop) or swipe (touch). If the user's account is in
    auction, a banner shows the discount, roughly what they'd keep, and that adding collateral cures it.
  - **Clearing, Live:** 8 lanes with on-chain account counts; "Flash crash on Monad" triggers a real run; each lane's
    auctions start, tick and resolve (taken by backstop / external, cured, expired) with time underwater, equity
    returned to traders vs the old fixed-fee counterfactual, and the **Conflict X-ray** panel (both graphs, method
    label, summary numbers).
  - **Backstop tab:** per-lane pools (NAV, earned since deploy, notional absorbed, inherited exposure), deposit and
    withdraw.
  - **Simulated:** the in-browser model, clearly labelled "Simulated".
- **Wording.** "8 conflict-free lanes" or "Lane N". Never "Monad threads 1–8" or "Thread N". Never "no MEV".

---

## Demo flow (on-chain, Monad testnet)

1. **Sign in.** Passkey (Privy) creates an embedded wallet. The keeper `/faucet` sends test gas and 10,000 test AUSD.
2. **Trade.** MON/AUSD at 10x, open the long. Approve + deposit + `openPosition` on Monad testnet; show the confirmed
   state, the explorer link, and the position read back from chain.
3. **Crash.** Clearing screen, Live, ~500 seeded accounts across 8 lanes. "Flash crash on Monad": one −20% oracle tx.
4. **Auctions resolve per lane.** Every lane's sweeper starts its auctions; the discount ticks 25 bps per block; each
   lane's backstop takes at 75 bps. Show time underwater (measured) and the per-lane outcomes.
5. **Trader keeps equity.** Equity returned to traders vs the old fixed-fee counterfactual, from the run's JSON. If
   the demo account itself went under, show its banner and leftover collateral.
6. **X-ray.** The two dependency graphs side by side, with the method label.
7. **Solvency.** The header badge stays green; open the detail panel.
8. **Proof.** `bench/results/10143-*.json`, `bench/xray/10143-*.json`, and `forge test` (parallel-safety + invariants).

---

## Stack

- **App:** Next.js 16 (App Router, TypeScript, CSS Modules), viem, `@privy-io/react-auth`. Custom charts; no charting
  library.
- **Contracts:** Foundry, Solidity 0.8.24, `evm_version = cancun`.
- **Keeper:** Node service in `keeper/` (see `keeper/README.md`).

## Out of scope this sprint

Chainlink CRE workflow, real Agora AUSD, funding rates, trading fees, a market for backstop exposure (reduction is an
operator/keeper role), scoped session keys, mainnet, audits.
