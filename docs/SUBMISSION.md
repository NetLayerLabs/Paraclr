# Paraclr: Monad Metropolis submission pack

Status: **DRAFT.** Human review before anything is submitted. Bracketed `[TBD]` / `[N]` placeholders are filled
**only** from committed `bench/results/*.json`, `bench/xray/*.json`, `deployments/10143.json` and
`deployments/143.json`. Never estimate them.

**Two possible submissions.** A capped, unaudited real-money beta on Monad mainnet ships only if its launch gate passes
(`docs/PRODUCTION_PLAN.md`). Decide which variant to submit on the day, from the repo, not from hopes:

- **Variant L (launched):** `deployments/143.json` is committed with `"production": true`. Use every "[L]" line below.
- **Variant T (testnet / no value):** no such file. Use every "[T]" line and cut the "[L]" ones. The submission is the
  testnet/anvil demo and nothing in it claims real money.

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

Honesty rules for everything below (from `docs/FAIR_LIQUIDATION_PLAN.md` and `docs/PRODUCTION_PLAN.md`):
"auction-priced" and "MEV-resistant pricing", never "no MEV" or "no gas wars"; the X-ray shows dependencies, not
Monad's re-execution counts, and always names its method; anvil is never Monad; backstop returns are "earned since
deploy", never APY; no competitor names. Never "audited", "safe" or "guaranteed": the audit status is "not audited:
internal review and Slither only". Real-money wording only in Variant L, always with the label **"Unaudited beta ·
capped · use only what you can afford to lose."**

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
- **A production set behind a launch gate.** The same auctions, backstops and solvency ledgers in a separate contract
  set built for real money: Agora AUSD as collateral, Pyth prices verified on chain (staleness, confidence, positive
  price), delayed orders that fill at the first Pyth price published after a minimum delay (so neither the trader nor
  the executor picks the price, which closes the classic oracle front-run), trading and execution fees, funding from
  the global skew, hard caps, a timelock owner driven by a multisig, and a pause-only guardian.

**Production beta status.**

- **[L]** Live on Monad mainnet (chain 143) as a capped, unaudited beta: `[TBD: clearinghouse address from
  deployments/143.json]` ([LINK: Monadscan]). Caps: `[TBD: max leverage, deposit cap per account, TVL cap per lane,
  OI cap per lane and market, from deployments/143.json]`. Timelock delay `[TBD]`. It launched after the launch gate:
  the full Foundry suite with invariants, Slither with every high/medium fixed or justified (`[LINK: notes]`), an
  adversarial internal review with criticals fixed (`[LINK: notes]`), and a rehearsal on a fork of Monad mainnet.
  **Not audited: internal review and Slither only. Unaudited beta · capped · use only what you can afford to lose.**
- **[T]** The production set is built and tested but **not deployed**: it didn't clear its launch gate in time
  (`[TBD: which check, in one honest sentence]`), so this submission is the testnet / no-value demo. Production ships
  after an external audit. Nothing of ours is on Monad mainnet.

**What's live on Monad testnet.** *(Before submitting, cut any line below that isn't true on Monad testnet.)*

- `ParaclrClearinghouseDemo`, `NaiveClearinghouseDemo`, `MockOracle` and `MockAUSD` at
  `[TBD: addresses from deployments/10143.json]`.
- Real deposits, positions and closes from the web app (desktop or mobile).
- A keeper that pushes prices on-chain, sweeps every lane's auctions every block, and runs the flash crash.
- The clearing screen with per-lane auctions, the Conflict X-ray, the backstop tab and the solvency badge.

**Measured results.** Every number below is from a committed file; the mainnet beta, if live, isn't benchmarked
here (no synthetic accounts or crashes on mainnet).

Monad testnet (from `bench/results/10143-[TBD].json` and `bench/xray/10143-[TBD].json`):

| Accounts | Went to auction | Taken by backstop / external / cured / expired | Avg discount | Time underwater p50 / max | Equity returned to traders | Old fixed-fee counterfactual |
|---|---|---|---|---|---|---|
| `[TBD]` | `[TBD]` | `[TBD]` | `[TBD] bps` | `[TBD] / [TBD] blocks ([TBD] ms max)` | `[TBD] AUSD` | `[TBD] AUSD` |

