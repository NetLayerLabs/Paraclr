# Mainnet-fork rehearsal evidence (launch gate)

`143-fork-v5-2026-10-07T05-41-11Z.json` is the report of the final `npm run rehearse:mainnet`, run on 2026-10-07 against the production contract that will be deployed:

- **Contract:** `contracts/src/prod/ParaclrClearinghouseProd.sol` **v5**, sha256 `1643014507eaf16afd06d25a50d2f9bdac8a0556ede00f960cc9fcbda702a5ed` (51,418+ B runtime; Monad allows 128 KB, anvil and forge run with `--code-size-limit 131072`).
- **Deploy:** the real `contracts/script/DeployProd.s.sol` through `npm run deploy:mainnet` on every leg: 21 txs, 14.84M gas used, 18.09M gas limit, all on-chain post-deploy checks passed.
- **Result: 43 of 43 steps passed.**

| Leg | Chain | Steps | What it covers |
| --- | --- | --- | --- |
| fork | anvil fork of Monad mainnet (chain 143), real Agora AUSD, real Pyth `0x2880…C17B43`, real Wormhole-signed Pyth updates harvested from mainnet txs | 23/23 | Safe owner, `keeper:init` / `keeper:fund` / `deploy:mainnet` CLIs, treasury seeding batch, deposit caps, 8 lanes' orders executed by 8 keepers, multi-leg order, slippage → `OrderFailed`, withdraw via the keeper's Hermes proxy, pause semantics, Hermes outage drill, expired order + cancel, funding formula, LP two-step exit, timelock unpause as the Safe, stale-oracle alerts, solvency |
| mock | plain anvil (chain 143) with the TEST MockPyth + MockAUSD | 15/15 | liquidations while paused, `depositWithPrice` rescue top-up above the cap, cure, reduce-only close in auction, pool takes, expiry, lane-deficit drill (bad debt, haircut, `LaneInDeficit`, treasury repair), dead-feed swap through the timelock |
| scale | plain anvil, MockPyth, one lane with 600 accounts | 5/5 | every auction batch chunked under Monad's 30M per-tx gas limit (max 23.8M), all 600 taken, solvent |

**What this is not:** nothing here ran on Monad mainnet. The fork leg is an anvil fork of mainnet state; the mock and scale legs use a test oracle because real prices did not move enough to liquidate anyone. Hermes requires an API key since 2026-08-26 and none was available, so the fork leg replays real signed updates through a local Hermes-compatible server (`--hermes live` exists but is untested). See `docs/RUNBOOK.md` §10 for the procedure and §11 for the MON budget derived from this report's `gas` section.

Re-run before launch if the contract, the deploy script or the keeper changes: `npm run rehearse:mainnet` (output under `contracts/cache/rehearsal/<UTC>/`, gitignored), then copy the new `report.json` here with the contract hash.

## Monad testnet (chain 10143)

`10143-fork-2026-10-07T15-51-49Z.json` is the report of `npm run rehearse:testnet` on 2026-10-07 against the same contract (v5, sha256 `1643014507eaf16afd06d25a50d2f9bdac8a0556ede00f960cc9fcbda702a5ed`), deployed through `npm run deploy:testnet` (DeployProd with `PROD_MARKETS=SOL/AUSD,BTC/AUSD`, a 600 s timelock): **36 of 36 steps passed**.

| Leg | Chain | Steps | What it covers |
| --- | --- | --- | --- |
| fork | anvil fork of Monad **testnet**, real Agora testnet AUSD + faucet, real Pyth; real Wormhole-signed SOL/BTC updates harvested from Monad **mainnet** txs (the testnet Pyth has the same guardian set and verifies them) | 24/24 | Safe owner, `keeper:init` / `keeper:fund` / `deploy:testnet` CLIs, Agora faucet limits, treasury seeding batch, 8 lanes' orders with the 1-wei Pyth fee, multi-leg, slippage, `/hermes` (MON refused), pause, Hermes outage, expiry + cancel, funding, LP exit, unpause through the 600 s timelock as the Safe, Hermes asked for SOL/BTC only |
| fallback | the same fork | 6/6 | the trial-end fallback: KeeperSignedPyth deployed (owner = timelock), keeper pre-switch pushes, `setPyth` through the timelock, live switch, orders filled on keeper-signed prices, `record --live` |
| mock | plain anvil (chain 10143), TEST MockPyth + MockAUSD | 6/6 | auctions while paused, lane pool takes, solvency, timelock unpause |

Nothing ran on Monad testnet. No `PYTH_API_KEY` was available, so live Hermes is untested; the replayed updates are real and verified on chain by the real Pyth contract. Procedure and budget: `docs/RUNBOOK.md` §14.

