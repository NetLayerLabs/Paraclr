# Paraclr: Monad Metropolis submission pack

Status: **DRAFT.** Human review before anything is submitted. Bracketed `[TBD]` / `[N]` placeholders are filled
**only** from committed `bench/results/*.json`, `bench/xray/*.json` and `deployments/10143.json`. Never estimate them.

Key dates (from https://monad.xyz/developers/hackathons/metropolis, checked 2026-10-04):

- Submissions close **Tue 2026-10-13**. Aim to submit by **Mon Oct 12**. The close time and time zone aren't
  confirmed yet, so check the page.
- Judging runs Oct 14–27. Winners are announced Nov 3.
- The submission needs "a working product with a public project profile: a demo, a short write-up, and a link to the
  code."
- Judges check that the work was done during the build window, which started Sept 1.

Track: **Onchain Finance & Trading** (Grand Champion is judged across all tracks).
Sponsor prizes, awarded on top of track prizes: Agora "Best Mobile Trading App on Monad", Privy, and Perpl "Best
Analytics / Risk Tool". Check each one's eligibility first. Not entering: Chainlink "Best workflow with CRE".

Honesty rules for everything below (from `docs/FAIR_LIQUIDATION_PLAN.md`): "auction-priced" and "MEV-resistant
pricing", never "no MEV" or "no gas wars"; the X-ray shows dependencies, not Monad's re-execution counts, and always
names its method; anvil is never Monad; backstop returns are "earned since deploy", never APY; no competitor names.

---

## 1. Project profile write-up (draft)

**Name:** Paraclr

**One-liner:** The fair-liquidation clearinghouse for Monad: per-block Dutch auctions in 8 lanes, backed by per-lane
backstop LPs, so traders keep their leftover equity, with a measured Conflict X-ray of every crash and a live solvency
proof.

**Problem.** On-chain liquidation is a race. An underwater account goes to whichever bot lands first, for a penalty
fixed in advance. Bots compete on gas and ordering rather than on price, so the penalty never falls when a taker would
have accepted less, and none of that competition flows back to the trader. And in a crash, a clearinghouse where every
liquidation writes the same global state can't use a parallel chain: the liquidations depend on each other.

**Solution.**

- **Auction-priced liquidations.** Every block, the sweeper puts newly underwater accounts into a Dutch auction. The
  discount starts at 0 and rises 25 bps per block (cap 500). A taker inherits the positions at the mark and is paid
  `P = discount × notional` (an external taker is capped at the trader's equity, so self-liquidation can't drain the
  lane); the trader keeps `E − P` as free collateral. If equity falls short on a backstop take, lane insurance and
  then lane bad debt cover it; a trader never loses more than their equity. Accounts that recover can be cured. The
  price comes from the block clock, so out-bidding on gas can't buy a bigger discount, only an earlier take at a
  smaller one. That is MEV-resistant pricing, not MEV-free.
- **Backstop LPs per lane.** Each lane has a pool that takes its auctions at 75 bps by default (block +3, about 1.2 s
  at 400 ms blocks), so every underwater account resolves within a bounded number of blocks. LPs earn the discount and
  carry the inherited exposure; returns are shown as earned since deploy, never as APY.
- **Lanes as the engine.** Every account lives in one of 8 lanes (`uint160(account) % 8`), and everything resolving
  it writes (insurance, bad debt, open interest, backstop pool, auction state, solvency ledger) exists once per lane.
  The 8 lanes' auction transactions write disjoint storage, so Monad's optimistic parallel execution has no reason to
  re-execute one lane's take because of another's.
- **Show, don't claim: the Conflict X-ray.** After a crash, the keeper traces every resolution transaction and builds
  the read/write dependency graph (edge = a later tx in the same block read or wrote a slot an earlier one wrote: the
  condition under which Monad re-executes). Then it runs the identical crash on `NaiveClearinghouseDemo`, the same code
  with every per-lane aggregate on one shared key, and we publish both graphs side by side. It does not show Monad's
  internal re-execution counts, and each X-ray names its method (live `debug_traceTransaction` trace, or an anvil-fork
  replay).
- **Live solvency proof.** `solvency()` checks `AUSD held == Σ lanes (collateral + insurance + backstop cash + keeper
  rewards owed − bad debt)`. The app reads it every block; Foundry invariant tests cover it.
- **A real terminal on top.** Passkey login through Privy, click-to-trade on desktop or swipe-to-trade on a phone,
  margin in a single stable asset (AUSD).

**What's live on Monad testnet.** *(Before submitting, cut any line below that isn't true on Monad testnet.)*

