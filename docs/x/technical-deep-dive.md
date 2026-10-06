# Technical deep-dive thread: fair liquidations on Monad

Status: DRAFT. Before posting, whoever wrote the contracts and keeper must read this end to end and correct anything
that doesn't match the code. Handles are unverified placeholders; see the verification table in `launch-thread.md`.
Positioning rules from `launch-thread.md` apply to every post.

## Accuracy notes for the reviewer

- **Auction constants** are the contract defaults (owner-configurable): `auctionStepBps = 25`, cap 500 bps, backstop
  `minDiscountBps = 75`, maintenance 2.5%. If the deployed values differ, change the posts.
- **Expiry** goes through the old fixed-fee path (1% of notional) in the contract. Post 4 says so.
- **Monad's execution model, as publicly documented:** transactions in a block run optimistically in parallel and are
  committed in order; a tx that read state an earlier tx in the block wrote is re-executed. Result = sequential result.
  Check the current Monad docs before posting.
- **X-ray:** edges only inside one block (`edgeScope: "same-block"`), exclusions listed in each report, method named.
  It is not Monad's re-execution count. Never write "zero re-executions".
- **Not MEV-free.** Post 3 must keep its last sentence.

Character counts are X-weighted lengths, measured by `docs/x/count.py`, excluding media.

---

## Version A: post before measured Monad testnet numbers exist

### 1/10 (252 chars)

```
How do you make liquidations fair, and fast enough to matter, on a parallel EVM?

Paraclr's answer: price them with a clock instead of a race, give every lane a guaranteed taker, and publish the dependency graph of every crash.

A thread on the design:
```

### 2/10 (267 chars)

```
The usual design: an account goes underwater, bots race to liquidate it, the winner takes a penalty fixed in advance.

The penalty doesn't move with competition. The competition happens in gas and ordering, and none of it comes back to the trader whose account it is.
```

### 3/10 (272 chars)

```
Ours: a per-block Dutch auction. d = min(500, 25 × blocks since start), in bps.

A taker inherits the positions at the mark and is paid P = d × notional; the trader keeps E − P. Gas can't buy a bigger d, only an earlier take at a smaller one. MEV-resistant, not MEV-free.
```

### 4/10 (274 chars)

```
The edges:
- E < P: lane insurance covers the gap, then lane bad debt. A trader never loses more than E.
- Healthy again (top-up, price bounce): anyone can cancel the auction.
- Untaken at 500 bps: it expires through the old fixed-fee path.

The account is frozen meanwhile.
```

### 5/10 (268 chars)

```
Auctions need a taker in a crash. Each lane has a backstop pool: LPs deposit AUSD for shares at NAV, the pool takes at 75 bps if it can carry the positions, earns the discount and holds the exposure.

NAV = cash + unrealized PnL. Shown as earned since deploy, not APY.
```

### 6/10 (275 chars)

```
Now speed. Monad runs a block's txs optimistically in parallel and re-executes a tx that read a slot an earlier one wrote.

So a crash only resolves in parallel if the takes don't share writes. One global insurance fund or one backstop pool, and every take waits on the last.
```

### 7/10 (270 chars)

```
So we shard the state, not the market: lane = uint160(account) % 8. Insurance, bad debt, OI, backstop pool, auction state and the solvency ledger all exist once per lane.

8 sweeper keys, one per lane. Lanes are a storage layout, not threads: contracts can't pick those.
```

Media: `[DIAGRAM: write-set matrix, naive shared keys vs 8 lanes, from the landing page]`

### 8/10 (273 chars)

```
Then we check it instead of claiming it. The Conflict X-ray traces every resolution tx (debug_traceTransaction, prestateTracer) and draws an edge when a tx touched a slot an earlier tx in its block wrote.

Same crash on a naive build: same code, every aggregate on one key.
```

### 9/10 (269 chars)

```
And the books: solvency() checks AUSD held == Σ over 8 lanes (collateral + insurance + backstop cash + rewards owed − bad debt), covered by Foundry invariant tests and read by the app every block.

Global totals are views over lanes, so the hot path never writes them.
```

### 10/10, before measured numbers (257 chars)

```
Tradeoffs: one lane's txs still depend on each other; a skewed lane caps parallelism; backstop exposure is reduced by an operator for now; the X-ray maps dependencies, not Monad's re-exec counts.

Building for Monad Metropolis (@monad). Corrections welcome.
```

---

## Version B: swap-in once a Monad testnet auction run + X-ray are committed

Fill from **one** run (mapping in `launch-thread.md`, Version B).

### 10/10, measured (278 chars; 277 when filled)

```
Measured on Monad testnet: [STARTED] accounts to auction after a −20% shock, longest [MAXB] blocks underwater. X-ray ([METHOD]): [E_LANES] cross-lane edges for lanes, [E_NAIVE] for shared keys.

Not Monad's re-exec counts. Raw JSON + tx hashes in the repo. Corrections welcome.
```

Media: `[IMAGE: landing X-ray section with the Monad testnet strip and method label]`
