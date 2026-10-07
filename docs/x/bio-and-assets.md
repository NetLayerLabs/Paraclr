# Bio, pinned post, hashtags, shot list, reply templates

Status: DRAFT. Handles are unverified placeholders; see the verification table in `launch-thread.md`. We're building
*for* the Monad Metropolis hackathon and its sponsor prizes. Never imply a partnership or endorsement. Positioning
rules from `launch-thread.md` apply: auction-priced / MEV-resistant (never "no MEV"), X-ray = dependencies (never
re-execution counts), backstop returns "earned since deploy" (never APY), lanes not threads, no competitor names.

## Profile bio options (each must be 160 chars or fewer; counted by `docs/x/count.py`)

1. (148 chars) `The fair-liquidation clearinghouse for Monad. Per-block auctions in 8 lanes, backstop LPs, traders keep their equity. Building for Monad Metropolis.`
2. (126 chars) `Liquidations priced by the block clock, not gas bidding. Backstop LPs per lane, a Conflict X-ray per crash. Building on Monad.`
3. (136 chars) `Paraclr: fair liquidations on Monad testnet. Auctions per lane, solvency checked every block, AUSD margin (test token). Hackathon build.`

4. (121 chars) `Fair liquidations on Monad. Capped, unaudited mainnet beta: real AUSD, Pyth prices. Use only what you can afford to lose.`

Bio 3 says "Monad testnet", so use it only after the testnet deploy. Bio 4 is for after the mainnet beta launches
(`deployments/143.json` with `"production": true`); never before. Until then, use bio 1.

Name field suggestion: `Paraclr` (optionally `Paraclr | fair liquidations`).
Link field: the repo or demo URL once it's public. Until then, leave it blank.

## Pinned post

Pin the **launch thread** (`launch-thread.md`, Version A). Once a measured Monad testnet auction run exists,
quote-tweet the thread with the Version B 1/8 hook plus the crash clip, and pin that instead. After submission, pin the
submission post (build log, Oct 12).

## Hashtags: use sparingly

- Default: **zero hashtags.**
- If the organizers publish an official hashtag, use it **once**: on the launch thread's first or last post, and on
  the submission post. Placeholder: `[HASHTAG: official Monad Metropolis tag, verify]`.
- Never stack generic tags.

## Shot list: capture from the app and the landing page

Record the desktop at 1440×900 (and a phone for the mobile shots) at native resolution, from a clean state. **Label
every clip with its source:** "Monad testnet", "local anvil (not Monad)", "Simulated" or "Illustration". The network
badge should be in frame.

| # | Asset | Type | Length / notes | Used in |
|---|---|---|---|---|
| 1 | Landing hero auction board (0 → 75 bps, lanes resolving) | Video | 8–10 s loop, "Illustration" tag visible | Launch 1/8 |
| 2 | Discount-by-block staircase (landing "How the auction works") | Image | Crop the chart card | Launch 2/8, build log Oct 7 |
| 3 | Live crash on **Monad testnet**: crash button, per-lane auctions ticking and resolving, result card | Video | 15–25 s, badge visible, numbers readable | Launch B 1/8, build log Oct 10, demo video |
| 4 | Result card: equity returned vs old fixed-fee counterfactual | Screenshot | Same run as #3 | Launch B 7/8, demo video |
| 5 | Conflict X-ray, lanes vs naive, method label in frame | Image | From a committed JSON only; anvil or Monad strip visible | Launch 6/8 / B 6/8, build log Oct 9 + 11, deep dive 8/10 |
| 6 | Solvency badge + detail panel | Screenshot | App header, network badge in frame | Build log Oct 8, demo video |
| 7 | Backstop tab: NAV, earned since deploy, absorbed, exposure | Screenshot | No APY anywhere in frame | Launch 4/8, demo video |
| 8 | Write-set matrix, naive vs lanes (landing "The engine") | Image | Crop both panels | Deep dive 7/10 |
| 9 | Passkey login → swipe to open 10x MON/AUSD | Video | ~8 s | Launch alt 6/8, demo video |
| 10 | `forge test` (ParallelSafety + invariant suite) passing | Screenshot | Crop tight | Build log Oct 8, demo video |
| 11 | `bench/results/10143-*.json` + `bench/xray/10143-*.json` open | Screenshot | `auctions`, `underwater`, `designs[].summary` visible | Demo video |
| 12 | Full demo walkthrough | Video | 2:30–3:00, captions burned in. Script: `docs/SUBMISSION.md` §3 | Build log Oct 12, submission |

