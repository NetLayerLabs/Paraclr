# Diagnostic runs (not headline evidence)

RunReports kept for the record but **not** shown in the landing page's Results: they measure the keeper's latency
more than the auction design. Their Conflict X-rays are valid and live in [`../xray/`](../xray/).

## Monad testnet, demo stack, 2026-10-08

Demo stack on Monad testnet (`deployments/demo/10143.json`: `ParaclrClearinghouseDemo` 0x5b40…21c5,
`NaiveClearinghouseDemo` 0x3A15…981c), the same 100-account book seeded into both designs (`--seed 429569614`),
crash and auctions resolved by the bench's in-process sweeper over the public RPC (`testnet-rpc.monad.xyz`,
15 requests/s per IP, JSON-RPC batching off). X-rays traced live with `debug_traceTransaction` (prestateTracer).

| File | Shock | Step | Auctions | Avg discount | Equity returned | Resolution | X-ray (cross-lane edges) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `10143-2026-10-08T03-45-53Z.json` | −20% | 25 bps/block | 21 (19 backstop, 2 external) | 500 bps (the cap) | 0 of 2,842 AUSD | 23 txs, 17 blocks; status `failed` (sweep timeout) | lanes 0 · naive 4 |
| `10143-2026-10-08T04-14-17Z.json` | −30% (same book, after the first run) | 5 bps/block | 9 (8 backstop, 1 external) | 343 bps | 0 of 203 AUSD | 12 txs, 6 blocks | lanes 0 · naive 6 |

**Why these aren't the headline.** The design expects a lane's backstop pool to take an account once the discount
reaches its 75 bps minimum, a few blocks into the auction. Here the keeper needed ~20 s to start the auctions and
~40 s (110–160 blocks) to take them: its sweeper checks every account with a separate `eth_call`, and at 15
requests/s one pass over 216 accounts takes ~15 s. At 25 bps per block and ~0.35 s Monad blocks the discount reaches
its 500 bps cap in ~7 s, so in the first run every auction ran to the cap and traders got nothing back (most of these
accounts were also nearly bankrupt after the shock: high bad debt in both runs).

**What changed because of it.** The live testnet deployment's auction step is 5 bps per block since 2026-10-08
(through the timelock), and the live keeper runs on a dedicated RPC endpoint. Next: batched account checks
(multicall) in the sweeper, then a re-run whose economics can be compared with the local-anvil runs.

## Follow-up: Monad testnet, 2026-10-10

The re-run with the batched sweeper is headline evidence and lives in the README's Results:
`bench/results/10143-2026-10-10T22-40-07Z.json` and `bench/xray/10143-run-mv2za35r-mfh66.json`. Same −20% shock and
100-account book size, 5 bps step: all 22 auctions resolved within 11 blocks (8.8 s), average discount 103 bps,
1,511.79 AUSD of equity returned to traders (28% less taken than the fixed 1% path), X-ray 0 cross-lane edges vs 18.