- `ParaclrClearinghouseDemo`, `NaiveClearinghouseDemo`, `MockOracle` and `MockAUSD` at
  `[TBD: addresses from deployments/10143.json]`.
- Real deposits, positions and closes from the web app (desktop or mobile).
- A keeper that pushes prices on-chain, sweeps every lane's auctions every block, and runs the flash crash.
- The clearing screen with per-lane auctions, the Conflict X-ray, the backstop tab and the solvency badge.

**Measured results** (Monad testnet, from `bench/results/10143-[TBD].json` and `bench/xray/10143-[TBD].json`):

| Accounts | Went to auction | Taken by backstop / external / cured / expired | Avg discount | Time underwater p50 / max | Equity returned to traders | Old fixed-fee counterfactual |
|---|---|---|---|---|---|---|
| `[TBD]` | `[TBD]` | `[TBD]` | `[TBD] bps` | `[TBD] / [TBD] blocks ([TBD] ms max)` | `[TBD] AUSD` | `[TBD] AUSD` |

| Conflict X-ray (`[TBD: method]`) | Txs | Dependency edges | Across lanes | Longest chain |
|---|---|---|---|---|
| Paraclr lanes | `[TBD]` | `[TBD]` | `[TBD]` | `[TBD]` |
| Naive shared state | `[TBD]` | `[TBD]` | `[TBD]` | `[TBD]` |

Time underwater runs from the shock block to the block each account was resolved; the ms figure is on the keeper's
clock and includes RPC round trips. The counterfactual is what the previous close-at-mark, 1%-fee path would have
taken from the same traders, computed by the keeper. Report both numbers as they are; don't pre-judge which is
smaller.

**Honest scope.**

- Prices are a simulated feed pushed on-chain. AUSD is a 6-decimal testnet stand-in (`MockAUSD`), not Agora's token.
- The ~500 crash-run accounts are synthetic, seeded by a demo-only `seedAccounts`. Backstop pools are seeded by the
  operator with test AUSD.
- MEV-resistant pricing, not MEV-free. Backstop exposure is reduced by an operator/keeper role, not a market.
- The X-ray shows dependencies, not Monad's re-execution counts.
- Unaudited. Scoped session keys aren't implemented. The Chainlink Data Streams adapter is unit-tested against a mock
  verifier only. The app's "Simulated" mode is labelled as such.

**Partner tech used.**

- **Monad testnet**: the contracts, every measured run and the X-ray.
- **Privy**: passkey (WebAuthn) login and an embedded wallet on Monad testnet.
- **AUSD**: the single quote and margin asset in the design. A testnet stand-in is used for now.
- Not used in the live demo: Chainlink (adapter only).

**What's next.**

1. Real AUSD and a live price source in the liquidation path.
2. A market for backstop exposure instead of an operator `backstopReduce`.
3. Per-lane auction parameters tuned from measured time-underwater data.
4. Funding rates and trading fees.
5. Lane rebalancing for skewed account distributions.
6. Scoped session keys so placing an order never needs a signature prompt.
7. Mainnet readiness: audits and keeper decentralisation.

**Links:**

- Repo: `[LINK: repo]`
- Demo video: `[LINK: video]`
- Live app: `[LINK: app]`, or "video only" if the keeper isn't publicly hosted
- Contracts: `[LINK: explorer]`

---

## 2. Submission checklist

### Product

- [ ] Both clearinghouses deployed to Monad testnet. `deployments/10143.json` (with the `naive` key) is committed and
      the addresses are in the README table.
