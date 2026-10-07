# Launch Thread: Paraclr, fair liquidations for Monad

Status: DRAFT. Nothing here has been posted. A human must review it before anything goes live.

## Before posting: verify every handle

The handles below are **unverified placeholders**. Open each profile on X and confirm it's the official, current
account before tagging. Handles change, and look-alike accounts exist.

| Partner | Placeholder handle(s) to check | Verified? |
|---|---|---|
| Monad | `@monad` / `@monad_xyz` | [ ] |
| Agora (AUSD) | `@withAUSD` / `@agora_finance` | [ ] |
| Privy | `@privy_io` | [ ] |
| Hackathon organizer account (Monad Metropolis) | `[HANDLE: hackathon organizer]` | [ ] |

Chainlink is deliberately left off: its Metropolis bounty is for CRE workflows, which we aren't building, and Data
Streams isn't live in our demo.

## Positioning rules (for this thread and everything in `docs/x/`)

- **Headline:** Paraclr is the fair-liquidation clearinghouse for Monad. Auction-priced liquidations, per-lane backstop
  LPs, traders keep their leftover equity, a measured Conflict X-ray, a live solvency proof. Lanes are the engine, not
  the headline.
- **Never** write "no MEV", "MEV-free" or "no gas wars". Write "auction-priced: the discount is set by the block clock,
  not by gas bidding" and "MEV-resistant pricing".
- **X-ray:** it shows storage read/write dependencies (the condition for Monad re-execution). It is **not** Monad's
  internal re-execution count. Name the method when quoting a number: "live trace" or "local anvil-fork replay".
- **Backstop returns:** "earned since deploy". Never APY, never a yield promise.
- **No competitor names**, no comparisons to named projects, no "first" claims.
- We're **building for** Monad Metropolis and its sponsor prizes. Never "partnered with", "backed by", "official".
- Say **lanes**, never "threads".
- **Numbers:** measured numbers only from a committed `bench/results/10143-*.json` / `bench/xray/10143-*.json`, and
  say "on Monad testnet". Anvil numbers say "local anvil, not Monad". No simulation timings in this thread.
- **Testnet honesty:** test AUSD (stand-in token), simulated price feed pushed on-chain, seeded synthetic accounts,
  operator-seeded backstop pools, unaudited, no session keys.
- **Mainnet beta:** never mention real money, mainnet or real AUSD as live unless `deployments/143.json` is committed
  with `"production": true`. Launch-day posts, the fallback if the launch gate fails, and replies are in
  `mainnet-beta.md`. Never "audited", "safe" or "guaranteed"; the label is "Unaudited beta · capped · use only what
  you can afford to lose".

Character counts are X-weighted lengths, measured by `docs/x/count.py`. A URL counts as 23. "Filled" is the worst-case
length after the `[PLACEHOLDERS]` are replaced (sizes in the script). Media placeholders sit outside the text blocks
and aren't counted.

---

## Version A: post now (before measured Monad testnet numbers exist)

### 1/8: hook (267 chars)

```
On-chain liquidation is a race. The first bot to land takes a fixed penalty, and the trader pays it however hard the bots competed.

We're building Paraclr, the fair-liquidation clearinghouse for Monad: a clock instead of a race, and receipts for every crash. Thread:
```

Media: `[VIDEO: landing hero auction board, 8 lanes ticking 0 → 75 bps, labelled "Illustration"]`

### 2/8: the auction (264 chars)

```
Every block, each underwater account goes to a Dutch auction. The discount starts at 0 and rises 25 bps per block.

A taker inherits the positions at the mark and is paid P = discount × notional. The trader keeps E − P as free collateral. Never loses more than E.
```

Media: `[IMAGE: the discount-by-block staircase from the landing page]`

### 3/8: MEV-resistant, not MEV-free (242 chars)

```
The price comes from the block clock, not from gas bidding. Out-bidding on gas can't buy a bigger discount, only an earlier take at a smaller one.

So: MEV-resistant pricing. Not MEV-free. Ordering inside a block still matters, and we say so.
```

### 4/8: backstop LPs (254 chars)

```
Who takes? Each of our 8 lanes has a backstop pool. LPs deposit AUSD; the pool takes that lane's auctions at 75 bps (about 3 blocks), earns the discount and carries the inherited positions.

Pool returns are shown as earned since deploy. Never as an APY.
```

### 5/8: lanes are the engine (271 chars)

