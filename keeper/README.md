# Paraclr keeper

The keeper is a long-running Node process (TypeScript, viem, run with `tsx`). It is the only thing that holds operator keys. It does seven jobs:

- **Price loop:** pushes a GBM price feed for MON, SOL and BTC to `MockOracle.setPrices` every `PRICE_PUSH_MS`. It uses the same model as the in-browser simulator. In chain modes the on-chain oracle is the only source of prices.
- **Faucet:** gives new wallets a little native gas plus 10,000 test AUSD.
- **Auction sweeper:** every block, from the 8 lane keeper keys at once, it starts auctions for newly liquidatable accounts, calls the lane backstop pool once the discount reaches the pool's minimum (75 bps), cancels cured auctions and expires auctions at the maximum discount.
- **Demo external takers** (anvil default; off on Monad unless `DEMO_TAKERS=1`): keeper-run bot accounts, 3 per lane, that bid in the auctions at their own reservation discount (25–70 bps by default). With them the pool is not the only bidder, so the auction does real price discovery. They are **demo bots run by the keeper**, and every report says so.
- **Flash-crash run (v2):** the measured benchmark. One oracle tx shocks every market, then the sweeper drives every auction to resolution. The result is a `RunReport` with auction outcomes and time underwater.
- **Conflict X-ray:** after a crash, it traces every resolution tx of both designs (lane-sharded Paraclr and the naive shared-state baseline) and builds the storage read/write dependency graph.
- **HTTP API** for the app (JSON, CORS).

The interface contracts are [`docs/ONCHAIN_PLAN.md`](../docs/ONCHAIN_PLAN.md) and [`docs/FAIR_LIQUIDATION_PLAN.md`](../docs/FAIR_LIQUIDATION_PLAN.md). This file documents what is actually implemented and how to run it.

```
keeper/src/index.ts        entry (`npm run keeper`)
keeper/src/server.ts       HTTP API
keeper/src/sweeper.ts      per-block auction sweeper (8 lanes concurrently, both designs)
keeper/src/takers.ts       demo external takers (keys, reservations, funding)
keeper/src/crash.ts        crash run v2 (auctions) + legacy liquidateBatch run + RunReport + recover
keeper/src/xray.ts         prestate tracing → access/write sets → same-block edge graph
keeper/src/xray-run.ts     X-ray orchestration (collect txs, method choice, labels, file)
keeper/src/xray-fork.ts    fallback: replay the blocks on an anvil fork and trace there
keeper/src/xray-labels.ts  slot labels from `forge inspect … storageLayout`
keeper/src/views.ts        GET /solvency and GET /backstop
keeper/src/prices.ts       GBM simulator + price loop
keeper/src/faucet.ts       /faucet
keeper/src/sender.ts       nonce-safe per-key tx sender, receipt polling, gas limits
keeper/src/seed.ts         synthetic book (seedAccounts) + backstop pool top-up for the bench
keeper/src/network.ts      network detection, deployment file, role keys, private-stack defaults
keeper/src/foundry.ts      forge/anvil lookup + "shadow" foundry root for private deploys
keeper/src/init-env.ts     `npm run keeper:init`: generate keeper/.env with fresh keys
keeper/src/fund-roles.ts   `npm run keeper:fund`: show / top up role balances
bench/run.ts               `npm run bench`
bench/xray.ts              `npm run xray` (X-ray over any block range)
scripts/dev-chain.ts       `npm run dev:chain`
scripts/deploy.ts          `npm run deploy:anvil` / `npm run deploy:monad`
```

## Production (Monad mainnet)