- [ ] Contracts verified on the explorer, if it supports verification. If not, link the source in the README.
- [ ] At least one Monad testnet auction bench run (`npm run bench -- --accounts 500 --yes`). Both
      `bench/results/10143-*.json` and `bench/xray/10143-*.json` are committed. The landing page picks them up on the
      next build: check that its Results and X-ray sections switch to "Monad testnet".
- [ ] The README Results tables and the write-up tables above are filled from those files. Spot-check every number.
- [ ] The X-ray `method` is written next to every X-ray number (live trace vs anvil-fork replay).
- [ ] Backstop pools on Monad are seeded, and the min discount is the documented default (75 bps) or the docs say
      otherwise.
- [ ] Decide on the demo: a hosted app plus a publicly reachable keeper (`KEEPER_CORS_ORIGIN`, faucet rate limit, a
      funded faucet key), or video-only for the crash run. Say which in the profile.
- [ ] Keeper EOAs are funded with testnet MON: operator, price pusher, faucet, and 8 lane keepers. Check balances the
      day you record.

### Honesty and copy

- [ ] No "no MEV", "MEV-free", "no gas wars" anywhere (site, app, README, video, posts). `grep -ri "mev-free\|no mev\|gas war"`.
- [ ] No APY for backstop pools; "earned since deploy" only.
- [ ] UI says "8 conflict-free lanes" / "Lane N" everywhere, never "Monad threads".
- [ ] Every on-chain number in the UI says "Monad testnet" or "local anvil (not Monad)". Simulation numbers say
      "Simulated".
- [ ] No competitor names, no partnership or endorsement wording.

### Profile and materials