| Conflict X-ray (`[TBD: method]`) | Txs | Dependency edges | Across lanes | Longest chain |
|---|---|---|---|---|
| Paraclr lanes | `[TBD]` | `[TBD]` | `[TBD]` | `[TBD]` |
| Naive shared state | `[TBD]` | `[TBD]` | `[TBD]` | `[TBD]` |

Local anvil, **not Monad** (committed today; anvil executes sequentially, so this checks the mechanism end to end and
says nothing about Monad's parallel execution). 500 seeded synthetic accounts plus 24 keeper-run demo takers; every
external take was made by those bots:

| Run | Shock | Went to auction | Backstop / external (demo bots) / cured / expired | Avg discount | Time underwater p50 / max | Taken from traders: auction vs old fixed-fee path |
|---|---|---|---|---|---|---|
| `bench/results/31337-2026-10-06T22-54-24Z.json` | −20% | 96 | 80 / 13 / 0 / 3 | 76.61 bps | 4 / 21 blocks | 4,642.19 vs 7,082.64 AUSD |
| `bench/results/31337-2026-10-06T22-54-58Z.json` | −5% | 7 | 1 / 6 / 0 / 0 | 64.29 bps | 4 / 4 blocks | 2,937.70 vs 4,526.41 AUSD |

| Conflict X-ray, local anvil · live `debug_traceTransaction` (−20% run, `bench/xray/31337-run-muxa08r6-x9rft.json`) | Txs | Dependency edges | Across lanes | Longest chain |
|---|---|---|---|---|
| Paraclr lanes | 52 | 34 | 0 | 4 |
| Naive shared state | 49 | 311 | 277 | 18 |

In the −20% run the lane-funded shortfall (`auctions.badDebt`: lane insurance, then lane bad debt, covering backstop
takes where the payment exceeded the account's equity) was 292,780.30 AUSD; in the −5% run it was 0. Say so if asked.

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
- Not audited: internal review and Slither only. Scoped session keys aren't implemented. The Chainlink Data Streams
  adapter is unit-tested against a mock verifier only. The app's "Simulated" mode is labelled as such.
- **[L]** The mainnet beta is capped and run by one operator's keepers (anyone can execute orders and auctions, nobody
  must). `/terms` and `/risk` are drafts pending legal review. The landing's results and X-ray come from the demo stack,
  not mainnet.

**Partner tech used.**

- **Monad testnet**: the contracts, every measured run and the X-ray.
- **Privy**: passkey (WebAuthn) login and an embedded wallet on Monad testnet.
- **AUSD**: the single quote and margin asset. The demo uses a testnet stand-in. **[L]** Real Agora AUSD is the
  collateral on the mainnet beta.
- **Pyth**: verified on-chain prices for the production set. **[T]** Used in the mainnet-fork rehearsal only.
- Not used anywhere live: Chainlink (adapter only).

**What's next.**

1. An external audit before any cap goes up. **[T]** Before any mainnet deploy at all.
2. A market for backstop exposure instead of an operator `backstopReduce`.
3. Per-lane auction parameters tuned from measured time-underwater data.
4. Lane rebalancing for skewed account distributions.
5. Scoped session keys so placing an order never needs a signature prompt.
6. Keeper decentralisation: more independent executors and sweepers.

**Links:**

- Repo: `[LINK: repo]`
- Demo video: `[LINK: video]`
- Live app: `[LINK: app]`, or "video only" if the keeper isn't publicly hosted
- Contracts: `[LINK: explorer]` (testnet). **[L]** Mainnet: `[LINK: Monadscan clearinghouse]`
- Risk disclosure and terms (drafts): `[LINK: app]/risk`, `[LINK: app]/terms`

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
- [ ] No "audited" (except "not audited" / "unaudited"), "safe", or "guaranteed" claims.
      `grep -rniE "\baudited\b|\bsafe\b|guarantee" src docs README.md` and read every hit.
- [ ] No real-money claim anywhere unless `deployments/143.json` exists with `"production": true`.
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

### Production beta (only for Variant L)

- [ ] Launch gate evidence is committed or linked: `forge test` output for the production set (incl. invariants), the
      Slither report with every high/medium fixed or justified in writing, the adversarial review notes with criticals
      fixed, and the mainnet-fork rehearsal log. Nothing launches without all of it.
- [ ] `deployments/143.json` is committed with `"production": true`; the landing page, rebuilt, shows "Live on Monad
      mainnet · unaudited beta · capped" and the contract table, and every Monadscan link resolves.
- [ ] The caps, fees, delays and timelock delay on the landing page match the on-chain values (the app reads them on
      chain; the landing page reads the deployment file).
- [ ] Ownership is the timelock; the multisig is its proposer/executor; the deployer has no roles left. Checked on chain.
- [ ] Guardian pause and timelock unpause verified in the mainnet-fork rehearsal: deposits and increase orders
      blocked while paused, withdrawals, closes and liquidations still working.
- [ ] Keeper hosted per `keeper/HOSTING.md`, alerts reach `ALERT_WEBHOOK_URL`, hot keys funded; runbook rehearsed.
- [ ] `/terms` and `/risk` reviewed by a lawyer, placeholders (`[OPERATOR]`, jurisdictions, contact) filled, and the
      DRAFT banner removed only after that review. If there's no legal review in time, don't launch.
- [ ] "Unaudited beta · capped · use only what you can afford to lose" appears on the landing page, in the app banner,
      before the first deposit, in the write-up and in every mainnet post.

### Security hygiene

- [ ] No private keys in git. `.env*` is ignored. Check `keeper/.env` and any deploy `PRIVATE_KEY`.
- [ ] The demo burner key is labelled in the UI as a throwaway testnet key.

---

## 3. Demo video script (target 2:45, hard max 3:00)

The cut: **trade → crash → auctions resolve per lane in seconds → trader keeps equity → X-ray side by side → solvency
green → [L] the same mechanism live on mainnet, capped / [T] the launch gate it's waiting on.**

Recording rules:

- Record the crash on **Monad testnet** if `deployments/10143.json` and a `bench/results/10143-*.json` exist. If not,
  record on local anvil and say "local anvil, not Monad" for every number; keep the badge in frame.
- Every number in the voice-over comes from that run's on-screen card or its committed JSON. If you re-record, re-read
  the numbers.
- Keep the network badge on screen during every on-chain shot. Keep the X-ray method label in frame.
- **Never crash, seed or demo-trade on mainnet.** The mainnet segment shows the landing status strip, the contract table,
  the app's beta banner and risk acknowledgement, and at most one small real trade by the team, with its Monadscan link.
- Burn in captions. Don't say "no MEV", "instant", "zero conflicts", "safe", "audited" or "guaranteed"; say what was
  measured, and "not audited: internal review and Slither only".

Placeholders (all from one `bench/results/<chain>-*.json` and its `bench/xray/<chain>-*.json`): `[STARTED]` =
`auctions.started`, `[BACKSTOP]` = `auctions.takenByBackstop`, `[P50]` / `[MAXB]` = `underwater.p50Blocks` /
`underwater.maxBlocks`, `[MAXMS]` = `underwater.maxMs`, `[TAKEN]` = (`auctions.traderEquityAtStart` −
`auctions.traderResidualReturned`) in AUSD, `[LEGACY]` = `auctions.legacyCounterfactual.traderLoss` (AUSD),
`[E_LANES]` / `[E_NAIVE]` = each design's `summary.crossLaneEdges` (always call them cross-lane edges; within-lane edges
exist by design), `[METHOD]` = `method`, `[NET]` = "Monad testnet" or "local anvil, not Monad". Mainnet values
(`[CAP]`, `[LEV]`, `[DELAY]`) come from `deployments/143.json` and must match what the app shows on chain.

