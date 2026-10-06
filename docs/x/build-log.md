# Build log: daily "build in public" posts, Oct 7–12

Status: DRAFT. A human reviews and posts each one. Handles are unverified placeholders; see the verification table in
`launch-thread.md`. Submissions close **Tue Oct 13**, and we aim to submit **Mon Oct 12**.

## Rules

- One post per day, ideally with media. Short beats clever. Reply to the launch thread with each entry so the log
  stays chained.
- **Every entry has a gate.** Post it only if the gate is true that day. If a gate slips, move the entry to a later
  day or post one whose gate is met. Never describe unbuilt work as done.
- Positioning rules from `launch-thread.md` apply: auction-priced / MEV-resistant, never "no MEV" or "no gas wars";
  X-ray = dependencies, not Monad's re-execution counts, method named; backstop returns "earned since deploy", never
  APY; no competitor names; lanes, never threads.
- **Numbers** come only from committed JSON. Monad numbers from `bench/results/10143-*.json` / `bench/xray/10143-*.json`
  and say "on Monad testnet". Anvil numbers say "local anvil, not Monad" in the post itself.
- Character counts are X-weighted lengths from `docs/x/count.py`, excluding media. A URL counts as 23.

## Schedule

| Date | Entry | Gate (must be true to post) |
|---|---|---|
| Wed Oct 7 | Launch thread, Version A (`launch-thread.md`), pinned. Then the pivot post below | Thread reviewed; the auction is implemented in `contracts/` and `forge test` passes |
| Thu Oct 8 | Backstop pools + the solvency identity | Invariant suite in `contracts/test/invariant/` passes; the app's solvency badge works on anvil |
| Fri Oct 9 | First Conflict X-ray, local anvil | A `bench/xray/31337-*.json` is committed |
| Sat Oct 10 | Live on Monad testnet: first measured auction crash | `deployments/10143.json` and a `bench/results/10143-*.json` with `auctions` are committed |
| Sun Oct 11 | The X-ray on Monad testnet, then the technical deep dive (`technical-deep-dive.md`) | A `bench/xray/10143-*.json` is committed; contracts and keeper owners reviewed the deep dive |
| Mon Oct 12 | Demo video + submitted | Submission sent; video uploaded |
| Tue Oct 13 | Deadline buffer | If the submission slipped, submit first, then post the Oct 12 entry |

---

## Wed Oct 7: the pivot (259 chars)

```
Build log: we changed what Paraclr is for.

Lanes were the engine; fair liquidation is the product. Every underwater account now goes to a per-block Dutch auction: discount 0 → +25 bps a block, the trader keeps E − P.

Price set by the block clock, not gas.
```

Media: `[IMAGE: the discount-by-block staircase, or forge test output for the auction tests]`

## Thu Oct 8: backstops + solvency (263 chars)

```
Build log: who takes, and who checks.

Each lane has a backstop pool that takes its auctions at 75 bps, earns the discount and carries the positions. Returns shown as earned since deploy, not APY.

And solvency() sums 8 lane ledgers against the AUSD held. Fuzzed.
```

Media: `[SCREENSHOT: app header solvency badge + detail panel on local anvil, labelled]`

## Fri Oct 9: first Conflict X-ray, local anvil (265 chars; 257 when filled)

```
Build log: the first Conflict X-ray (local anvil, not Monad).

Same crash, two builds of the same contract. Lane-local storage: [E_LANES] cross-lane dependency edges. Shared storage keys: [E_NAIVE].

A dependency map from traces, not a count of Monad re-executions.
```

Fill `[E_LANES]` / `[E_NAIVE]` from the committed `bench/xray/31337-*.json` (`designs[].summary.crossLaneEdges`, and say "cross-lane" in the post). Keep the
"local anvil, not Monad" label in the text and in the image.

Media: `[IMAGE: landing X-ray section with the "local anvil — not Monad" strip in frame]`

## Sat Oct 10: first measured auction crash on Monad testnet (249 chars; 231 when filled)

```
Live on Monad testnet: we crashed every market 20%. [STARTED] accounts went to auction, backstop pools took [BACKSTOP], [CURED] cured.

Median time underwater: [P50] blocks. Longest: [MAXB] blocks.

Every tx hash in the repo: [LINK: repo]
```

Fill from one `bench/results/10143-*.json` (mapping in `launch-thread.md`, Version B). If `cured` is 0, drop
", [CURED] cured" rather than posting a zero you'd have to explain.

Media: `[VIDEO: Live clearing screen, "Monad testnet" badge, lanes ticking and resolving, result card]`

## Sun Oct 11: the X-ray on Monad testnet (240 chars; 247 when filled)

```
The Conflict X-ray of our Monad testnet crash ([METHOD]):

Paraclr lanes: [E_LANES] cross-lane dependency edges.
The same contract with shared storage keys: [E_NAIVE].

Both graphs, side by side, on the landing page and in the repo as JSON.
```

Then post `technical-deep-dive.md` (Version B 10/10 if this entry went out).

Media: `[IMAGE: landing X-ray section, Monad testnet strip + method label in frame]`

## Mon Oct 12: demo video + submitted (274 chars)

```
Submitted Paraclr to Monad Metropolis.

The fair-liquidation clearinghouse for Monad: per-block auctions in 8 lanes, backstop LPs, traders keep their leftover equity, a Conflict X-ray per crash, solvency checked every block.

Demo below. Code + data: [LINK: repo]
```

Media: `[VIDEO: full demo, 2:30–3:00, captions burned in]`. Script: `docs/SUBMISSION.md`, section 3.

---

## If a gate slips

- **No anvil X-ray by Oct 9.** Post the Oct 8 entry a day late, or a short clip of the auction lifecycle on local anvil
  labelled "local anvil, not Monad". Don't post an X-ray image that isn't from a committed file.
- **No Monad deploy or measured run by Oct 10.** Skip the Oct 10 and Oct 11 entries. Post the deep dive with its
  Version A ending. The Oct 12 post drops "Code + data" for "Code" and the demo video says "local anvil, not Monad" for
  every number.
- **No Monad X-ray but a Monad run exists.** Post Oct 10 as written; for Oct 11, use the anvil X-ray only with its
  label in the text.