- [ ] Write-up (section 1) pasted into the project profile, placeholders filled or the lines cut.
- [ ] Demo video (section 3), 2:30–3:00, captions on, uploaded (unlisted YouTube or Loom) and linked.
- [ ] Repo is public, the README is the front page, and the landing page OG card shows the fair-liquidation headline.
- [ ] A LICENSE file is added (owner's choice, e.g. MIT).
- [ ] Track: Onchain Finance & Trading. Sponsor prizes (Agora, Privy, Perpl) selected where the form allows, after
      checking each one's criteria. Agora in particular may expect real AUSD.
- [ ] Team names and contact details filled in.

### Build-window evidence

- [ ] Git history shows the work happened in the build window. Commit in logical pieces (contracts, keeper, frontend,
      landing/docs, bench + X-ray evidence) well before Oct 13. Don't rewrite or squash history.
- [ ] Bench and X-ray JSONs carry their run ids and timestamps, and their tx hashes resolve on the explorer.

### Security hygiene

- [ ] No private keys in git. `.env*` is ignored. Check `keeper/.env` and any deploy `PRIVATE_KEY`.
- [ ] The demo burner key is labelled in the UI as a throwaway testnet key.

---

## 3. Demo video script (target 2:45, hard max 3:00)

The cut: **trade → crash → auctions resolve per lane in seconds → trader keeps equity → X-ray side by side → solvency
green.**

Recording rules:

- Record the crash on **Monad testnet**. Every number in the voice-over comes from that run's on-screen card or its
  committed JSON. If you re-record, re-read the numbers.
- Keep the network badge on screen during every on-chain shot. Keep the X-ray method label in frame.
- Burn in captions. Don't say "no MEV", "instant" or "zero conflicts"; say what was measured.

Placeholders (all from one `bench/results/10143-*.json` and its `bench/xray/10143-*.json`): `[STARTED]` =
`auctions.started`, `[BACKSTOP]` = `auctions.takenByBackstop`, `[P50]` / `[MAXB]` = `underwater.p50Blocks` /
`underwater.maxBlocks`, `[MAXMS]` = `underwater.maxMs`, `[RETURNED]` = `auctions.traderResidualReturned` (AUSD),
`[LEGACY]` = `auctions.legacyCounterfactual.traderLoss` (AUSD), `[E_LANES]` / `[E_NAIVE]` = each design's
`summary.crossLaneEdges` (always call them cross-lane edges; within-lane edges exist by design), `[METHOD]` = `method`.

| Time | Shot | Voice-over (draft) | On-screen text |
|---|---|---|---|
| 0:00–0:12 | Landing hero: the auction board animating | "When a market crashes, liquidation is a race: the first bot to land takes a fixed penalty, and the trader pays it. Paraclr replaces the race with a clock." | Paraclr: fair liquidations for Monad |
| 0:12–0:32 | Sign in with a passkey, faucet toast; trade screen, MON/AUSD 10x, open the long; pending → confirmed with explorer link | "Sign in with a passkey, no seed phrase. Open a 10x long. That's a real deposit and openPosition on Monad testnet, read back from the contract. Prices come from our on-chain oracle, fed by a simulated feed." | Monad testnet · simulated price feed · test AUSD |
| 0:32–0:45 | Clearing screen, Live, 8 lanes with account counts. Tap "Flash crash on Monad" | "Now the crash: one oracle transaction drops every market 20%. [STARTED] accounts are underwater across eight lanes." | Measured on Monad testnet |
| 0:45–1:15 | Lanes: in-auction cells, discount ticking, backstop takes lane by lane; time-underwater metric | "Every block, each lane's sweeper puts its underwater accounts into a Dutch auction. The discount starts at zero and rises 25 basis points a block; gas can't buy a bigger one. At 150, each lane's backstop pool takes. [BACKSTOP] accounts went to backstops. Median time underwater: [P50] blocks; the longest, [MAXB] blocks, [MAXMS] milliseconds on the keeper's clock." | discount set by the block clock, not by gas bidding |
| 1:15–1:35 | Result card: equity returned vs the old fixed-fee counterfactual. If the demo account was taken, its banner and leftover collateral | "Traders get back whatever the auction didn't use: [RETURNED] AUSD across this crash. For comparison, our old fixed-fee path would have taken [LEGACY] AUSD from the same accounts." *(Read both numbers as they are.)* | trader keeps E − P |
| 1:35–2:05 | Conflict X-ray panel: lanes graph vs naive graph, method label | "Here's the part we don't ask you to take on trust. We traced every transaction that resolved the crash, then ran the identical crash on a naive build of the same contract with every per-lane total on one storage key. An edge means a later transaction in the same block read something an earlier one wrote, which is when Monad has to re-execute. Lanes: [E_LANES] edges. Naive: [E_NAIVE]. This is a dependency map, not Monad's internal re-execution count." | Conflict X-ray · [METHOD] |
| 2:05–2:20 | Header solvency badge green; open the detail panel; then the Backstop tab | "And the books balance: the app checks solvency every block, AUSD held against every lane's ledger. The backstop LPs who took these auctions see what they earned since deploy, and the exposure they now carry." | Solvent · earned since deploy |
| 2:20–2:35 | Terminal: `forge test` (ParallelSafety + invariant suite) passing; flash `bench/results/10143-…json` and `bench/xray/10143-…json` | "The storage isolation is a Foundry test, the solvency identity is an invariant test, and every run's raw data is committed to the repo." | `vm.record` · invariant tests · raw JSON |
| 2:35–2:50 | Landing page Results + X-ray sections; repo URL | "Testnet only: test AUSD, simulated prices, seeded accounts, and auction pricing that's MEV-resistant, not MEV-free. Code, results and the X-ray are on GitHub." | [LINK: repo] |

### Shot list to capture

1. Landing hero with the auction board animating (desktop, 1440 wide).
2. Passkey login in a desktop browser or on a phone, trimmed tight, then the faucet toast.
3. Opening a trade through pending and confirmed, with the explorer link visible.
4. The full crash on Monad testnet: button tap, per-lane auctions ticking and resolving, result card. Record 2–3 runs
   and keep the cleanest; the X-ray must be from the same run.
5. The result card's equity-returned and counterfactual numbers, readable.
6. The Conflict X-ray panel, both graphs, method label in frame.
7. The solvency badge and its detail panel; the Backstop tab.
8. `forge test --match-test ParallelSafety -vvv` and the invariant suite output.
9. The bench and X-ray JSON open in an editor (`auctions`, `underwater`, `designs[].summary` visible).
10. The landing page Results and X-ray sections after the Monad files are committed and the site rebuilt.