| Time | Shot | Voice-over (draft) | On-screen text |
|---|---|---|---|
| 0:00–0:10 | Landing hero: the auction board animating, status strip in frame | "When a market crashes, liquidation is a race: the first bot to land takes a fixed penalty, and the trader pays it. Paraclr replaces the race with a clock." | Paraclr: fair liquidations for Monad |
| 0:10–0:27 | Sign in with a passkey, faucet toast; trade screen, MON/AUSD 10x, open the long; pending → confirmed | "Sign in with a passkey, no seed phrase. Open a 10x long. That's a real deposit and openPosition on [NET], read back from the contract, with test AUSD and a simulated price feed." | [NET] · simulated price feed · test AUSD |
| 0:27–0:38 | Clearing screen, Live, 8 lanes with account counts. Tap the flash-crash button | "Now the crash: one oracle transaction drops every market 20%. [STARTED] accounts are underwater across eight lanes." | Measured on [NET] |
| 0:38–1:05 | Lanes: in-auction cells, discount ticking, backstop takes lane by lane; time-underwater metric | "Every block, each lane's sweeper puts its underwater accounts into a Dutch auction. The discount starts at zero and rises 25 basis points a block; gas can't buy a bigger one. At 75, three blocks in, each lane's backstop pool takes. [BACKSTOP] accounts went to backstops. Median time underwater: [P50] blocks; the longest, [MAXB] blocks, [MAXMS] milliseconds on the keeper's clock." | discount set by the block clock, not by gas bidding |
| 1:05–1:22 | Result card: what the auction took vs the old fixed-fee counterfactual | "The auction took [TAKEN] AUSD from these traders; our old fixed-fee path would have taken [LEGACY] from the same accounts. Everything else came back to them as free collateral." *(Read both numbers as they are.)* | trader keeps E − P |
| 1:22–1:48 | Conflict X-ray panel: lanes graph vs naive graph, method label | "We traced every transaction that resolved the crash, then ran the identical crash on a naive build of the same contract with every per-lane total on one storage key. An edge means a later transaction in the same block touched something an earlier one wrote, which is when Monad has to re-execute. Cross-lane edges: lanes [E_LANES], naive [E_NAIVE]. A dependency map, not Monad's internal re-execution count." | Conflict X-ray · [METHOD] |
| 1:48–2:00 | Header solvency badge green; detail panel; Backstop tab | "The books balance every block: AUSD held against every lane's ledger. Backstop LPs see what they earned since deploy, and the exposure they carry." | Solvent · earned since deploy |
| 2:00–2:12 | Terminal: `forge test` (ParallelSafety + invariants + the production suite) passing; the committed JSON | "Storage isolation is a Foundry test, solvency is an invariant test, and every run's raw data is in the repo." | `vm.record` · invariant tests · raw JSON |
| 2:12–2:40 **[L]** | Landing status strip "Live on Monad mainnet · unaudited beta · capped" → contract table → app: beta banner, risk acknowledgement, a delayed order going submitted → filled with its Monadscan link | "The same mechanism is live on Monad mainnet as a small beta: real Agora AUSD, Pyth prices verified on chain, and delayed orders, so nobody picks the price they fill at. Deposits are capped at [CAP], leverage at [LEV], every change waits [DELAY] in a timelock, and a guardian can only pause. It is not audited: internal review and Slither only. Use only what you can afford to lose." | Unaudited beta · capped · use only what you can afford to lose |
| 2:12–2:30 **[T]** | Landing "Mainnet beta" section: the five-step launch gate, "pending" badge | "A real-money version is built: real AUSD, Pyth, delayed orders, caps, a timelock. It goes to mainnet only if all five checks pass, and it isn't there yet. Until then, this is a testnet build with nothing at stake." | Mainnet beta: pending launch gate |
| 2:40–2:50 ([T]: 2:30–2:40) | Landing Results + X-ray sections; repo URL | "MEV-resistant pricing, not MEV-free. Code, results and the X-ray are on GitHub." | [LINK: repo] |

### Shot list to capture

1. Landing hero with the auction board animating and the status strip (desktop, 1440 wide).
2. Passkey login in a desktop browser or on a phone, trimmed tight, then the faucet toast (testnet/anvil only).
3. Opening a trade through pending and confirmed, with the explorer link visible.
4. The full crash on Monad testnet (or local anvil, labelled): button tap, per-lane auctions ticking and resolving,
   result card. Record 2–3 runs and keep the cleanest; the X-ray must be from the same run.
5. The result card's auction-vs-counterfactual numbers, readable.
6. The Conflict X-ray panel, both graphs, method label in frame.
7. The solvency badge and its detail panel; the Backstop tab.
8. `forge test --match-test ParallelSafety -vvv`, the invariant suite, and the production suite output.
9. The bench and X-ray JSON open in an editor (`auctions`, `underwater`, `designs[].summary` visible).
10. The landing page Results and X-ray sections after the files are committed and the site rebuilt.
11. **[L]** The status strip and "Mainnet beta" section (contracts, limits, who can do what), the app's beta banner and
    risk acknowledgement, one small delayed order filled on mainnet with its Monadscan link. **[T]** The "Mainnet beta"
    section with the launch gate and the "pending" badge.