`--network mainnet` switches every command to the **production** flow. It runs against `ParaclrClearinghouseProd`, real Agora AUSD and the Pyth pull oracle, configured from `keeper/.env.mainnet`. `--network testnet` runs the same production flow on Monad testnet ([below](#production-on-monad-testnet-chain-10143)). Everything else in this file is the demo stack (anvil / Monad testnet with MockAUSD and MockOracle, the hackathon evidence), and it is unchanged.

Procedures (deploy, launch gate, pause, timelock, key rotation, top-ups, incidents, MON budget) are in [`docs/RUNBOOK.md`](../docs/RUNBOOK.md). Hosting is in [`keeper/HOSTING.md`](HOSTING.md).

| Command | What it does |
| --- | --- |
| `npm run keeper:init -- --network mainnet [--rotate role,… \| --force] [--env PATH]` | Generates DEPLOYER, GUARDIAN, OPS and 8 KEEPER keys into `keeper/.env.mainnet` (mode 600) and prints addresses only. Fills only empty keys; a replaced key goes to `.env.mainnet.retired-<time>` |
| `npm run keeper:fund -- --network mainnet [--send --yes-mainnet --funder-env NAME \| --funder deployer] [--roles …] [--gas-report report.json] [--sweep-retired FILE --to 0x…]` | Previews each role's balance against its target from measured gas (`keeper/src/prod/budget.ts`), then tops them up from a funder you choose |
| `npm run deploy:mainnet [-- --yes-mainnet]` | Preflight (AUSD, Pyth, feeds, owner Safe or EOA), cost estimate, Pyth refresh, `DeployProd.s.sol`, then on-chain verification of roles, caps, ownership-in-timelock and a powerless deployer |
| `npm run keeper -- --network mainnet --yes-mainnet` | The production keeper (below) |
| `npm run guardian:pause -- --network mainnet [--status \| --yes-mainnet]` | Emergency `pause()` from the guardian key |
| `npm run timelock -- --network mainnet prepare\|status\|seed\|feed-swap …` | Safe Transaction Builder files for timelock operations (schedule, then execute after the delay); the seeding / deficit-repair batch for the treasury Safe (`seed --lanes …`); the dead-feed swap (`feed-swap --market … --feed 0x… --max-deviation-bps 500`, v3) |
| `npm run pyth:push -- --network mainnet --feeds 0x… [--every 10] [--count N]` | Push the latest Hermes update for given feeds from the OPS key (dead-feed swaps need the new feed's stored price ≤ 15 s old) |
| `npm run rehearse:mainnet [-- --legs fork,mock,scale --hermes replay\|live --lookback N --scale-accounts N --keep]` | The full rehearsal on an anvil fork of mainnet (:8945), a MockPyth liquidation + deficit leg (:8947) and an oversized-lane chunking leg (:8948). Output: `contracts/cache/rehearsal/<UTC>/report.json` |
| `npm run pyth:cadence [-- --blocks N --out FILE]` | Read-only: third-party Pyth push cadence and stored-price freshness on Monad mainnet; simulates the interval push policy |

**The confirmation gate.** On chain 143, anything that sends a tx prints the balances and a cost estimate first, then refuses without `--yes-mainnet`. An anvil (fork) needs no confirmation, but it **must** use `DEPLOYMENTS_OUT`: the keeper and the deploy wrapper refuse `deployments/143.json` on anvil.

### What the production keeper runs

All loops share one head poller (`eth_getBlockByNumber` every 200 ms) and decide on **chain time**:

- **Order executor** (`prod/executor.ts`).
  - **Discovery.** `OrderCommitted`, `OrderExecuted`, `OrderFailed` and `OrderCancelled` logs, in 100-block windows, with a backfill of 2 × `maxExecDelay` on start.
  - **Waiting.** It waits until chain time reaches `execAfter`, then asks Hermes for the **first** update at or after `execAfter` (`/v2/updates/price/{t}`).
  - **Local checks** before sending:
    - the update is the first one (`prevPublishTime < execAfter`, the `parsePriceFeedUpdatesUnique` rule);
    - `publishTime ≤ deadline`;
    - confidence ≤ `maxConfBps`.
  - **Other legs** (`EXEC_OTHER_LEGS`, default `auto`). `append` (contract v3+, detected by `TOP_UP_TARGET_BPS()`): send `[latest for the account's feeds, unique fill update]`; other legs (and, for a reduce-only order in auction, the order market's current price) are priced from it through the monotonic lane path; no push. `push` (v2): only the fill update; the `PricePusher` pushes the stale feeds to Pyth storage first.
  - **Sending.** It simulates and sends from the **lane's** keeper key, with `msg.value` = `getUpdateFee` (× 2 when appending; 0 on Monad; the excess is refunded).
  - **Outcomes:**
    - `OrderNotReady` → retry;
    - user-side failures resolve on chain as `OrderFailed`, and the executor is still paid;
    - oracle errors → refetch, alert after 3 failures;
    - deadline passed → `exec:expired` alert (anyone can `cancelOrder` it);
    - `LaneInsolvent` → critical `lane:insolvent:<i>`.
  - **Claims.** Every 10 min each keeper claims its MON execution fees (≥ `CLAIM_MIN_MON`) and AUSD expiry rewards (≥ `CLAIM_MIN_AUSD`).
- **Funding** (`prod/funding.ts`), from the OPS key.
  - It sends `updateFunding(market)` only when the rate the contract would set changes by more than `FUNDING_MIN_CHANGE_BPS` (5 %) or crosses zero, or once it is older than `FUNDING_MAX_AGE_S` (1 h), and never before `nextUpdate`.
  - The keeper's off-chain copy of the formula matched the stored rates in the rehearsal.
  - Cost: ≈ 1.9 MON/day, against ≈ 38.6 MON/day for an update every 60 s.
- **Auction sweeper** (`prod/sweeper.ts`).
  - **Views.** Every ≥ 1 s: one Hermes `latest` for all feeds. Then, per lane, `eth_simulateV1` runs `pyth.updatePriceFeeds(update)` followed by the lane views in one simulated block, so liquidatable and health numbers use **fresh** prices. The contract's views otherwise read the stored Pyth price and revert when it is older than 60 s.
  - **Chunking (R2-09).** Every batch is split so its gas limit stays ≤ 30M × `KEEPER_BATCH_HEADROOM` (0.8): chunk size from the per-account gas (74k start, 95k take, re-learnt from receipts), each chunk estimated and re-sized from its own estimate if still too big. View calls go in `SWEEPER_SIM_CALLS` (100) per `eth_simulateV1`. Measured on a 600-account lane: 3 start txs (max 22.8M) and 4 take txs (max 23.9M).
  - **Actions:**
    - `cancelAuction` for cured accounts (cure line: the contract's `CURE_BUFFER_BPS`, 110 % of maintenance in v2, else 100 %; override `SWEEPER_CURE_BPS`; never in the start block);
    - `startAuctions` for newly liquidatable accounts;
    - `backstopTakeBatch` once the discount reaches the pool minimum, and only when a simulation says the pool takes at least one account;
    - `expireBatch` at the maximum discount.

    Every tx carries the fresh update and is simulated first.
  - **No block overrides.** Monad's RPC rejects `eth_call` blockOverrides, so decisions use block N's discount.
  - **Production only:** no demo takers and no naive design.
- **Pyth push** (`prod/pricepush.ts`, `PYTH_PUSH_MODE`). Contract v2 expires stored and lane prices after 15 s. `on-demand` (default): push only the stale feeds right before an execution that needs them (≈ 0.5–0.7 MON/day); `interval`: keep every feed ≤ 12 s old while anything is open (≈ 83–102 MON/day measured); `off`. Cost analysis in the runbook (8b); `npm run pyth:cadence` measures the third-party push cadence (read-only).
- **Monitor** (`prod/monitor.ts`) checks:
  - hot-key balances;
  - Hermes price age and confidence, and the age of the price **stored** in Pyth;
  - `paused()` changes;
  - **per-lane** `laneSolvency(lane).surplus < 0` (`solvency:lane<i>`), token-level `solvency()` and `nativeSolvency()`;
  - risk events from the per-head log scan: `LaneHaircut`, `BackstopLossAbsorbed`, `BackstopPoolReset`, `AccountSkipped`, and on v3 `BackstopRepaid` and `MarketFeedReplaced` (the keeper switches the market's feed live);
  - lane TVL and OI cap utilisation;
  - `owner()` still the timelock;
  - head liveness.

  Optional `AUTO_PAUSE_ON_INSOLVENCY=1`, which needs the guardian key on the host.
- **Hermes client** (`prod/hermes.ts`).
  - Sends `Authorization: Bearer $PYTH_API_KEY`: Hermes answers **401 without a key since 2026-08-26**.
  - A 401 or 403 means a critical `hermes:auth` alert and is not retried. At startup the keeper **refuses to run** without a key, or when the key is rejected.
  - Transient errors (network, 5xx, 429): exponential backoff with jitter, then the `PYTH_HERMES_FALLBACK_URLS` endpoints, then a global circuit breaker (0.5 → 15 s).
  - `hermes:down` fires after 30 s without an answer and resolves on recovery.
  - Every blob is parsed locally (`prod/pyth-wire.ts`, the PNAU format) before use.
- **Alerts** (`prod/alerts.ts`) go to `ALERT_WEBHOOK_URL` as a Discord- and Slack-compatible JSON body (`content`, `text`, `alert`).
  - An alert fires once when it becomes active, repeats at most every `ALERT_REPEAT_MS`, and sends one "resolved".
  - The catalogue is in the runbook.

### Production HTTP API

| Method + path | Response |
| --- | --- |
| `GET /health` | `{ chainId, mode: "monad-mainnet", network: "monad-mainnet" \| "anvil", fork, production: true, block, chainTime, paused, priceSource: "pyth", prices, pricesUpdatedAt, storedPriceAgeS, pricePush, laneSolvency, oracle: { pyth, feeds, maxConfBps, maxPriceAge, prices: { [m]: { price, confBps, publishTime, ageS } }, hermes }, caps: { maxLeverage, maxDepositPerAccount, maxTvlPerLane, laneTvl[8], tvlUtilisationPct[8], laneOiCap, oiUtilisationPct }, solvency, nativeSolvency, addresses, owner, markets, hotKeys: [{ role, address, mon, low }], params, executor, funding, sweeper, alerts, txs, … }`. Demo fields (`crashed`, `faucet`, `priceLoop`, `demoTakers`) are present but null or false |
| `GET /livez` | 200 while blocks advance (≤ 60 s), else 503: for platform restarts |
| `GET /orders[?account=0x…]`, `GET /orders/:id` | tracked orders: `{ id, account, lane, market, sizeDelta, execAfter, deadline, state, fillPrice, failReason, txHash, latencyS, … }` |
| `GET /solvency`, `GET /backstop[?lp=0x…]` | same shapes as the demo, plus `native`, and per lane `nativeEscrow` / `nativeOwed` and the v2 lane solvency (`held`, `claims`, `surplus`, `haircutBps`, `solvent`) |
| `GET /alerts`, `GET /txs` | active alerts and recent events; the last 100 keeper txs with gas per kind (limit and used) |
| `GET /hermes/v2/updates/price/latest?ids[]=…`, `/hermes/v2/updates/price/{t}?ids[]=…` | Hermes-compatible proxy for the app (only this deployment's feeds; cached 1 s; 5 req/s per IP). Point `NEXT_PUBLIC_PYTH_HERMES_URL` here, so the key never reaches browsers and withdrawals can carry a fresh update |
| `POST /faucet`, `/crash`, `/recover`, `/price-loop`, `/demo-takers`, `GET /runs…` | **403**: these do not exist in production |

### Production files

```
keeper/src/prod/main.ts        production keeper entry (`npm run keeper -- --network mainnet`); cli.ts = container entry
keeper/src/prod/config.ts      env file, chain-143 gate, --yes-mainnet gate, hot-key roles
keeper/src/prod/deployment.ts  deployments/143.json (or DEPLOYMENTS_OUT) reader, verified on chain
keeper/src/prod/context.ts     config, on-chain params, Pyth fee
keeper/src/prod/head.ts        shared head poller (chain time)
keeper/src/prod/executor.ts    delayed-order executor + fee claims
keeper/src/prod/funding.ts     change-triggered funding updates
keeper/src/prod/sweeper.ts     auctions with fresh Pyth updates (eth_simulateV1 views), gas-chunked batches
keeper/src/prod/pricepush.ts   Pyth storage pushes (on-demand / interval)
keeper/src/prod/monitor.ts     monitoring → alerts
keeper/src/prod/alerts.ts      webhook alerting
keeper/src/prod/hermes.ts      Hermes client (key, backoff, fallbacks, circuit breaker)
keeper/src/prod/pyth-wire.ts   PNAU parser / subsetting
keeper/src/prod/tx.ts          simulate → send → track, revert decoding, gas ledger
keeper/src/prod/server.ts      production HTTP API + Hermes proxy
keeper/src/prod/budget.ts      measured gas → MON targets
keeper/src/prod/init.ts / fund.ts / guardian.ts / timelock.ts / push-cli.ts   the CLIs above
keeper/src/prod/reserve.ts     Monad reserve-balance guard (value-carrying txs from keys < 10 MON spaced 3 blocks)
keeper/src/prod/signed.ts      keeper-signed price source (testnet trial-end fallback)
keeper/src/prod/oracle-switch.ts  pre-switch pushes into the fallback oracle while its setPyth is pending
keeper/src/prod/sandbox-faucet.ts, anvil-cheats.ts   sandbox-only /faucet (anvil forks only)
bench/pyth-cadence.ts          `npm run pyth:cadence` (read-only third-party push cadence)
scripts/deploy-mainnet.ts, scripts/lib/prod-deploy.ts            deploy:mainnet / deploy:testnet
scripts/rehearse-mainnet.ts, scripts/lib/rehearsal.ts, scripts/lib/pyth-replay.ts   rehearse:mainnet
scripts/rehearse-testnet.ts, scripts/testnet-oracle.ts, scripts/sandbox.ts, scripts/lib/artifacts.ts   rehearse:testnet, oracle:fallback, sandbox
contracts/src/testnet/KeeperSignedPyth.sol                       the testnet-only fallback oracle
keeper/Dockerfile (+ .dockerignore files), keeper/HOSTING.md
```

### Production on Monad testnet (chain 10143)

`--network testnet` selects the testnet profile (`keeper/src/prod/config.ts`): `keeper/.env.testnet` (template `keeper/.env.testnet.example`), chain 10143, Agora's testnet AUSD `0xa9012a…22dC`, the same Pyth `0x2880…C17B43` (fee 1 wei per message), markets `PROD_MARKETS=SOL/AUSD,BTC/AUSD`, a 600 s timelock, and `--yes-testnet` as the confirmation flag. Interface contract: [`docs/TESTNET_PLAN.md`](../docs/TESTNET_PLAN.md); procedures: [`docs/RUNBOOK.md` §14](../docs/RUNBOOK.md#14-monad-testnet-chain-10143-the-production-contract-on-test-funds).

| Command | What it does |
| --- | --- |
| `npm run keeper:init -- --network testnet` | Hot keys + `PRICE_SIGNER_PRIVATE_KEY` into `keeper/.env.testnet` (mode 600), addresses only |
| `npm run keeper:fund -- --network testnet [--send --yes-testnet --funder-env NAME]` | Budget for ~3 weeks of light demo use (testnet gas table from the testnet rehearsal) |
| `npm run deploy:testnet [-- --yes-testnet]` | Dry run by default. DeployProd with SOL/BTC, `DEPLOY_NETWORK=monad-testnet`, the 600 s timelock; writes `deployments/10143.json` (`"production": true, "network": "monad-testnet"`) |
| `npm run keeper -- --network testnet --yes-testnet` | The production keeper on testnet |
| `npm run guardian:pause` / `timelock` / `pyth:push -- --network testnet …` | As on mainnet; `timelock set-pyth --to 0x…` prepares the oracle switch |
| `npm run oracle:fallback -- --network testnet deploy\|record\|status` | The trial-end fallback oracle (KeeperSignedPyth): deploy (owner = timelock), record in the deployment file, status |
| `npm run rehearse:testnet [-- --legs fork,fallback,mock --keep]` | Rehearsal on an anvil fork of testnet (:8955) + the fallback switch + a MockPyth auction leg (:8957) |
| `npm run sandbox [-- --detach --smoke --stop --prices hermes\|signed]` | Local production sandbox: testnet fork :8645, keeper :8887, `deployments/sandbox/10143.json`, sandbox-only `/faucet`; the app is `npm run dev:sandbox` |

Differences from mainnet inside the keeper:

- **Only the listed feeds** ever go to Hermes (the trial key covers SOL/USD and BTC/USD, not MON/USD); the AUSD/USD depeg check is off (`AUSD_DEPEG_CHECK=0`), `/hermes` refuses other ids with 400.
- **Reserve-balance guard** (`MONAD_RESERVE_GUARD=auto`): the testnet Pyth fee makes keeper txs carry value, so a key below 10 MON sends them ≥ 3 blocks after its previous tx (Monad's emptying exception). `/health.reserveGuard`.
- **Funding:** `FUNDING_SKIP_IDLE=1` (no max-age update while a market has no skew), max age 6 h.
- **Oracle switching** (`prod/deployment.ts resolveOracle`, `context.ts switchOracle`): `pyth()` on the clearinghouse is the truth. With `PRICE_SIGNER_PRIVATE_KEY` and a recorded `fallbackOracle`, the keeper signs prices ahead of time (`prod/signed.ts`), pushes them into the fallback while the timelocked `setPyth` is pending (`prod/oracle-switch.ts`), and switches every loop and `/hermes` to keeper-signed prices when `PythUpdated` fires (alert `gov:oracle`, `/health.priceSource: "keeper-signed"`). Mainnet refuses a keeper-signed oracle.
- `/health` reports `mode: "monad-testnet"`, `network: "monad-testnet"` (or `"anvil"` on a fork), `testnet: true`, `sandbox` (the local sandbox), `oracle: { mode, pyth, realPyth, fallbackOracle, signer, prepush }`, `reserveGuard`.

## Local (anvil): zero config

```bash
npm run dev:chain                     # anvil :8545 + deploy + keeper :8787. Ctrl-C stops all
npm run bench -- --accounts 500       # second terminal; writes bench/results/ + bench/xray/
```

`dev:chain` takes the following steps:

1. Starts `anvil --chain-id 31337 --block-time 1 --gas-limit 150000000 --hardfork prague --accounts 12`.
   - The block gas limit is Monad's documented 150M.
   - It uses `prague` because anvil's newer default (Osaka) caps every tx at 2^24 gas, and Monad does not.
   - Blocks are 1 s. Use `--block-time 0.4` to mimic Monad's ~0.4 s block cadence.
2. Deploys with `contracts/script/Deploy.s.sol`: MockAUSD, MockOracle, `ParaclrClearinghouseDemo` and `NaiveClearinghouseDemo` on the same oracle and AUSD.
   - Each gets 100k AUSD of insurance and a 50k AUSD backstop pool per lane (the naive design's 8 deposits land in its one shared pool).
   - The wrapper passes `BACKSTOP_MIN_DISCOUNT_BPS` (default **75**, below the legacy 1% penalty), so every lane pool of both designs gets that take threshold explicitly. After the deploy it reads `backstopMinDiscountBps(lane)` back on all 8 lanes of both designs and fails if any differs.
   - It writes `deployments/31337.json`, including `"naive"`.
3. Starts the keeper. With demo takers on, the keeper derives 24 taker accounts and funds them on both designs (anvil gas + 250k AUSD collateral each per design via `seedAccounts`).

It is idempotent:

- If anvil is already running on the port, it is reused.
- If the contracts in the deployment file already have code, the deploy is skipped. It warns if their `backstopMinDiscountBps` differs from `BACKSTOP_MIN_DISCOUNT_BPS` (redeploy with `--redeploy`).
- If a keeper already answers on the keeper port, no second keeper is started.

Each fresh anvil gets the same contract addresses, because the deployer nonce starts at 0.

| Flag | Effect |
| --- | --- |
| `--no-keeper` | Start anvil and deploy only |
| `--persist` | Keep chain state in `<log dir>/anvil-state.json` |
| `--redeploy` | Deploy again even if the contracts are live |
| `--block-time S` | Anvil block time in seconds |
| `--port P` | Anvil port (default 8545) |
| `--keeper-port P` | Keeper port (default `KEEPER_PORT`, else 8787 + (port − 8545)) |
| `--deployments PATH` | Deployment JSON to write and read (same as `DEPLOYMENTS_OUT`) |

Anvil's log goes to `contracts/cache/dev-chain/anvil.log` (`contracts/cache/dev-chain/<port>/anvil.log` on other ports).

### Private stacks (a second anvil next to the canonical one)

`deployments/31337.json` belongs to the canonical stack: anvil :8545 + keeper :8787, which the app reads. Any other local port gets its own files automatically, in `dev:chain`, `npm run keeper`, `npm run bench` and `npm run xray` alike:

| | Canonical (:8545) | Private (any other local port P) |
| --- | --- | --- |
| Deployment file | `deployments/31337.json` | `contracts/cache/dev-chain/P/deployments.json` (`DEPLOYMENTS_OUT`) |
| Keeper port | 8787 | 8787 + (P − 8545): 8645 → 8887, 8745 → 8987 (`KEEPER_PORT`) |
| X-ray dir | `bench/xray` | `contracts/cache/dev-chain/P/xray` (`XRAY_DIR`) |

```bash
npm run dev:chain -- --port 8645                                # anvil :8645 + keeper :8887
npm run bench -- --rpc http://127.0.0.1:8645 --accounts 500     # bench against it
```

A private deploy runs forge from a "shadow" foundry root (`contracts/cache/shadow/deploy-<port>/`, gitignored). It points at the real `contracts/src`, but has its own `out/`, `cache/` and `broadcast/`. So the forge script's own JSON write lands there and is copied to `DEPLOYMENTS_OUT`. A private deploy therefore never touches `deployments/31337.json` and never races a `forge build` in `contracts/`. All three variables can be set explicitly to override the defaults.

### Roles on anvil

On anvil every role uses anvil's public dev mnemonic:

| Role | Index |
| --- | --- |
| Operator | 0 |
| Price pusher | 1 |
| Faucet | 2 |
| Keepers | 3–10 |

Any role below 1000 ETH is topped up with `anvil_setBalance`. `dev:chain` and `deploy:anvil` **ignore `keeper/.env`**, which holds the Monad keys. Put local overrides in `keeper/.env.anvil` (also gitignored).

`npm run keeper` on its own reads `keeper/.env`. With no file it falls back to the anvil defaults on `http://127.0.0.1:8545`.

## HTTP API

Base URL `http://127.0.0.1:$KEEPER_PORT` (default 8787). Every response is JSON. CORS follows `KEEPER_CORS_ORIGIN`: `*` or a comma-separated list of origins. The app reads the URL from `NEXT_PUBLIC_KEEPER_URL`. All existing response shapes are unchanged; new fields are additive.

| Method + path | Body / query | 2xx response | Errors |
| --- | --- | --- | --- |
| `GET /health` | – | `{ chainId, mode, network, block, addresses: { clearinghouse, ausd, oracle, naive, operator, pricePusher, faucet, keepers[8] }, markets, prices, pricesUpdatedAt, crashed, activeRunId, lastRunId, priceLoop, faucet, features: { auctions, backstop, solvency }, sweeper: { enabled, running, paused, lastBlock, designs[], sent, failures, lastError }, demoTakers: { demo, accounts, reservationBps } }` | 500 |
| `POST /faucet` | `{ address }` | `{ gasTxHash \| null, ausdTxHash, gasWei, ausd }` after both txs are mined | 400 · 429 `{ error, retryAfterMs }` · 502 · 504 |
| `POST /crash` | `{ bps?, mode?, xray? }`: `bps` default 8000 (−20%), 1000–9999; `mode` `auto` (default: auctions if the contract has them) \| `auctions` \| `legacy`; `xray` default on | **202** `{ runId }` | 400 · 409 `{ error, runId }` while a run is active |
| `GET /runs/:runId` | – | `RunReport` (poll until `status !== "running"`) | 404 |
| `GET /runs/:runId/xray` | – | `XrayReport` (from memory, else `bench/xray/<chainId>-<runId>.json`) | **202** `{ runId, status: "pending" }` while computing · 404 |
| `GET /runs` | – | `[{ runId, status }]` (last 50, in memory) | – |
| `POST /recover` | – | `{ txHash, block }` once mined | 409 if not crashed or a run is active |
| `GET /solvency` | `?design=paraclr` (default) \| `naive` | see below | 404 no naive · 501 contract without `solvency()` |
| `GET /backstop` | `?design=…&lp=0x…` (optional LP shares) | see below | 400 · 404 · 501 |
| `GET /sweeper` | – | sweeper status, auction params, last 50 sweeper txs | 404 |
| `POST /price-loop` | `{ paused: boolean, reason? }` | `{ priceLoop }` | 409 during a run, or resume while crashed (use `/recover`) |
| `GET /demo-takers` | – | `{ demo, seed, perLane, reservationBps: [min,max], collateral, takers: [{ address, lane, reservationBps }] }` | – |
| `POST /demo-takers` | `{ enabled?: false, seed?, perLane?, minBps?, maxBps? }` | same as GET, after deriving and funding them on both designs (the bench uses its `--seed`) | 400 · 409 during a run, or while the current takers still hold inherited legs |

`GET /solvency` is a proxy of `solvency()` plus every lane's `laneLedger(lane)`, all read at one block:

```ts
{ chainId, network, block, design: "paraclr-lanes" | "naive-shared", contract,
  sharedState: boolean,              // naive: every lane entry is the SAME shared ledger
  ausdHeld: string, liabilities: string, surplus: string, solvent: boolean,
  lanes: Array<{ lane, collateral, insurance, backstopCash, keeperRewards, badDebt }> }
```

`GET /backstop` returns every lane's pool from `backstopNav`, `backstopStats`, `backstopPositions` and `backstopMinDiscountBps`:

```ts
{ chainId, network, block, design, contract, sharedState,
  auction: { stepBps, maxDiscountBps, source: "contract" | "config" },
  totals: { equity, cash, unrealizedPnl, taken, discountEarned, notionalAbsorbed },   // shared pool counted once
  lanes: Array<{ lane,
    nav: { equity, cash, unrealizedPnl, shareSupply },
    stats: { taken: number, discountEarned, notionalAbsorbed },                       // lifetime: "earned since deploy"
    positions: Array<{ market, symbol, signedSize, entryPrice }>,
    minDiscountBps: number, lpShares?: string }>,
  lp?: string }
```

Amounts are base-10 strings. AUSD values are raw 6-decimal integers. Sizes and prices are 1e18. `collateral`, `backstopCash`, `nav.cash` and `unrealizedPnl` can be negative.

How `/health` and `/faucet` behave:

- `prices` are read live from `MockOracle.getPrice` (AUSD per unit, as floats), not from the simulator.
- `gasTxHash` is `null` when the wallet already holds at least `FAUCET_GAS_WEI`, so no gas is sent.
- Faucet amounts are strings: `gasWei` in wei and `ausd` as raw 6-decimal units.
- A failed drip does not use up the address's cooldown.

## Auction sweeper

The sweeper is on by default (`SWEEPER=0` turns it off; a crash run then starts it for the duration of the run). It polls `eth_blockNumber` every `SWEEPER_POLL_MS`. On every new head N it scans each lane of each design concurrently. All reads are pinned to block N:

1. `laneAccountCount` (cached for 10 ticks), `getLiquidatableAccounts` pages (accounts already in auction are excluded by the contract), `auctionStats(lane).active`, then `getAuctionAccounts` pages. In naive mode `getAuctionAccounts` pages the shared list filtered to the lane, so pagination uses the list length rather than "short page = done".
2. For in-auction accounts: `auctionOf` once (start block, cached) and `isLiquidatable` every block.
3. It decides, per lane, in this order, with one tx each from the lane's keeper key:
   - `cancelAuction(account)` for every in-auction account that is healthy again;
   - `startAuctions(lane, fresh)` for liquidatable accounts that are not yet in auction;
   - `backstopTakeBatch(lane, candidates)` for auctions whose discount **in the block the tx lands in (N+1)** is at least the lane pool's `backstopMinDiscountBps`. The tx is sent only when an `eth_call` of the same batch at N+1 says the pool takes at least one account. The pool's capacity check (equity ≥ 10% of exposure after inheriting) gets easier as the discount grows, so declined accounts are offered again each block for free;
   - `expireBatch(lane, atMax)` for auctions at the maximum discount in N+1. It follows the take tx (same key, next nonce), so it closes only what the pool left.
   - with demo takers: before the pool, each live auction is offered to the lane's free demo takers in order of reservation (see below). Accounts a taker will take are left out of that block's pool and expire batches. Takers holding inherited legs send `closePosition(market)` for each of them.
4. Gas limits come from `estimateGas` + `KEEPER_GAS_MARGIN_BPS`. Takes and expiries are estimated *as of block N+1*; otherwise the estimate would cover the cheap "skip" path and the real tx would run out of gas. Batches above `KEEPER_MAX_TX_GAS` are split in halves.
5. At the start of every tick the receipts of everything still pending are fetched, so a lagging receipt poll never makes a lane skip a block.

"As of block N+1" uses the `blockOverrides` parameter of `eth_call` / `eth_estimateGas`. Once per design the sweeper probes whether the node really applies it: `auctionOf` returns a discount derived from `block.number`, so it must come back one step higher. Nodes that reject the parameter, or silently ignore it, get the conservative path. Decisions are then made on block N's own discount, and the tx lands later at a higher discount. Anvil 1.7.1 applies it.

Nonce safety: each key has one `TxSender` with a local nonce counter under a lock. Monad treats `pending` like `latest`, so the counter must be local. Lane i's paraclr and naive txs share keeper i and simply get consecutive nonces. A (design, lane) with a tx still unmined is skipped until the tx is mined, so nothing is sent twice. A lost tx (no receipt within `KEEPER_RECEIPT_TIMEOUT_MS`) resyncs that key's nonce.

The naive baseline is swept **only while a crash run is capturing** (`SWEEP_NAIVE=crash`, the default; `always` or `off` are the alternatives). Outside crash runs it exists only for the X-ray, and sweeping it would double the RPC load. On Monad the sweeper also waits `SWEEPER_MIN_INTERVAL_MS` (default 1000) between sweeps outside crash runs, to stay inside public-RPC rate limits.

The lane keeper keys never take. External `take(account)` is open to any registered same-lane account (UI users, the demo takers). It earns up to d × notional, **capped at the trader's equity**; the lane never subsidizes an external taker. The crash report counts external takes from the events.

### Demo external takers (keeper-run bots)

- **Who:** `DEMO_TAKERS_PER_LANE` (3) accounts per lane, so 24.
  - Each key is derived from keccak(operator key, seed, lane, i, attempt) and searched until the address lands in its lane, because `take()` requires a same-lane taker. They are as secret as the operator key and never printed.
  - Each draws a reservation discount uniformly from [`DEMO_TAKER_MIN_BPS`, `DEMO_TAKER_MAX_BPS`] (25–70) with a seeded RNG. The seed is `DEMO_TAKER_SEED` for the keeper; the bench re-derives them from its `--seed` through `POST /demo-takers`.
- **Funding:** `DEMO_TAKER_COLLATERAL` (250k AUSD) of collateral per design via the demo-only `seedAccounts` (no positions). Gas comes from `anvil_setBalance` on anvil, or `DEMO_TAKER_GAS_MON` (0.5) per taker from the operator on Monad. They are registered accounts of their lane, so they show up in `accountsScanned`.
- **Bidding** (every block, per lane, before the pool):
  - For each live auction, oldest first, the free taker with the lowest reservation bids if `min(d × notional, max(equity, 0)) / notional ≥ reservation`, where d is the discount in the landing block. That is the discount the contract would *really* pay it, given the external-take cap.
  - An `eth_call` of `take(account)` from that taker at N+1 must succeed (same lane, initial margin after inheriting, …) and return at least that payment.
  - One take per taker per block. Accounts with equity ≤ 0 pay external takers nothing, so they go to the pool.
- **Unwinding:** the next block the taker closes every inherited leg at mark (`closePosition`), so it does not accumulate risk. A crash run is only "resolved" once every taker is flat again.
- **Both designs:** the naive design gets the same takers (same addresses, funded there too) and the same logic during crash runs, so the X-ray compares like for like.
- **Labelling:** `RunReport.auctions.externalTakers = { demo: true, accounts: 24, reservationBps: [25, 70] }`. UI and docs must say "external takers in this run are demo bots run by the keeper".

## Crash run v2 (what `/crash` does)

1. **Pause the price loop** and wait until every price push already sent has been mined. The loop stays paused for the whole run and **until `/recover`**. `RunReport.priceLoopPaused` records this.
2. Snapshot the pre-crash oracle prices. On a second crash without a recover, the original snapshot is kept.
3. Open a sweeper capture (every sweeper tx from now on belongs to the run; the naive design is swept from here on), then **shock** every market in one operator tx: `MockOracle.shockPrices(ids, bps)`. The oracle is shared, so both designs crash in the same block.
4. The sweeper resolves everything. The run waits until every design shows no liquidatable account outside an auction, no active auction and no sweeper tx in flight, at a block after the shock. The time limit is `CRASH_RESOLVE_TIMEOUT_MS`.
5. The report comes from the lane-sharded design's auction events (`AuctionStarted/Taken/Cancelled/Expired` in shock block … last resolution block) and from the sweeper's txs.
6. **Conflict X-ray** of both designs over blocks shock+1 … last resolution block (below). `xrayId` is set when it is written. An X-ray failure sets `xrayError` but does not fail the crash.

`mode: "legacy"` (or a contract without the auction API) runs the original path instead. The sweeper is paused, and one `liquidateBatch(lane, accounts)` per lane per design is signed first, then fired concurrently from the 8 keeper keys. The X-ray runs on those txs.

### `RunReport`

The shape from `docs/ONCHAIN_PLAN.md`, plus `priceLoopPaused`, plus the `docs/FAIR_LIQUIDATION_PLAN.md` additions, plus a few additive fields (marked ⁺):

```ts
interface RunReport {
  runId: string; status: "running" | "done" | "failed"; error?: string;
  chainId: number; network: "anvil" | "monad-testnet";
  mode: "auctions" | "legacy";                                                   // ⁺
  priceLoopPaused: boolean;
  shock: TxTiming & { bps: number };
  batches: Array<TxTiming & { lane: number; keeper: `0x${string}`; accounts: number; liquidated: number;
                              gasUsed: string; gasLimit: string;
                              kind: "startAuctions" | "backstopTakeBatch" | "expireBatch" | "cancelAuction" | "take" | "closePosition" | "liquidateBatch" }>; // kind ⁺
  liquidations: Array<{ lane: number; account: `0x${string}`; equity: string; badDebt: string;
                        txHash: `0x${string}`; logIndex: number }>;
  totals: { accountsScanned: number; liquidated: number; badDebt: string; wallClockMs: number;
            blocks: number[]; sameBlock: boolean; totalGasUsed: string };
  auctions?: { started: number; takenByBackstop: number; takenExternal: number; cured: number; expired: number;
               avgDiscountBps: number; traderResidualReturned: string; backstopPaid: string; badDebt: string;
               legacyCounterfactual: { traderLoss: string };
               traderEquityAtStart: string;                                     // ⁺
               externalTakers: { demo: boolean; accounts: number; reservationBps: [number, number] | null } };
  underwater?: { maxBlocks: number; p50Blocks: number; p95Blocks: number; maxMs: number;
                 perAccount: Array<{ account: `0x${string}`; lane: number; fromBlock: number; toBlock: number;
                                     outcome: "backstop" | "external" | "cured" | "expired" }> };
  xrayId?: string;
  xrayError?: string;                                                            // ⁺
}
interface TxTiming { txHash: `0x${string}`; block: number | null; submittedAt: number; confirmedAt: number | null }
```

Definitions for auction mode. All AUSD values are raw 6-decimal integer strings, and gas values are integer strings.

- **Which accounts count:** every account whose `AuctionStarted` is at or after the shock block, followed to its first `AuctionTaken`, `AuctionCancelled` or `AuctionExpired`. An unresolved account fails the run.
- **`batches`:** every sweeper tx on the lane-sharded design during the run, including the demo takers' `take` and `closePosition` txs (their `keeper` field is then the taker's address). `liquidated` is the number of accounts that tx resolved (taken + expired).
- **`liquidations` and `totals.liquidated`:** the taken and expired accounts. `equity` is the equity at `AuctionStarted`.
- **`totals.blocks` and `sameBlock`:** the blocks of the sweeper txs. With auctions these are several blocks by design (start, then take ≥ 6 blocks later), so `sameBlock` is normally `false`.
- **`wallClockMs`:** first resolution tx submitted → last receipt observed.
- **`avgDiscountBps`:** mean `discountBps` over the takes.
- **`traderResidualReturned`:** Σ `AuctionTaken.traderResidual`, plus the collateral left on expired accounts (read at the expiry block). Cured accounts keep everything and are not in it.
- **`backstopPaid`:** Σ `payment` of backstop takes (what the pools earned). External takes pay `min(d × notional, max(equity, 0))`, out of the trader's equity only.
- **`badDebt`:** Σ event `badDebt`, which is the **lane-funded shortfall**; label it that way in the UI. For `AuctionTaken` that is `max(0, payment − equity)` including written-off negative equity; for `AuctionExpired` it is the negative equity written off. The lane insurance fund pays first, and only what it cannot cover becomes *recorded* lane bad debt. The bench records both (`bench.laneFunds`).
- **`legacyCounterfactual.traderLoss`:** Σ `min(max(equity, 0), notional × LIQUIDATION_FEE_BPS / 10000)` over all started accounts, using equity and notional from `AuctionStarted`. That is the 1% penalty that `liquidateBatch` would have taken at that moment. `traderEquityAtStart` is Σ `max(equity, 0)` over the taken + expired accounts, so **auction trader loss = `traderEquityAtStart − traderResidualReturned`**, directly comparable. The bench also compares per account (`bench.derived.accountsVsLegacy`: how many lost less, the same or more than the legacy penalty).
  - Below about 1% equity both paths leave the trader 0, so the improvement only shows for accounts with equity between the discount actually paid and 2.5% of notional.
- **`externalTakers`:** whether the external takes in this run came from the keeper's demo bots.
- **`underwater`:** `fromBlock` is the shock block and `toBlock` the block of the resolving event. Blocks are `toBlock − fromBlock` (max, nearest-rank p50 and p95). `maxMs` is the largest time from the keeper seeing the shock receipt to it seeing the resolving receipt. Outside crash runs the sweeper also records the first block it saw each account liquidatable (`Sweeper.firstSeen`).
- **`accountsScanned`:** every account registered in the 8 lanes of the lane-sharded design, including ones seeded by earlier runs.

### How the timings are measured (and what they are not)

All times come from the keeper's own clock (`Date.now()`):

- `submittedAt` is taken immediately before `eth_sendRawTransaction`.
- `confirmedAt` is when the keeper's receipt poll first sees the receipt. It therefore includes up to one `KEEPER_RECEIPT_POLL_MS` (25 ms on anvil, 100 ms on Monad by default) plus the RPC round trip.

On anvil, transactions are mined by anvil's interval timer, and anvil executes sequentially. Anvil numbers show that the pipeline works: blocks to resolution, gas, auction outcomes and the dependency graph. They say **nothing** about Monad's parallel execution. Every anvil result is labelled `network: "anvil"`.

## Conflict X-ray

The X-ray shows **storage read/write dependencies between transactions**: the condition under which Monad's optimistic executor has to re-execute a transaction. It does **not** observe Monad's internal re-execution counts. Every report says which method produced it.

```ts
interface XrayReport {
  runId: string; chainId: number; network: "anvil" | "monad-testnet";
  method: "debug_traceTransaction" | "anvil-fork-replay"; forkedFrom?: { chainId: number; block: number };
  designs: Array<{
    design: "paraclr-lanes" | "naive-shared"; contract: `0x${string}`; blocks: number[];
    txs: Array<{ hash; lane: number | null; block: number; index: number; kind: string; reads: number; writes: number }>;
    edges: Array<{ from; to; slots: string[] }>;
    summary: { txs: number; edges: number; longestChain: number; independentTxs: number;
               crossLaneEdges: number; sameLaneEdges: number };                                     // ⁺ lane split
  }>;
  exclusions: string[];
  generatedAt: string; edgeScope: "same-block"; slotLabels: Record<string, string>; notes: string[];   // ⁺
}
```

Method:

1. **Nodes:** every tx whose `to` is the design's contract, in blocks shock+1 … last resolution block, ordered by (block, `transactionIndex`). That includes demo takers' `take` and `closePosition`. `kind` is the decoded function name. `lane` is:
   - the call's lane argument;
   - `laneOf(account)` for `cancelAuction` and `take`;
   - `laneOf(sender)` for trader calls (`closePosition`, `openPosition`, `deposit`, `withdraw`).
2. **Tracing:** each tx is traced twice with `debug_traceTransaction(hash, { tracer: "prestateTracer", tracerConfig: { diffMode } })`.
   - `diffMode: false` gives every account and storage slot the tx touched, read or written. That is its **access set**.
   - `diffMode: true` gives only what changed. A slot set to zero appears only in `pre`, a slot set from zero only in `post`, so the **write set** is keys(pre) ∪ keys(post) plus account fields present in `post`.
   - A same-value SSTORE is not a write: a later reader still reads the value it would have read.
   - Keys are `<address>:<slot>` or `<address>:balance|nonce|code`.
3. **Edge i → j:** i and j are in the **same block**, i comes before j, and `write(i) ∩ access(j) ≠ ∅` (j read or wrote a slot i wrote). The edge lists those slots. Txs in different blocks are already ordered by consensus; optimistic re-execution only happens inside a block, so `edgeScope` is `"same-block"`.
4. **Summary:**
   - `edges` is the number of (i, j) pairs.
   - `longestChain` is the longest dependency path, counted in txs (1 when there are no edges).
   - `independentTxs` is the number of txs with no edge at all.
   - `crossLaneEdges` / `sameLaneEdges` split the edges by whether both txs are in the same lane. Several txs of one lane in one block (a demo taker's take, another taker's take, the pool batch, closes) legitimately share that lane's aggregates. The lane design's claim is **zero cross-lane edges**.
   - `reads` is the slots accessed but not modified; `writes` is the slots modified.
5. **Exclusions** (also listed verbatim in every report):
   - each tx's own sender (EOA) `balance` and `nonce`, which change through gas payment, refund and the nonce bump;
   - the block coinbase `balance` (fee credit; on anvil the coinbase is `0x000…000`);
   - transient storage (EIP-1153), which never appears in prestate traces;
   - non-resolution txs (the shock, price pushes, the other design's txs) are not nodes. The price loop is paused for the whole run.
6. **Slot labels:**
   - When `forge` is available, `forge inspect <Contract> storageLayout` runs in a shadow root.
   - Mapping keys are enumerated from what the run touched (accounts, keepers, contracts, market ids, lanes 0–7), so edge slots read like `naive._auctionList[0].length` or `naive._pools[0].cash`.
   - Packed slots list every member they hold (`{started|taken|cancelled|expired}`).
7. **Fallback `anvil-fork-replay`** is used when the RPC's `debug_traceTransaction` doesn't serve `prestateTracer` with `diffMode`; the probe is the first tx. The steps:
   - start `anvil --fork-url <rpc> --fork-block-number <first block − 1> --no-mining --order fifo`;
   - for every block, set the original timestamp and base fee 0;
   - re-send, in original order, the original signed bytes of every tx in that block that targets a traced contract or comes from a traced tx's sender;
   - mine exactly one block, so block numbers match (the discount clock depends on them);
   - trace there.

   Replay status and gasUsed are checked against the originals, and any difference becomes a note. `npm run xray -- --from B1 --to B2 --method fork` forces it. On local runs it reproduced the live-trace graphs exactly (see below).

**Monad testnet and debug tracing** (docs.monad.xyz, read 2026-10-06, not probed live):

- Monad's RPC lists `debug_traceTransaction` / `debug_traceBlockByNumber` / `debug_traceCall`.
- Release v0.12.1 (2025-11-12) added "prestate and statediff tracing" for `debug_traceTransaction` and `debug_traceBlockBy{Number,Hash}`. The API reference lists tracer `callTracer` or `prestateTracer`, with config `diffMode`.
- Monad requires the trace-options object explicitly. Without it the call returns `-32602 Invalid params`, so the keeper always sends it.
- Of the public testnet endpoints, Ankr (`rpc.ankr.com/monad_testnet`) states "`debug_*` methods are not allowed".
- The docs say nothing about debug on QuickNode (`testnet-rpc.monad.xyz`, 50 rps, 25 rps for `eth_call`) or the Monad Foundation endpoint (`rpc-testnet.monadinfra.com`, 20 rps, no batching, archive).
- Monad does not support opcode-level struct logs.

So `XRAY=auto` should get the live method on a provider with the debug namespace enabled. Otherwise it falls back to the fork replay automatically, which needs `anvil` locally and an archive-capable `KEEPER_RPC_URL` for the fork.

`npm run xray -- --from B1 --to B2 [--method auto|debug|fork] [--run-id ID] [--out DIR] [--rpc URL]` runs the X-ray on its own over any block range.

## Measured on local anvil (NOT Monad)

These are from `npm run bench -- --accounts 500 --seed 20261006`, each on a fresh private anvil (`DEMO_TAKER_SEED=20261006 npm run dev:chain -- --port 8645`) with the keeper running, so the crash went through `/crash` and the price loop was paused.

- **Books:** both designs got the **identical** book: the same 500 accounts, 783 positions, 4,753,603 AUSD collateral; per lane 65 / 53 / 65 / 64 / 64 / 55 / 71 / 63. The price loop was paused during seeding, so every position opened at the same mark.
- **Parameters:** `backstopMinDiscountBps` = 75 on every lane (verified after deploy), step 25 bps per block (the contract default; the live production deployment on Monad testnet runs 5 bps per block since 2026-10-08, through the timelock), max 500.
- **Demo external takers:** 24 keeper-run bots (3 per lane), reservations 25–70 bps drawn from seed 20261006 (the bench lists them).
- **Shock:** MON, SOL and BTC together.

| | A: `…22-53-30Z` | B: `…22-54-24Z` | C: `…22-54-58Z` |
| --- | --- | --- | --- |
| Block time | 999 ms | 401 ms | 999 ms |
| Shock | −20% (8000 bps) | −20% | −5% (9500 bps) |
| Auctions started | 96 | 96 | 7 |
| Taken by backstop / external (demo bots) / cured / expired | 80 / 13 / 0 / 3 | 80 / 13 / 0 / 3 | 1 / 6 / 0 / 0 |
| Avg discount of takes | 76.61 bps | 76.61 bps | 64.29 bps |
| Time underwater p50 / p95 / max (blocks) | 4 / 4 / 21 | 4 / 4 / 21 | 4 / 4 / 4 |
| Time underwater max (keeper ms) | 20,988 | 8,407 | 4,024 |
| Trader equity at start (taken + expired) | 9,743.60 AUSD | same | 8,577.80 AUSD |
| Taken from traders: **auctions vs legacy 1% penalty** | **4,642.19 vs 7,082.64 (−34%)** | same | **2,937.70 vs 4,526.41 (−35%)** |
| Per account vs legacy: lost less / same / more | 11 / 85 / **0** | 11 / 85 / **0** | 7 / 0 / **0** |
| Backstop paid | 21,890.10 AUSD | same | 182.89 AUSD |
| Lane-funded shortfall (`badDebt`) / recorded lane bad debt | 292,780.30 / 0 (insurance 800k → 1.404M) | same | 0 / 0 |
| Resolution txs (paraclr) | 52 (8 start, 13 take, 9 pool, 20 close, 2 expire) from 8 keepers + 13 takers | same | 18 |
| Resolution gas used / limit, paraclr · naive | 25.50M / 32.53M · 23.69M / 32.73M | same | 3.59M / 4.52M · 3.50M / 4.54M |
| **X-ray paraclr-lanes**: txs · edges (cross-lane / same-lane) · longest chain · independent | **52 · 34 (0 / 34) · 4 · 22** | **52 · 34 (0 / 34) · 4 · 22** | **18 · 11 (0 / 11) · 5 · 10** |
| **X-ray naive-shared** | **49 · 311 (277 / 34) · 18 · 0** | **49 · 311 (277 / 34) · 18 · 0** | **18 · 27 (16 / 11) · 6 · 0** |

How to read it:

- **Price discovery.** With the demo takers bidding, external takers took 13 of 96 (A) and 6 of 7 (C) accounts at 50–75 bps, below the pool's 75. Everything with non-positive equity still goes to the pool: external takers are paid nothing for it, because the payment is capped at equity.
- **Traders vs legacy.** Auctions took 34–35% less equity than the old 1% `liquidateBatch` penalty, and **no account lost more**. The "same" accounts in A are deeply underwater: both paths leave them 0.
- **Time underwater.** The auction starts in S+1. Demo takers bid from 50 bps (S+3), the pool takes at 75 bps (S+4), which gives p50 / p95 = 4 blocks. The 3 expiries in A (1 in lane 1, 2 in lane 2) hit MAX at S+21: those lanes' 50k pools could not carry them; lane 2's pool took one more account on a retry at S+18. The naive design's single 400k pool took all of its auctions (83 backstop + 13 external, 0 expired). Same total backstop liquidity; pooled capital is more capital-efficient.
- **X-ray.** No resolution tx on the lane-sharded design conflicts with a tx of **another** lane: 0 cross-lane edges.
  - The 34 same-lane edges come from several txs of one lane in the same block (S+4 holds the pool batch, the external takes and the takers' closes): they share `_ledgers[lane].collateral`, `_laneOI[lane][market]` and `_lanes[lane]`. That gives a longest chain of 4.
  - On the naive design the same work forms 311 edges, 277 of them cross-lane, through `_ledgers[0].collateral` (217 edges), `_auctionCounters[0]`, `_auctionList[0]`, `_laneOI[0][*]` and `_lanes[0].insuranceFund`, with a longest chain of 18.
  - Method: `debug_traceTransaction` on anvil. A forced `anvil-fork-replay` reproduced the live-trace graphs exactly on earlier runs.
- **The two designs' auction outcomes match** (equity at start, legacy counterfactual, per-account comparison, takes), except for pool capacity. That confirms the books are identical.

Seeding costs 338k gas used and 372k gas limit per account per design: 169.0M used and 185.9M limit for 500 accounts in 9 txs.

Older single-design results from the legacy path (`bench/results/31337-2026-10-04T15-*.json`, one `liquidateBatch` per lane, 8 txs in the block after the shock, about 74k gas per liquidation) stay as they were. They predate the auction contracts.

Other measured costs (anvil, legacy bytecode, still representative):

| Operation | Gas used |
| --- | --- |
| `setPrices` (3 markets, one price push) | 50.4k (limit 55.5k) |
| Shock (`shockPrices`) | 47.9k (limit 52.7k) |
| Recover | 48.2k |
| Faucet AUSD mint | 51.2k |
| Approve | 46.5k |
| Deposit | 116k |
| `openPosition` | 207k |
| `closePosition` | 93.5k estimated, 74.8k used |
| Withdraw | 70.9k |

## Bench CLI

```bash
npm run bench -- --accounts 500 [--bps 8000] [--seed N] [--rpc URL] [--keeper-url URL] [--standalone] \
                 [--legacy] [--paraclr-only] [--no-xray] [--seed-only] [--fund-backstop AUSD] \
                 [--no-demo-takers] [--taker-seed N] [--out DIR] [--no-recover] [--yes]
```

The bench runs these steps:

1. Generates a deterministic synthetic book (`keeper/src/seed.ts`, which mirrors the app's `generateAccounts`):
   - 1–3 positions per account;
   - market mix MON 45% / SOL 30% / BTC 25%;
   - 60% long;
   - leverage `round(2+18u²)`;
   - margin `10^(1.8+2.4u)` AUSD;
   - cross-margin buffer `0.15+2.5u^1.6`.
2. Pauses the keeper's price loop (`POST /price-loop`), then seeds the **same** book into every design with `seedAccounts`. Chunks stay under `SEED_MAX_TX_GAS` and go out sequentially. `--fund-backstop A` additionally tops every lane pool up to A AUSD of cash; the naive shared pool goes to 8 × A, so total liquidity stays equal. `--seed-only` stops here and resumes the price loop.
3. Sets up the demo external takers from `--seed` (or `--taker-seed`) through `POST /demo-takers`, or in-process. `--no-demo-takers` leaves the pools as the only bidders.
4. Runs crash v2 through the running keeper's `/crash` if one answers for this deployment; otherwise it runs the crash and a sweeper in-process. `--legacy` uses the `liquidateBatch` path.
5. Fetches the X-ray (`/runs/:id/xray`) and computes the naive design's auction outcome from its events.
6. Recovers prices (skip with `--no-recover`).
7. Writes `bench/results/<chainId>-<UTC timestamp>.json` and `bench/xray/<chainId>-<runId>.json`. The results file holds the exact `RunReport` plus a `bench` block:
   - seeding per design;
   - `naive` (auction outcome of the baseline);
   - `demoTakers` (every taker's address, lane and reservation);
   - `laneFunds` (insurance and recorded bad debt before and after, per design);
   - `resolutionGas` (per design);
   - `xray` summary;
   - derived numbers (`byKind` gas, trader loss auctions vs legacy, `accountsVsLegacy`);
   - observed block interval;
   - a check that no other `PriceUpdated` landed between the shock and the last resolution tx.

   **Commit these files.** They are the evidence for the write-up.

On Monad testnet the bench prints a cost estimate and refuses to run without `--yes`.

## Monad testnet runbook

This is the **demo stack** on testnet (`keeper/.env`, MockAUSD / MockOracle, `npm run keeper:init` without `--network` or with `--network monad`). The **production** contract on testnet is `--network testnet` ([above](#production-on-monad-testnet-chain-10143)); since then `deployments/10143.json` is the production set, so the demo stack on testnet needs its own `DEPLOYMENTS_OUT` file.

Monad testnet: chain id 10143, RPC `https://testnet-rpc.monad.xyz`, explorer https://testnet.monadexplorer.com.

Keys never leave your machine. They are generated into `keeper/.env`, which is gitignored and has mode 600. Only addresses are ever printed. **Never paste a private key into a chat, an issue, or a commit.**

### 1. Create the keys

```bash
npm run keeper:init          # writes keeper/.env with 11 fresh keys, prints their ADDRESSES
```

| Role | Env var | Does |
| --- | --- | --- |
| Operator | `OPERATOR_PRIVATE_KEY` | Deploys and owns MockAUSD, MockOracle and both clearinghouses. Sends shock, recover and seeding, and seeds the insurance funds and backstop pools at deploy. Funds the other roles |
| Price pusher | `PRICE_PUSHER_PRIVATE_KEY` | Oracle updater (allowlisted at deploy). Pushes prices |
| Faucet | `FAUCET_PRIVATE_KEY` | Sends `FAUCET_GAS_WEI` MON + 10,000 AUSD to new wallets |
| 8 lane keepers | `KEEPER_PRIVATE_KEYS` (comma-separated, lane i ↔ key i) | Sweeper txs for lane i (start / take / cancel / expire) on both designs |

Separate keys mean separate nonce streams. On Monad the `pending` nonce tag behaves like `latest`, so the keeper tracks nonces locally per key.

If you'd rather use keys you already have, edit `keeper/.env` yourself. The template is in the root `.env.example`, under "Keeper / deploy".

### 2. Fund them (testnet MON)

Monad bills **gas limit × (base fee + priority fee)**. The minimum base fee is 100 MON-gwei, and `eth_maxPriorityFeePerGas` returns 2 gwei, so 1M gas costs about **0.102 MON**. Source: docs.monad.xyz, "Gas pricing" (fetched 2026-10-04).

The estimates below are measured gas **limits** from anvil × 102 gwei:

| What | Gas (limit) | ≈ MON |
| --- | --- | --- |
| Deploy: both designs, 8 × 100k insurance, 8 × 50k backstop pool and the 75 bps threshold on every lane (67 txs, 15.57M used) | 20.72M | **~2.1** |
| Seed 500 bench accounts into **both** designs (operator) | 185.9M + 183.3M = 369.2M | **~37.7** (200 accounts ≈ 15; `--paraclr-only` halves it) |
| One crash run v2, 500 accounts, both designs, with demo takers: 52 + 49 txs | 32.5M + 32.7M = 65.3M | **~6.7** total |
| … of which lane keepers (start / pool / expire) | ≈ 48.6M; busiest lane ≈ 5.1M per design | ≈ 1.0 for the busiest keeper |
| … of which demo takers (take + close) | ≈ 16.5M; busiest taker ≈ 1.1M per design | ≈ 0.22 for the busiest taker |
| Demo takers on Monad (`DEMO_TAKERS=1`, off by default): 24 × `DEMO_TAKER_GAS_MON` (0.5) transferred once, plus collateral seeding | ~0.5M seeding gas | **~12** (stays in the taker wallets) |
| One crash run v2, 500 accounts, `--paraclr-only` | ≈ 32.5M | ~3.3 |
| `--fund-backstop` deposits (optional; the deploy already seeds the pools) | ~0.1M per lane pool | ~0.01 each |
| Shock / recover (operator) | ~53k each | ~0.005 each |
| One price push (pusher) | 55.5k | 0.0057, so **~20 MON/hour at `PRICE_PUSH_MS=1000`**, ~6.8/hour at 3000 |
| One faucet drip (faucet) | ~77k + the MON it gives (`FAUCET_GAS_WEI`, default 0.2) | ~0.21 |
| User trade cycle: approve + deposit + open + close (user wallet) | ~463k | ~0.05 |
| Sweeper outside crash runs | `eth_call`s only; txs only when accounts become liquidatable | ~0 |
| X-ray | `debug_traceTransaction` calls only | 0 |

Suggested balances for one 500-account bench on both designs plus a demo session:

| Role | Suggested |
| --- | --- |
| Operator | ~42 MON for itself (deploy 2 + seeding 38 + shocks), plus whatever it hands out in step 3 |
| Price pusher | 5 MON (about 15 min of continuous 1 Hz pushing; see the idle pause below) |
| Faucet | 12 MON (see the reserve note) |
| Each keeper | 2 MON (one crash run on both designs costs ≈ 1.0 for the busiest keeper) |

That totals about **75 MON** (about 87 MON with `DEMO_TAKERS=1`). If MON is scarce:

- run the bench with `--accounts 200` (saves about 23 MON);
- use `--paraclr-only` (saves about 19 MON on seeding and 3.3 per run, but gives no naive X-ray contrast);
- leave `DEMO_TAKERS` off (the default on Monad). The pools are then the only bidders, at 75 bps;
- set `PRICE_PUSH_MS=3000`;
- set `FAUCET_GAS_WEI=0` (AUSD only) and give the faucet 1 MON.

**Reserve balance** (docs.monad.xyz, "Reserve balance"). A transaction that sends **value** may not take its sender below min(starting balance, 10 MON), unless it is the sender's first tx in 3 blocks. Zero-value txs (pushes, sweeper txs, seeding) are never reverted by this rule. What it means here:

- The faucet should hold more than 10 MON plus its budget. Below that, drips work only when they are about 1.2 s apart, and a revert comes back as 502.
- `keeper:fund` waits 3 blocks between transfers, so every transfer qualifies for that exception.

Steps:

1. Get MON for the **operator** address from the Monad testnet faucet (linked from docs.monad.xyz) or from your own wallet.
2. Preview the top-ups with `npm run keeper:fund`. This is a dry run that shows every role's balance against its target. Targets are `FUND_PUSHER_MON`, `FUND_FAUCET_MON` and `FUND_KEEPER_MON` (MON, defaults 5 / 12 / 2).
3. Run `npm run keeper:fund -- --send`. The operator tops everyone up.

### 3. Deploy

```bash
npm run deploy:monad         # forge script … --broadcast --slow, keys from keeper/.env
```

This writes `deployments/10143.json` (addresses including `naive`, markets, and the exact `deployBlock` from the receipts). **Commit that file.** The app imports it. The wrapper warns if the operator holds less than 3 MON, and verifies `backstopMinDiscountBps` = `BACKSTOP_MIN_DISCOUNT_BPS` (75) on every lane of both designs.

Optional settings in `keeper/.env`:

- `KEEPER_RPC_URL` points at a dedicated Monad RPC (QuickNode or Alchemy). The public RPC limits `eth_getLogs` to 100 blocks, allows 25 `eth_call`/s, and may not serve `debug_*`. The sweeper's per-block scans during a crash run on both designs exceed 25 calls/s, so use a dedicated endpoint for the bench, ideally one with the debug namespace for the live X-ray.
- `LANE_SEED` changes the insurance seed per lane (default 100,000 AUSD), and `BACKSTOP_SEED` the backstop pool seed per lane (default 50,000 AUSD). The operator mints both, so they cost no MON.

### 4. Run the keeper

```bash
npm run keeper               # reads keeper/.env → "Monad testnet · chain 10143"
curl -s localhost:8787/health | jq '{network, block, crashed, prices, sweeper}'
```

At startup the keeper:

- verifies that the deployment addresses have code;
- detects the auction API from the bytecode;
- logs every role's balance;
- adds the price pusher to the oracle's updater allowlist if it is missing.

On Monad it uses these defaults:

- **Idle pause.** Price pushes pause after `PRICE_PUSH_IDLE_MS=600000` (10 min) without any HTTP request. Any request wakes the loop, so the app should poll `/health` every few seconds while open.
- **Sweeper.** It sweeps at most once per `SWEEPER_MIN_INTERVAL_MS=1000` outside crash runs, and every block during a run.
- **Faucet.** The cooldown is 1 h per address, and each drip gives 0.2 MON.
- **Receipts** are polled every 100 ms.

For a hosted app the browser must reach the keeper over HTTPS, for example on a small VM or through a tunnel. Then set:

- `KEEPER_CORS_ORIGIN=https://your-app.example` in `keeper/.env`;
- `NEXT_PUBLIC_KEEPER_URL` in the app.

### 5. Run the measured bench on Monad

```bash
npm run bench -- --accounts 500 --yes      # keeper running → crash goes through /crash
git add bench/results/10143-*.json bench/xray/10143-*.json deployments/10143.json
```

The result is labelled `network: "monad-testnet"` and `measuredOn: "Monad testnet"`. The X-ray says whether it was a live `debug_traceTransaction` or an `anvil-fork-replay` (with `forkedFrom`). The anvil files stay labelled anvil. Never mix them.

## Arena mode (`--arena`)

The public `/arena` page (src/app/arena) is driven by the demo keeper in arena mode
(keeper/src/arena.ts): anyone presses "Crash the market −20%" and every viewer watches the same run.

```bash
# Demo stack on Monad testnet (keys from keeper/.env; never commit them)
DEPLOYMENTS_OUT=deployments/demo/10143.json KEEPER_PORT=8791 \
ARENA_ADMIN_TOKEN=<long random string> KEEPER_CORS_ORIGIN=https://your-app.example \
npm run keeper -- --arena            # or ARENA=1

# The page (any host): NEXT_PUBLIC_ARENA_KEEPER_URL=https://<arena keeper>
```

One cycle: `seeding → ready → crashing → resolving → xray → recovering → seeding → ready`.

- **seeding**: a fresh book of `ARENA_PER_LANE` (3) keyless accounts in each of the 8 lanes, identical in both designs, from a new seed each cycle. Accounts are sized against the shock: most go underwater (positive equity left), a few go below zero (lane-funded shortfall), a few stay healthy, and one gets an operator-funded top-up mid-auction so it is cured (`ARENA_CURE=0` disables it). Backstop pools below half of `ARENA_BACKSTOP_CASH` (500k AUSD per lane) are topped up.
- **crashing / resolving / xray**: the normal crash run (`/crash` logic): one `shockPrices`, the sweeper resolves every auction on both designs, then the Conflict X-ray.
- **recovering**: one `setPrices` back to the baseline.

Prices are held at a baseline between crashes in arena mode: no random-walk price loop, and the sweeper only runs inside crash runs. The baseline, the cycle counters and the uncrashed book live in `keeper/.arena/<chainId>-<clearinghouse>.json` (gitignored). A restart reuses a book that was seeded but never crashed.

| Route | |
| --- | --- |
| `GET /arena` | `state`, `canCrash`, `reason {code, message}`, `cooldownRemainingS`, `current {runId, shockBlock}`, `last` (blocks to resolve per design, the naive design's auction summary, xrayId, recover tx), `book.designs[].lanes[].accounts[]` (state, live discount, equity / residual / bad debt / fixed penalty), `feed`, `budget` (daily count, refuelling, balances, thresholds, `lastCycleCost`), `limits` |
| `POST /arena/crash` | `202 {runId}`, or `409 {error, code}` with code `running`, `seeding`, `starting`, `error`, `cooldown`, `daily-cap`, `refuelling` or `ip-limit` (+ `retryAfterS`) |
| `POST /crash`, `/recover`, `/price-loop`, `/demo-takers`, `/faucet` | `403` unless header `x-admin-token` = `ARENA_ADMIN_TOKEN` (always refused when it is unset) |

Every other GET (`/health`, `/sweeper`, `/runs/:id`, `/runs/:id/xray`, `/solvency`, `/backstop`) stays public.

| Variable | Default | |
| --- | --- | --- |
| `ARENA_COOLDOWN_S` | 180 | after each cycle is back to ready |
| `ARENA_IP_WINDOW_S` | 600 | one crash per IP per window |
| `ARENA_TRUST_PROXY` | off | `1`: client IP = first `X-Forwarded-For` hop (only behind your own proxy) |
| `ARENA_DAILY_MAX` | 40 | cycles per UTC day |
| `ARENA_MIN_OPERATOR_MON` / `ARENA_MIN_KEEPER_MON` | 1.5 × the last measured cycle (first cycle on Monad: 2.5 / 0.3) | gas guard: below it, "Arena is refuelling" |
| `ARENA_PER_LANE`, `ARENA_BPS`, `ARENA_BACKSTOP_CASH`, `ARENA_CURE`, `ARENA_POLL_MS`, `ARENA_STATE_FILE`, `ARENA_REF_GAS_GWEI` | 3, 8000, 500000, 1, 500 (anvil 250), see above, 102 | |

**Cost per cycle**, measured on local anvil (gas limits × 102 gwei, which is what Monad bills): about **2.45 MON** per cycle at 3 accounts per lane. Seeding 48 accounts (both designs) is about 13.6M gas (1.39 MON, operator). The sweeper's 34 txs are about 10.2M gas (1.05 MON across the 8 lane keepers, busiest key about 0.16 MON). Shock, two cure top-ups and recover add about 0.25M gas (0.025 MON). The first cycle also tops up the backstop pools (9 deposits, about 0.6M gas). `GET /arena` reports the live figure as `budget.lastCycleCost` (Monad: at the live gas price). At 40 cycles a day that is about 100 MON a day; `ARENA_PER_LANE=2` cuts seeding by a third.

## Configuration (`keeper/.env`)

| Variable | Default (anvil / monad) | Meaning |
| --- | --- | --- |
| `KEEPER_RPC_URL` | `http://127.0.0.1:8545` | Chain RPC. The network is detected from the node: anvil by its client version (even when forking chain 10143), Monad by chain id 10143 |
| `OPERATOR_PRIVATE_KEY` | anvil #0 / **required** | Owner key |
| `PRICE_PUSHER_PRIVATE_KEY` | anvil #1 / **required** | Oracle updater |
| `FAUCET_PRIVATE_KEY` | anvil #2 / **required** | Faucet |
| `KEEPER_PRIVATE_KEYS` | anvil #3–10 / **required** (8, comma-separated) | Lane keepers |
| `KEEPER_PORT` | 8787 (private stacks: 8787 + port − 8545) | HTTP port |
| `KEEPER_CORS_ORIGIN` | `*` | `*` or comma-separated origins |
| `DEPLOYMENTS_OUT` | `deployments/<chainId>.json` (private stacks: `contracts/cache/dev-chain/<port>/deployments.json`) | Deployment file the deploy writes and the keeper and bench read |
| `PRICE_PUSH_MS` | 1000 | Price push interval (minimum 200) |
| `PRICE_PUSH_IDLE_MS` | 0 / 600000 | Pause pushes after this long with no HTTP traffic (0 = never) |
| `PRICE_LOOP` | on | `off` disables pushes |
| `SWEEPER` | 1 | `0` disables the per-block sweeper (crash runs still start it for the run) |
| `SWEEPER_POLL_MS` | 50 / 100 | Head polling interval |
| `SWEEPER_MIN_INTERVAL_MS` | 0 / 1000 | Minimum time between sweeps outside crash runs |
| `SWEEP_NAIVE` | `crash` | Sweep the naive baseline only during crash runs, `always`, or `off` |
| `BACKSTOP_MIN_DISCOUNT_BPS` | 75 | Deploy: the backstop take threshold set on every lane of both designs (verified after deploy). Keeper: fallback only if `backstopMinDiscountBps(lane)` can't be read |
| `AUCTION_STEP_BPS` / `AUCTION_MAX_DISCOUNT_BPS` | 25 / 500 | Fallbacks only; the contract's `auctionStepBps()` and `auctionMaxDiscountBps()` are used when readable |
| `DEMO_TAKERS` | 1 / 0 | Keeper-run demo external takers |
| `DEMO_TAKER_SEED` / `DEMO_TAKERS_PER_LANE` | 1 / 3 | Their keys and reservations (the bench re-derives them from `--seed`) |
| `DEMO_TAKER_MIN_BPS` / `DEMO_TAKER_MAX_BPS` | 25 / 70 | Reservation discount range |
| `DEMO_TAKER_COLLATERAL` | 250000000000 | AUSD (6dp) of collateral per taker per design |
| `DEMO_TAKER_GAS_MON` | 0.5 | Monad only: MON the operator sends each taker for gas |
| `CRASH_RESOLVE_TIMEOUT_MS` | 180000 | Give up waiting for a crash run's auctions to resolve |
| `XRAY` | `auto` | `auto` (debug trace, else fork replay) \| `debug` \| `fork` \| `off` |
| `XRAY_DIR` | `bench/xray` (private stacks: `contracts/cache/dev-chain/<port>/xray`) | Where the keeper writes X-ray JSONs |
| `FAUCET_GAS_WEI` | 10 ETH / 0.2 MON | Native gas per drip (skipped if the wallet already has it) |
| `FAUCET_AUSD` | 10000000000 | AUSD per drip (6dp; 10,000 is the MockAUSD per-call cap) |
| `FAUCET_COOLDOWN_MS` | 5000 / 3600000 | Per-address rate limit |
| `KEEPER_GAS_MARGIN_BPS` | 1000 | Gas limit = `estimateGas × (1 + bps/10000)`. Monad bills the limit, so keep it small |
| `KEEPER_MAX_TX_GAS` | 30000000 | Split a batch above this. Monad's documented per-tx limit is 30M |
| `SEED_MAX_TX_GAS` | 30000000 | Gas cap per `seedAccounts` tx (bench) |
| `KEEPER_RECEIPT_POLL_MS` | 25 / 100 | Receipt poll interval. This is the observation lag in `confirmedAt` |
| `KEEPER_RECEIPT_TIMEOUT_MS` | 60000 | Give up waiting for a receipt |
| `KEEPER_RPC_BATCH` | on | `0` disables JSON-RPC batching, for RPCs that reject batch requests |
| `LANE_SEED` / `BACKSTOP_SEED` | 100000000000 / 50000000000 | Deploy only: AUSD (6dp) per lane insurance fund / backstop pool |
| `FUND_PUSHER_MON` / `FUND_FAUCET_MON` / `FUND_KEEPER_MON` | 5 / 12 / 2 | `keeper:fund` targets |
| `KEEPER_ENV_FILE` | `keeper/.env` | Alternate env file |

## Troubleshooting

- **`No deployment file …` or "addresses with no code".** Anvil restarted without a deploy. Run `npm run dev:chain` (or with `--port P` for a private stack).
- **`port 8787 is in use`.** Another keeper is running. `dev:chain` reuses it; set `KEEPER_PORT` to run a second one.
- **`features.auctions: false` in `/health`.** The deployed bytecode predates the auction contracts. Run `npm run dev:chain -- --redeploy`. Until then `/crash` uses the legacy path and `/solvency` and `/backstop` answer 501.
- **A crash run fails with "auctions not resolved within …".** Check `GET /sweeper`: `lastError`, the per-design `liquidatable` / `inAuction` counts, and the recent txs.
- **Faucet 502 on Monad.** The faucet key is below the 10 MON reserve and sent twice within 3 blocks. Top it up with `npm run keeper:fund -- --send`.
- **A crash leaves `crashed: true`.** By design. Call `POST /recover`. The price loop stays paused until you do.
- **The bench says "a keeper is running … would race the standalone crash".** Drop `--standalone` so the crash goes through the keeper.
- **The bench printed "the keeper price loop may still be paused".** Run `curl -X POST localhost:8787/price-loop -H 'content-type: application/json' -d '{"paused":false}'`.