Profile header: a 1500×500 crop of the landing hero (shot 1, last frame) or of the X-ray section (shot 5).
Avatar: the Paraclr mark (`src/app/icon.svg`).

## Reply templates

Principles: add information, one reply per relevant post, never ask for retweets, never imply a sponsor is involved.
All counts include `[LINK]` at 23 chars.

**"Is this MEV-free?"** (256 chars)

```
No, and we don't claim it. Pricing is MEV-resistant: the discount comes from the block clock, so out-bidding on gas can't buy a bigger one, only an earlier take at a smaller one. Ordering inside a block still matters. That competition pushes takes earlier.
```

**"What does a liquidated trader lose?"** (274 chars)

```
The taker's payment, P = discount × notional, at the block it's taken. The rest of their equity, E − P, comes back as free collateral. If E < P, lane insurance tops up the backstop pool, never an outside taker. Never more than E. Recover first and you can cure the auction.
```

**"What APY do backstop LPs get?"** (224 chars)

```
We don't quote one. Pools earn the auction discount and carry the positions they inherit, and that income comes in crashes, so an APY would be made up. The app shows what each pool has earned since deploy, plus its exposure.
```

**"Does the X-ray show Monad's re-executions?"** (249 chars)

```
No. Those aren't observable from outside the node. It shows read/write dependencies between txs in the same block, which is the condition under which Monad re-executes. Each X-ray says how it was collected: a live trace or a local anvil-fork replay.
```

**"Do your contracts run on Monad's threads?" / "8 threads?"** (244 chars)

```
No. Contracts can't choose Monad's execution threads. Our 8 lanes are a storage layout: everything resolving an account writes lives in its lane, so lanes' auction txs don't share writes and Monad has no reason to re-run one because of another.
```

**"Is this live / on mainnet?", after the mainnet beta launches** (207 chars)

```
Yes, as a small capped beta on Monad mainnet with real AUSD. Not audited: internal review and Slither only. Check the contract addresses on our landing page before approving anything: [LINK: landing contracts]
```

**"Is this live / on mainnet?", testnet deployed, mainnet gate not passed** (215 chars)

```
Testnet, not mainnet. A capped mainnet beta launches only if every check in our launch gate passes, and it hasn't yet. Nothing of ours is on mainnet; anything claiming to be is fake. Testnet: [LINK: explorer]
```

**"Is this live / on mainnet?", after the testnet deploy** (220 chars)

```
Testnet, not mainnet. The clearinghouse is on Monad testnet ([LINK: explorer]) and the app trades against it. AUSD is a test token, prices are a simulated feed pushed on-chain, and it's unaudited. Hackathon build.
```

**"Is this live / on mainnet?", before the testnet deploy** (161 chars)

```
Not yet. It's a hackathon build: contracts and keeper run on a local chain today, labelled as such, and Monad testnet is next. We'll post the measured runs here.
```

**"Which oracle do you use?"** (240 chars)

```
In the on-chain demo, prices are a simulated feed pushed to an on-chain oracle, and the crash is a real −20% oracle tx. A Chainlink Data Streams adapter is written and unit-tested against a mock verifier only. It isn't live, and we say so.
```

**When Monad posts about parallel execution** (220 chars)

```
This is the rule we designed around: txs that don't share writes don't need re-execution. Our liquidation auctions keep their state per lane, and we publish the measured dependency graph of every crash to show it. [LINK]
```

**When Privy posts about passkeys / embedded wallets** (151 chars)

```
Passkeys are why our mobile onboarding has no seed phrase screen. Passkey in, embedded wallet on Monad testnet, swipe to trade. Hackathon build: [LINK]
```

**"Are you partnered with X?"** (111 chars)

```
No. We're building for the hackathon and its sponsor prizes, using public tools. No affiliation or endorsement.
```