```
Underneath: 8 lanes. An account's risk state, its auction, its lane's backstop pool and ledger all live in lane-local storage.

Monad (@monad) runs a block optimistically in parallel and re-executes a tx that read what an earlier one wrote. Lane takes don't share writes.
```

### 6/8: Conflict X-ray (270 chars)

```
"Conflict-free" shouldn't be taken on trust. After each crash we trace every tx's storage reads/writes, rerun the identical crash on a naive build of the same contract (shared keys), and publish both dependency graphs.

Dependencies, not Monad's internal re-exec counts.
```

Media: `[IMAGE: Conflict X-ray panel, lanes vs naive. Only once a real bench/xray file exists; label "local anvil, not Monad" or "Monad testnet"]`

### 7/8: solvency proof (219 chars)

```
And the books are checked every block. solvency() compares the AUSD the contract holds with the sum of all 8 lane ledgers: collateral + insurance + backstop cash + rewards owed − bad debt.

The app shows it as a badge.
```

### 8/8: CTA (257 chars)

```
Building Paraclr for Monad Metropolis. Testnet only: test AUSD, a simulated price feed, seeded accounts, unaudited.

Measured runs and X-rays go in the repo as JSON. Feedback welcome, especially on the auction parameters and where the backstop model breaks.
```

### Alt 6/8: phone + AUSD + Privy (if you'd rather show the terminal) (233 chars)

```
You trade it from a phone: passkey login via Privy (@privy_io), no seed phrase, swipe to open. Every pair is margined in AUSD (@withAUSD), one stable collateral when everything else moves.

Testnet uses a stand-in AUSD token for now.
```

---

## Version B: swap-ins once a Monad testnet auction run is committed

Fill every placeholder from **one** run: `bench/results/10143-*.json` and the `bench/xray/10143-*.json` with the same
run id. Use the same run in every post.

| Placeholder | JSON field |
|---|---|
| `[STARTED]` | `auctions.started` |
| `[BACKSTOP]` | `auctions.takenByBackstop` |
| `[CURED]` | `auctions.cured` |
| `[P50]` / `[MAXB]` | `underwater.p50Blocks` / `underwater.maxBlocks` |
| `[MAXMS]` | `underwater.maxMs` |
| `[RETURNED]` | `auctions.traderResidualReturned` ÷ 1e6, AUSD, rounded down |
| `[LEGACY]` | `auctions.legacyCounterfactual.traderLoss` ÷ 1e6, AUSD, rounded down |
| `[E_LANES]` / `[E_NAIVE]` | `designs[design=paraclr-lanes / naive-shared].summary.crossLaneEdges` (cross-lane edges, the lane claim; say "cross-lane" in the post) |
| `[XTXS]` | `designs[…].summary.txs` (same for both designs) |
| `[METHOD]` | `method`: write "live trace" for `debug_traceTransaction`, "local anvil-fork replay" for `anvil-fork-replay` |

### B 1/8: measured hook (262 chars; 249 when filled)

```
We crashed every market 20% on Monad testnet. [STARTED] accounts went underwater; each went to a per-block Dutch auction in its lane, and backstop pools took [BACKSTOP]. Longest time underwater: [MAXB] blocks.

Paraclr: fair liquidations for Monad. How it works:
```

### B 6/8: measured X-ray (270 chars; 274 when filled)

```
The Conflict X-ray of that crash ([METHOD], [XTXS] txs per design):

Paraclr lanes: [E_LANES] cross-lane dependency edges.
Same contract, shared storage keys: [E_NAIVE].

An edge = a tx touched a slot an earlier tx in its block wrote. Not Monad's internal re-exec count.
```

### B 7/8: what traders kept (246 chars)

```
What traders kept on Monad testnet: [RETURNED] AUSD of leftover equity across the crash. Our old fixed-fee path would have taken [LEGACY] AUSD from the same accounts.

Both from the run's on-chain events. Raw JSON in the repo, with every tx hash.
```

Reviewer note on B 7/8: read both numbers as they are. If the auction took more than the old fixed-fee path would
have, don't post B 7/8 as a "win"; use the plain 7/8 (solvency) instead and say what the numbers show elsewhere.

### B 8/8: CTA with links (248 chars)

```
Code, contracts, every run's raw data and both X-ray graphs: [LINK: repo]
The crash on the explorer: [LINK: explorer block]

Built for Monad Metropolis. Testnet, test AUSD, unaudited. Feedback welcome on the auction and backstop design.
```
