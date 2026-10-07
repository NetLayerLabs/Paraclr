# Paraclr production runbook: guarded beta on Monad mainnet (chain 143)

This runbook is for the person who holds the keys. The interface contract is [`PRODUCTION_PLAN.md`](PRODUCTION_PLAN.md). Hosting is covered in [`keeper/HOSTING.md`](../keeper/HOSTING.md), and keeper internals in [`keeper/README.md`](../keeper/README.md#production-monad-mainnet).

> Unaudited beta · capped · use only what you can afford to lose.

Every command below that sends a transaction on Monad mainnet first prints balances and a cost estimate. It then refuses to continue unless you add `--yes-mainnet`. The same commands also run against an anvil fork; that is how `npm run rehearse:mainnet` exercises all of them.

## 0. Roles and keys

| Role | What it can do | Where it lives | Env var |
| --- | --- | --- | --- |
| **Owner (multisig)** | Behind the `TimelockController`:<br>• every parameter, oracle, role and unpause change<br>• only after `TIMELOCK_MIN_DELAY_SECONDS` (24 h) | A Safe (v1.3.0 and v1.4.1 are deployed on Monad mainnet, verified 2026-10-07). DeployProd **refuses an owner without code** unless `OWNER_IS_EOA=true` (hardware wallet). **Never on a server** | `OWNER_MULTISIG_ADDRESS` (address only) |
| Deployer | Deploys and wires the set, then hands everything to the timelock. Powerless afterwards (verified on chain) | your machine, only for the deploy | `DEPLOYER_PRIVATE_KEY` |
| Guardian | `pause()` only. Cannot unpause, change parameters or move funds | separate machine (laptop or phone wallet) | `GUARDIAN_PRIVATE_KEY` |
| Ops | `updateFunding` (anyone may call it); monitoring reads | keeper host | `OPS_PRIVATE_KEY` |
| 8 lane keepers | Execute their lane's orders and run its auctions; keeper i is the backstop operator of **lane i only** (`backstopReduce`). Push Pyth prices on demand. Earn the users' execution fees | keeper host | `KEEPER_PRIVATE_KEYS` (lane i ↔ key i; all distinct) |
| Treasury | Seeds lane insurance and backstop pools (`fundLane` and `backstopDeposit` are permissionless) | Safe (can be the owner Safe) | — |

How keys are created:

- `npm run keeper:init -- --network mainnet` generates every hot key into `keeper/.env.mainnet` (mode 600) and prints **addresses only**.
- It never overwrites an existing key without `--rotate <role>` or `--force`.

Never paste a key anywhere.

## 1. Before deploying

1. **Launch gate.** Read section 3. If the gate can't pass, do not deploy with real AUSD.
2. **Keys and env file.**
   - Run `npm run keeper:init -- --network mainnet`.
   - Fill in `OWNER_MULTISIG_ADDRESS`, `KEEPER_CORS_ORIGIN`, `PYTH_API_KEY` and `ALERT_WEBHOOK_URL` in `keeper/.env.mainnet`.
   - Use a paid `KEEPER_RPC_URL`.
3. **Pyth API key.** Hermes answers **401 without an API key** since 2026-08-26 (`Authorization: Bearer $PYTH_API_KEY`). Get a key from the Pyth Terminal. The keeper refuses to start without one.
4. **Funding interval.** The contract default is `FUNDING_INTERVAL_SECONDS=60`.
   - The keeper only updates funding when the rate would change by more than 5 %, or once an hour (section 8). That keeps the cost low at any interval.
   - If you don't trust the policy, raise the interval at deploy time instead (e.g. `FUNDING_INTERVAL_SECONDS=900` in `keeper/.env.mainnet`).
5. **Execution fee.** The default is `MIN_EXECUTION_FEE_WEI` = 0.1 MON, and the user pays it per order.
   - Measured keeper cost per execution (contract v3): ≈ 444k gas limit on average × 102 gwei ≈ **0.045 MON**; a multi-leg order with its appended update 674k ≈ 0.069 MON (section 8b).
   - 0.1 MON covers the worst case up to about 145 gwei. If Monad's base fee rises, raise it through the timelock: `setOrderParams`.
6. **Fund the deployer.** Run `npm run keeper:fund -- --network mainnet --roles deployer` to preview, then add `--send --yes-mainnet --funder-env FUNDER_PRIVATE_KEY` to send.
   - The deploy needs about 1.8 MON: 17.57M gas limit × 102 gwei (DeployProd v3, 21 txs).
   - The preview target includes forge's 1.3 margin and the safety factor (≈ 3 MON).
7. **Rehearse on a fork** with today's code: `npm run rehearse:mainnet` (section 10). All steps must pass.

## 2. Deploy

```bash
npm run deploy:mainnet                    # dry run: preflight + cost, then refuses
npm run deploy:mainnet -- --yes-mainnet   # real deploy
```

The wrapper (`scripts/deploy-mainnet.ts` → `scripts/lib/prod-deploy.ts`) runs these steps:

1. **Preflight**, all on chain:
   - AUSD has code, 6 decimals, and is the verified Agora address `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a`;
   - Pyth has code, reports `version()` (1.4.6), is `0x2880aB155794e7179c9eE2e38200202908C17B43`, and every feed is stored;
   - the owner is a Safe (owners and threshold ≥ 2 are printed); an owner without code passes only with `OWNER_IS_EOA=true` (it must then be a hardware wallet);
   - the owner is not a hot key, and the guardian and the 8 keepers are distinct keys (DeployProd maps keeper i → lane i and refuses duplicates);
   - the timelock delay is at least 1 h; `MAX_STORED_PRICE_AGE_SECONDS` ≤ `MAX_PRICE_AGE_SECONDS` ≤ 60.
2. **Pyth feeds pushed recently.** DeployProd requires every feed to have been pushed on chain within `PYTH_MAX_FEED_AGE_SECONDS` (1 h). Third parties push MON/SOL/BTC ~115–225 times an hour (measured), so normally nothing is needed; if a stored price is older, the wrapper pushes the latest Hermes update (`updatePriceFeeds`, ~160k gas, fee 0) first.
3. **Forge.** It runs `forge script contracts/script/DeployProd.s.sol --broadcast --slow --code-size-limit 131072`. The contract is 50,051 B (v3): over EIP-170's 24 KB, under Monad's 128 KB. Forge gets the deployer key and role **addresses** only (`GUARDIAN_ADDRESS`, `KEEPER_ADDRESSES`); every other secret is stripped from its environment.
4. **Post-deploy verification**, all on chain:
   - `owner()` is the timelock;
   - the timelock's delay is set, and the multisig holds proposer, executor and canceller;
   - **the deployer holds no timelock role and is not a backstop operator on any lane**, and execution is not open to anyone;
   - **keeper i is the backstop operator of lane i only** (an 8 × 8 matrix check);
   - `guardian()` is set; caps, leverage, AUSD, Pyth, feeds and market ids are as configured;
   - `maxStoredPriceAge` (15 s), `maxPriceAge` (30 s), `minExecDelay` (3 s) and `backstopWithdrawDelay` (1 h) match the env;
   - `"production": true` and the `params` keys (`maxStoredPriceAgeSeconds`, `backstopWithdrawDelaySeconds`; v3 adds `topUpTargetBps`, `backstopWithdrawWindowSeconds`) are in the file.

   Any ✗ exits non-zero and means: do not announce or fund the deployment.

It writes `deployments/143.json` (commit it; the app reads it) and a verification report at `contracts/cache/deploy-mainnet/143-<time>-verify.json`.

After the deploy:

- **Sweep the deployer's leftover MON**, then delete `DEPLOYER_PRIVATE_KEY` from every machine except cold backup.
- **Seed lanes** (section 4). Until lane insurance is funded, **every OI cap is 0** and no position can open.
- **Fund the hot keys:** `npm run keeper:fund -- --network mainnet --send --yes-mainnet --funder-env FUNDER_PRIVATE_KEY`.
- **Start the keeper** (`keeper/HOSTING.md`) and watch `/health` and the webhook.
- **Rebuild the keeper image** so it contains `deployments/143.json`.

## 3. Launch gate (no exceptions; from PRODUCTION_PLAN.md)

Launch with real AUSD **only if all of these hold**:

- [ ] Full forge suite passes, including the invariants (contracts agent).
- [ ] Slither: every high and medium finding fixed or justified in writing. Run it with `--ignore-compile`; it once ran `forge clean`.
- [ ] Adversarial internal review done, all criticals fixed.
- [ ] `npm run rehearse:mainnet` passes on a fork of **today's** mainnet with **this** commit.
- [ ] The deployed caps are the beta values: 50 AUSD per account, 500 AUSD per lane TVL, 10x. Confirm in the verification report.
- [ ] Owner is a Safe with threshold ≥ 2, or a hardware wallet. Guardian key is offline, away from the keeper host.
- [ ] `PYTH_API_KEY` works (the keeper's Hermes preflight prints `Hermes OK`), and `ALERT_WEBHOOK_URL` delivers (the `keeper:start` alert arrives).
- [ ] Lane insurance and backstop pools are seeded (section 4); `/health` shows `solvency.solvent: true`.
- [ ] The beta labels are live in the app ("Unaudited beta · capped · use only what you can afford to lose").

If any box stays open, the hackathon submission falls back to testnet / no value, and production ships after an external audit.

## 4. Seeding lane insurance and backstop pools (treasury Safe)

The per-lane per-side OI cap is `min(maxLaneOi, lane insurance × oiCapMultiplier)` (5×; **pool deposits do not count** since v2). With no insurance it is 0 and no position can open. 200 AUSD of insurance per lane allows 1,000 AUSD of open interest per side per lane.

```bash
npm run timelock -- --network mainnet seed --insurance 200 --pool 100
```

This writes **one Safe Transaction Builder file**: AUSD `approve`, then `fundLane(lane, 200 AUSD)` and `backstopDeposit(lane, 100 AUSD, [])` for each of the 8 lanes, 4,800 AUSD in total. No timelock is involved; both calls are permissionless.

- Import the file in the treasury Safe's Transaction Builder and sign it.
- Pool deposits count toward each lane's 500 AUSD TVL cap. Pool shares belong to the Safe; it withdraws them in two steps (section 4b).
- Fresh deposits and pool deposits into a lane **with bad debt** revert `LaneInDeficit`: seed before trading starts, and repair deficits as in section 13b.

## 4b. LP withdrawals are two-step

1. **Request:** `backstopRequestWithdraw(lane, shares)` (works while paused; `0` cancels). The keeper's `/backstop?lp=0x…` (`withdrawRequest`) and the contract's `backstopWithdrawRequest(lane, lp)` show `readyAt` and `expiresAt`.
2. **Withdraw** after `backstopWithdrawDelay` (1 h) and within the **1 h window** (v3): `backstopWithdraw(lane, shares, priceUpdate)` at the NAV of that moment (pass a fresh update from the `/hermes` proxy if the pool holds positions). Too early → `WithdrawNotReady`; too late → `WithdrawRequestExpired`. A request is **single-use** (v3): any withdrawal consumes it, so request the full amount you want and withdraw it in one call.
- Payouts are haircut if the lane has bad debt (`previewWithdraw`; `BackstopWithdraw` carries the amount paid). NAV counts unrealised gains only up to lane insurance (v3). Pool cash used by the loss waterfall is a **loan** (`backstopReceivable`, shown per lane in `/backstop`), repaid from lane inflows before insurance (`BackstopRepaid`). If the pool's equity goes to zero while flat, all shares are retired (`BackstopPoolReset`, new epoch): old shares read as 0.
- The rehearsal runs it for the treasury (request → `WithdrawNotReady` → 1 h → withdraw inside the window → reusing the request → `NoWithdrawRequest`).
- The rehearsal executes exactly this batch on the fork.

## 5. Running the keeper

Command: `npm run keeper -- --network mainnet --yes-mainnet`, or the container (`keeper/HOSTING.md`). At startup it:

- prints the hot-key balances and the expected MON burn;
- checks Hermes, and refuses on a missing or rejected `PYTH_API_KEY`;
- backfills recent orders from the logs.

It then runs four loops on chain time:

- **Executor.** Per-lane delayed-order execution with the first Pyth update at or after `execAfter` (that update only). If the account holds other legs, their price comes from Pyth storage or the lane's last price (≤ 15 s): the keeper pushes the stale feeds first (section 8b).
- **Funding.** The change-triggered policy in section 8.
- **Sweeper.** Auctions, with a fresh Pyth update in every transaction. Batches are **chunked by measured gas** below 24M (30M per-tx limit × 0.8): ~74–79k gas per account to start an auction and ~95–97k to take one, so 30M fits only ~300–400 accounts (measured on a 600-account lane: 3 start txs + 4–5 take txs, max 23.9M). Cure = equity ≥ maintenance (v3; 110 % on v2, read from the contract) and not in the start block. On v3 `startAuctions` closes out negative-equity accounts at once (counted as expired), and a reduce-only order may execute for an account in auction (it then ends the auction).
- **Monitor.** Balances, oracle, stored-price age, pause, per-lane solvency, token-level solvency, risk events, caps and governance.

It claims each keeper's execution fees (≥ 1 MON) and expiry rewards (≥ 1 AUSD) every 10 minutes.

HTTP endpoints:

- `/health`: `production: true`, `paused`, `caps`, `priceSource: "pyth"`, `hotKeys`, `solvency`, `oracle.hermes`, `executor`, `funding`, `sweeper` and active alerts;
- `/orders?account=0x…`, `/solvency`, `/backstop`, `/alerts`, `/txs`;
- `/hermes/v2/updates/price/{latest|t}` for the app, so the key stays server-side.

The demo endpoints answer **403**.

### Alert catalogue (webhook: Discord, Slack or any JSON receiver)

| Key | Severity | Meaning | Do |
| --- | --- | --- | --- |
| `hermes:auth` | critical | Hermes 401/403: key missing, expired or out of quota | fix `PYTH_API_KEY`, restart |
| `hermes:down` | critical | no Hermes answer for 30 s; executions and auctions are stalled | check Hermes status. Optionally add `PYTH_HERMES_FALLBACK_URLS=https://pyth.dourolabs.app/hermes`. Orders expire after 60 s and users cancel them (escrow and fee refunded) |
| `exec:late:<lane>` | warning | an order landed more than 10 s after `execAfter` | check RPC latency and the keeper's balance |
| `exec:failed:<lane>` | warning / critical | execution reverted, was lost, or does not simulate 3 times | read `/orders` and `/txs`; check the key's balance and nonce |
| `exec:expired:<lane>` | critical | an order passed its deadline unexecuted (keeper-side by construction) | find the cause (Hermes, RPC, balance). The user, or anyone, can `cancelOrder` it |
| `exec:unfillable:<lane>` | warning | the pinned update is past the deadline, or its confidence is too wide | informational; the order expires |
| `oracle:stale:<market>` | warning > 15 s, critical > 60 s | the latest Pyth price is old | Pyth or Hermes issue; nothing executes on stale prices (the contract reverts) |
| `oracle:conf:<market>` | warning ≥ 80 % of `maxConfBps`, critical above it | wide confidence | the contract rejects these prices; consider pausing if it persists in volatile markets |
| `paused` / `pause` | warning / critical event | the contract was paused or unpaused | expected after a guardian action; otherwise investigate immediately |
| `solvency:lane<i>` | critical | `laneSolvency(i).surplus < 0`: the lane owes more than it holds (bad debt beyond insurance); withdrawals are haircut by `haircutBps`, fresh deposits revert `LaneInDeficit` | section 13b |
| `solvency` | critical | `solvency()` is false: AUSD held < Σ lane holdings, a **token-level** loss (issuer burn / freeze) | **pause** (section 6) and start incident response |
| `haircut:lane<i>` | warning (event) | a withdrawal / pool withdrawal / reward claim in lane i was haircut (`LaneHaircut`) | section 13b |
| `pool:loss:lane<i>` | warning (event) | the lane's pool cash absorbed a loss insurance could not (`BackstopLossAbsorbed`) | watch the pool NAV; repair as in 13b if it continues |
| `pool:reset:lane<i>` | critical (event) | an insolvent flat pool was reset, all LP shares retired (`BackstopPoolReset`) | communicate to LPs; re-seed the pool from the treasury |
| `auction:skipped:lane<i>` | warning (event) | a batch skipped an account it could not price (`AccountSkipped`) | usually a stale/wide feed; it is retried with the next update. Persisting → check `oracle:*` |
| `lane:insolvent:<i>` | critical | a keeper tx reverted `LaneInsolvent` | section 13b |
| `pool:repaid:lane<i>` | info (event, v3) | lane inflows repaid the pool's loss loan (`BackstopRepaid`) | none |
| `pool:netted:lane<i>` / `pool:swept:lane<i>` | info / warning (events, v4) | the pool's receivable was netted (`BackstopReceivableNetted`); share supply hit 0 and orphaned cash was swept to insurance with the receivable forgiven (`BackstopSwept`) | informational; re-seed the pool if it is now empty |
| `gov:feed` | critical (event, v3) | a market's Pyth feed was replaced through the timelock (`MarketFeedReplaced`); the keeper switches live | expected after a dead-feed swap (13c); otherwise investigate immediately |
| `solvency:native` | critical | MON held < escrow + owed | pause, investigate |
| `balance:<role>` | warning; critical below ¼ of the threshold | hot key low (thresholds `ALERT_MIN_*_MON`) | `keeper:fund` (section 9) |
| `funding:overdue:<market>` | critical | the funding rate was not recomputed for the policy maximum + 2 intervals | check the OPS key's balance and `/health.funding` |
| `funding:failed` | warning | an `updateFunding` tx reverted or was lost | check `/txs` |
| `auction:failed:<lane>` | critical | an auction tx reverted or was lost | check `/txs` and the keeper's balance; the auction continues to MAX and then expires |
| `cap:tvl:lane<i>` / `cap:oi:lane<i>:<m>` | warning | utilisation ≥ 80 % | informational; raise caps through the timelock if intended |
| `gov:owner` | critical | `owner()` is no longer the timelock | **incident**: governance changed |
| `ausd:paused` / `ausd:frozen` | critical | Agora paused AUSD transfers, or froze the clearinghouse (issuer powers, verified on chain) | pause; contact Agora; communicate |
| `ausd:depeg` | warning > 50 bps, critical > 200 bps | Pyth AUSD/USD off peg (the contract treats 1 AUSD = 1 USD) | consider pausing; widen nothing |
| `rpc:stalled` | critical | no new block for 15 s | RPC down; switch `KEEPER_RPC_URL` |
| `keeper:start` / `keeper:stop` | info / warning | process lifecycle | — |

## 6. Pause

```bash
npm run guardian:pause -- --network mainnet --status        # state, guardian match, balance
npm run guardian:pause -- --network mainnet --yes-mainnet   # pause
```

Run it from the guardian machine (`GUARDIAN_PRIVATE_KEY` in its local `keeper/.env.mainnet`).

Pause **blocks new risk only**:

- deposits from accounts without positions;
- backstop deposits;
- committing and executing **increase** orders.

These **keep working**:

- withdrawals;
- reduce and close orders;
- cancellations;
- liquidations and auctions;
- pool withdrawals;
- funding updates;
- claims.

The rehearsal verified this on the fork, and ran liquidations while paused on the MockPyth leg.

Optional: `AUTO_PAUSE_ON_INSOLVENCY=1` makes the keeper pause the moment `solvency()` reads false. It needs the guardian key on the keeper host, which is not recommended.

Unpausing goes through the timelock only (section 7): `--call "unpause()"`, with a 24 h delay.

## 7. Timelock change procedure (parameters, oracle, roles, unpause)

1. Prepare the operation. The keeper never holds the owner key; this command writes Safe Transaction Builder files.

   ```bash
   npm run timelock -- --network mainnet prepare --call "setCaps(uint256,uint256,uint256)" --args 100000000,1000000000,50000
   ```

   It writes two files to `contracts/cache/timelock/`:
   - `…-1-schedule.json` (sign now);
   - `…-2-execute.json` (sign after the delay).

   It also prints the operation id and status.
2. Have the multisig sign and execute the **schedule** file.
3. Announce the change publicly with the operation id. That is the point of the 24 h delay.
4. Check the status: `npm run timelock -- --network mainnet status --id 0x…` (or the same `--call/--args`).
5. After the delay, sign and execute the **execute** file. Verify on chain, for example with `/health.caps`.

To cancel, the multisig calls `timelock.cancel(id)` (canceller role).

Common calls:

- `unpause()`
- `setGuardian(address)`
- `setOrderParams(uint256,uint256,uint256)`, e.g. the execution fee
- `setFundingParams(uint256)`
- `setOracleParams(uint256,uint256,uint256)` — (maxPriceAge, maxStoredPriceAge, maxConfBps)
- `setBackstopParams(uint256)` — the LP withdrawal delay
- `setRiskParams(uint256,uint256,uint256)`
- `setCaps(uint256,uint256,uint256)`
- `setBackstopOperator(address,uint8,bool)` — per lane
- `replaceMarketFeed(bytes32,bytes32,uint256)` — dead-feed swap (v3): use `npm run timelock -- --network mainnet feed-swap --market MON/AUSD --feed 0xNEW --max-deviation-bps 500` (section 13c)
- `setPyth(address)`
- `setMarketConfig(bytes32,bytes32,uint256,uint256,uint256)`

The rehearsal runs the whole `unpause()` procedure: Safe JSON, multisig impersonated, 24 h warped.

## 8. Funding updates and cost control

The cumulative funding index accrues continuously at the stored rate. `updateFunding(market)` only recomputes the **rate** from global skew. The keeper (OPS key) sends it only when one of these holds:

- the rate would change by more than `FUNDING_MIN_CHANGE_BPS` (500 = 5 %, relative) or cross zero;
- the rate is older than `FUNDING_MAX_AGE_S` (3,600 s).

It never sends before the contract's `nextUpdate`.

- **Formula check.** The keeper's off-chain copy of the formula matched the stored rates in the rehearsal.
- **Cost.** About 72 updates per market per day at most: ≈ 1.9 MON/day for 3 markets. Updating every 60 s would cost **≈ 38.6 MON/day**.
- **Every interval.** `FUNDING_MIN_CHANGE_BPS=0` gives the every-interval behaviour.

## 8b. Pyth push policy (stored and lane prices expire after 15 s)

**Who needs a fresh price, and how each one gets it (contract v3):**

| Consumer | Price source | Keeper action |
| --- | --- | --- |
| Auctions (start / take / cure / expire) | the fresh Hermes update inside every keeper tx | none |
| Order fill | its own unique update (first ≥ `execAfter`) | none |
| Other legs of a multi-leg order (and the order market's current price for a reduce-only order in auction) | the executor's own `priceUpdate` through the monotonic lane path | **append** `latest` for the account's feeds before the unique fill update (`EXEC_OTHER_LEGS=auto` → `append`) |
| Users' `[]` calls (withdraw, pool ops) and top-ups beyond the deposit cap (`topUpAllowance` needs a usable price) | Pyth storage or the lane's last price, ≤ 15 s | none: the app fetches a fresh signed update through the keeper's `/hermes` proxy when storage is stale. The keeper's auction txs also refresh the lane price for 15 s |
| A dead-feed swap (section 13c) | the NEW feed's stored price, ≤ 15 s at execution | `npm run pyth:push -- --feeds 0xNEW --every 10` while the Safe executes |

**Measured inputs** (`npm run pyth:cadence` on Monad mainnet, read-only; gas on the fork):

- A `pyth.updatePriceFeeds` push with a 3-feed Hermes update: **166.6k gas** (183k limit with the keeper's 10 % margin) = **0.0187 MON** at 102 gwei; 1 feed: 114k (126k limit) = 0.0128 MON.
- Third parties already push the three feeds: MON 171–289 times/hour, SOL and BTC 116–237/hour; gaps p50 10–20 s, p90 21–70 s, max 59–150 s (four windows: 2.3 h and three of 45 min on 2026-10-07). The **stored** price is ≤ 15 s old only **38–79 %** of the time per feed (all three at once 40–73 %).
- v3 multi-leg execution: 673.7k gas limit with the appended update vs 496.8k for the largest single-leg fill (+177k ≈ 0.018 MON).

**The options (3 markets, 102 gwei, 200 orders/day, 30 % multi-leg):**

| Option | Pushes/day | MON/day | Unblocks |
| --- | --- | --- | --- |
| (a) push every ~12 s while any position or order is open (`PYTH_PUSH_MODE=interval`) | 3,146–5,469 measured on top of third-party pushes (6,646 without them) | **≈ 59–102** (124 without third parties) | everything, including `[]` calls without the proxy |
| (b) only inside the keeper's own txs: auctions carry an update; v3 executions append the account's feeds (**chosen on v3**) | 0 | **≈ 1.1** (the appended verification, 60 multi-leg orders × 177k; reimbursed by the execution fee) | every keeper action; users through the `/hermes` proxy |
| (c) hybrid for a **v2** contract (other legs read storage): (b) + push exactly the stale feeds before a multi-leg execution (`EXEC_OTHER_LEGS=push`) | ≈ 36 (60 × ~60 % stale) | **≈ 0.5–0.7** | the same as (b) on v2 |

The keeper runs (b) on v3 (`EXEC_OTHER_LEGS=auto`, `PYTH_PUSH_MODE=on-demand`, which then never pushes) and (c) on v2. (a) is about 50–100× more expensive and only worth it if the app must work without the proxy. Pushes from 8 lanes never duplicate (one in-flight push per feed). `/health.pricePush` shows the mode, pushes and gas; `/health.storedPriceAgeS` the stored age per market; `/health.executor.otherLegs` the execution mode.

## 9. Top-ups and keeper earnings

```bash
npm run keeper:fund -- --network mainnet                    # preview: balance vs target per role
npm run keeper:fund -- --network mainnet --send --yes-mainnet --funder-env FUNDER_PRIVATE_KEY
```

- **Targets** come from measured gas (section 11) and the activity assumptions it prints. Override with `BUDGET_*`, `FUND_DAYS` or per-role `FUND_*_MON`.
- **Funder key.** `--funder-env NAME` reads the funder's key from an environment variable, so a large wallet never sits in a file. `--funder deployer` uses the deployer key.
- **Monad reserve balance.** A transfer may not take its sender below min(balance, 10 MON) unless it is the sender's first tx in 3 blocks, so `keeper:fund` waits 3 blocks between transfers.
- **Keeper value.** Keeper txs send no value while Pyth's fee is 0 (it is 0 on Monad today). If Pyth ever charges a fee, keepers need to stay above 10 MON.
- **Earnings.** Keepers earn users' execution fees (0.1 MON per order) as a claimable per-lane credit. The keeper claims automatically (`CLAIM_MIN_MON`, `CLAIM_MIN_AUSD`), so executions are roughly self-funding. Liquidations are not reimbursed.

## 10. Rehearsal (`npm run rehearse:mainnet`)

Everything runs on local anvil chains; nothing touches mainnet. Output goes to `contracts/cache/rehearsal/<UTC>/`:

- `report.json` and `rehearsal.log`;
- per-CLI logs;
- the rehearsal env files with throwaway keys;
- the rehearsal deployment files.

It never writes `deployments/143.json` or `bench/*/143-*`.

**Fork leg** (anvil fork of `https://rpc.monad.xyz` on :8945, `--code-size-limit 131072`, real AUSD and real Pyth):

1. Measure the third-party Pyth push cadence on mainnet (read-only, section 8b).
2. Harvest the **real signed Pyth updates** that mainnet txs pushed in the last ~27 min, and fork just before them.
   - Hermes needs an API key. A local Hermes-compatible replay serves the harvested updates, cut down to the requested feeds exactly like Hermes does.
   - The real Pyth contract on the fork verifies the Wormhole signatures and Merkle proofs.
   - With `PYTH_API_KEY` set, `--hermes live` forks the current block and runs the order rounds in real time against real Hermes. It skips the outage and expiry drills, which need the replay. Live mode is **untested here**, because no API key was available.
3. The owner is a **real Safe** (2-of-2), created through Monad's canonical SafeProxyFactory 1.4.1 on the fork.
4. Run `keeper:init`, then `keeper:fund` (preview, then send), then `deploy:mainnet` with the real DeployProd and full verification.
5. Seed through the treasury Safe batch from section 4.
6. Give traders AUSD through storage cheats on the real AUSD contract. AUSD packs flags in the low byte, so balance = slot >> 8.
7. Start the production keeper and run the orders:
   - 8 lanes open positions in one block; 8 keepers execute them with real Pyth data;
   - a second leg, whose other leg needs a fresh stored price: the keeper pushes MON on demand first (asserted);
   - a partial reduce;
   - a slippage miss → `OrderFailed`, executor still paid.
8. Withdraw with an update fetched through the keeper's proxy; gas probes for the auction calls and for Pyth pushes with real updates.
9. Pause semantics; Hermes outage drill (`hermes:down`, then recovery, then `exec:late`); expired order → `exec:expired`, then the user cancels; funding policy (every `FundingUpdated` rate equals the keeper's formula).
10. LP two-step exit, step 1 (request → `WithdrawNotReady`); unpause via the timelock procedure, executed as the Safe; LP exit step 2 after the warped delay; stale-oracle alerts after the warp; solvency.

**MockPyth leg** (plain anvil on :8947, chain id 143, the contracts agent's test MockPyth and MockAUSD, `OWNER_IS_EOA=true`; real prices don't move enough to liquidate):

- MON positions at 9.5x on lanes 0–6, plus two small 9.5x MON longs and a 3x BTC short on lane 7 (insurance 20 AUSD, no pool);
- **pause**, then MON −10 %: the sweeper starts 10 auctions while paused;
- a holder top-up cures one account (keeper `cancelAuction`); on v3 a lane-7 account in auction closes with a reduce-only order (the executor appends the current price) and its auction ends;
- 7 are taken by lane pools; the other pool-less lane-7 auction expires at the max discount;
- **deficit drill** (section 13b): BTC −90 %, the lane-7 short closes with a profit larger than the lane's insurance → bad debt → `solvency:lane7`; a bystander's withdrawal is haircut (`haircut:lane7`); after a timelock unpause a fresh deposit reverts `LaneInDeficit`; the runbook repair batch (`timelock seed --lanes 7`) clears the deficit and the alert resolves;
- token-level `solvency()` and `nativeSolvency()` hold;
- **dead-feed drill** (section 13c, v3): the MON feed freezes → `oracle:stale:MON/AUSD`; `timelock feed-swap` schedule → 1 h → `pyth:push` → a 20 %-off candidate reverts `FeedSwapDeviation` → execute → the keeper switches live (`gov:feed`) → a MON order fills on the new feed.

**Scale leg** (plain anvil on :8948, MockPyth, lane TVL cap raised): 600 accounts in one lane crash together. Every `startAuctions` / `backstopTakeBatch` must stay below the 30M per-tx limit (keeper target 24M); all auctions start and are taken.

**Runs on 2026-10-07** (gitignored outputs under `contracts/cache/rehearsal/`; re-run before the launch gate):

| Contract | Fork leg | MockPyth leg | Scale leg |
| --- | --- | --- | --- |
| v2 | 24/24 (`v2-1`) | 13/13 (`v2-mock`) | 5/5 (`v2-scale`, v2 artifacts via a debug deploy hook) |
| v3 | 22/22 (`v3-fork`; v3 artifact snapshot via a debug deploy hook, because the v4 source was mid-edit) | 15/15 (`v3-mock`, DeployProd v3) | 5/5 (`v3-smoke2`, DeployProd v3) |

## 11. MON budget (measured gas, 102 gwei, billed on gas LIMIT)

Contract v3, `npm run rehearse:mainnet` on 2026-10-07 (fork leg: real Pyth + real AUSD; auction gas: the fork's real-Pyth probe + the per-account work measured on the MockPyth leg).

| Operation (who pays) | Gas limit | MON |
| --- | --- | --- |
| Deploy: DeployProd v3, 21 txs (deployer) | 17.57M | **≈ 1.79** |
| `executeOrder`, single leg (lane keeper; the user's 0.1 MON fee pays it back) | 444k avg (497k max) | 0.045 |
| `executeOrder`, multi-leg with the appended update (v3) | 674k | 0.069 |
| `updateFunding`, per market (OPS) | 88k | 0.0089 |
| One liquidation: `startAuctions` + pool take (or expire) (lane keeper) | 445k + 606k (459k) | ≈ 0.11 |
| `cancelAuction` (cure) | 183k | 0.019 |
| `pause()` (guardian) | 33k | 0.0034 |
| `pyth.updatePriceFeeds` (3 feeds / 1 feed), only for interval mode or a dead-feed swap | 183k / 126k | 0.019 / 0.013 |
| Large batches (R2-09): `startAuctions` ≈ 74–79k per account, `backstopTakeBatch` ≈ 95–97k per account (600-account lane) | chunked ≤ 24M per tx | — |
| User: approve / deposit / commitOrder / withdraw (with update) / cancelOrder | 51k / 189k / 231k / 264k / 50k (gas used) | — |

**Two weeks** at 200 orders/day (30 % multi-leg), 20 liquidations/day, 3 markets, the funding policy and Pyth push mode (b):

| | MON |
| --- | --- |
| Deployer (one deploy, × 1.3 forge margin, × 1.5 safety) | 3.5 |
| Guardian (floor) | 0.5 |
| OPS (72 updates/market/day × 14 d × 1.5) | 40.6 |
| Each lane keeper (busiest-lane load; executions floated 2 days, liquidations 14 days, × 1.5) | 18.7 |
| **Total to put on the hot keys** | **≈ 195** |
| Expected gross spend over 14 days (≈ 14.2 MON/day + deploy) | ≈ 200 |
| … of which reimbursed by users' execution fees (2,800 orders × 0.1 MON) | 280 (fees exceed the execution cost) |
| With Pyth push mode (a) instead | + ≈ 59–102 MON/day |
| With funding updated every 60 s instead (`FUNDING_MIN_CHANGE_BPS=0`) | OPS alone ≈ 38.6 MON/day |

A capped beta (≤ 4,000 AUSD TVL) will very likely see far less activity. Re-run the preview with your own `BUDGET_ORDERS_PER_DAY` and `BUDGET_LIQUIDATIONS_PER_DAY` (`keeper:fund -- --network mainnet [--gas-report <rehearsal report.json>]`).

## 12. Key rotation

| Key | On-chain role? | Procedure |
| --- | --- | --- |
| Lane keeper i | backstop operator of lane i (`backstopReduce`) | 1. `keeper:init -- --network mainnet --rotate "keeper[i]"`; the old key moves to `keeper/.env.mainnet.retired-<time>`.<br>2. Update the host's secret and restart.<br>3. `keeper:fund` the new key.<br>4. The old key's `claimExecutionFees()` balance is claimable only by the old key: claim it, then `keeper:fund -- --sweep-retired <file> --to <addr> --send --yes-mainnet`.<br>5. Through the timelock: `setBackstopOperator(new,i,true)`, `setBackstopOperator(old,i,false)` |
| OPS | none (`updateFunding` is permissionless) | `--rotate ops`, update the secret, restart, fund, sweep the retired key |
| Guardian | `guardian()` | 1. `--rotate guardian` on the guardian machine.<br>2. Timelock `setGuardian(new)`. The old key can still pause during the 24 h delay; keep it until the change executes.<br>3. Sweep the old key |
| Deployer | none after deploy (verified) | sweep and discard |
| Multisig signer | Safe owner | rotate inside the Safe (add owner, remove owner, change threshold) |
| Multisig itself | timelock proposer, executor, canceller | through the timelock: `grantRole` (PROPOSER, EXECUTOR, CANCELLER) to the new Safe, then `revokeRole` from the old one. Target `--target timelock`; the timelock administers itself |

**Suspected compromise:**

- **Keeper or OPS key:** rotate immediately. A hot key can only spend its own MON and send keeper txs, and cannot move user funds. Pause only if the attacker is griefing executions.
- **Guardian key:** schedule `setGuardian` at once. The worst a stolen guardian can do is pause.
- **Multisig signer:** rotate the Safe owner, and watch for scheduled timelock operations (`CallScheduled` events). Cancel anything unexpected with the canceller role.

## 13. Incident response

1. **Contain.**
   - Fund loss, insolvency, an exploit or a governance anomaly → **pause now** (section 6).
   - Pause does not trap users: withdrawals, closes and liquidations keep working.
2. **Assess.**
   - `/health` (solvency, paused, caps, hot keys), `/alerts`, `/txs`, `/orders`;
   - `solvency()` and `nativeSolvency()` on monadscan;
   - the keeper log.
3. **Common cases:**
   - **Hermes down.** Executions stall and orders expire after 60 s; users `cancelOrder` (anyone can) and get the escrow and fee back. Auctions wait. Nothing unsafe happens. Add a fallback Hermes endpoint.
   - **RPC down** (`rpc:stalled`). Switch `KEEPER_RPC_URL` to a second provider and restart.
   - **Keeper crashed.** The platform restarts it, and it rebuilds state from the logs. Orders committed while it was down are executed if still inside the window, otherwise users cancel them.
   - **Wide confidence or stale Pyth.** The contract rejects those prices, so orders and auctions on that market revert until the price recovers. Consider pausing in a sustained oracle incident. If the feed never comes back, replace it (section 13c).
   - **Lane bad debt.** Check `/solvency` `lanes[i].badDebt`. Top up the lane's insurance from the treasury (`fundLane`; it repays bad debt first).
   - **AUSD freeze.** Agora can freeze addresses. If the clearinghouse were frozen, deposits and withdrawals would fail; pause and contact Agora.
   - **Suspected bug.** Pause, then prepare the fix as a timelock operation, or a migration if code must change (the contract is not upgradeable).
4. **Communicate.** Post the status publicly, with the operation ids of any timelock actions.
5. **Recover.** Unpause through the timelock once fixed. Write a post-mortem.

## 13b. Lane deficit (bad debt) and haircuts

Each lane's insurance fund is the counterparty of every position in that lane. When it must pay out more than it holds (a winning trader's realised profit, or a liquidation's negative equity beyond insurance and pool cash), the shortfall is recorded as lane **bad debt**. Then:

- `laneSolvency(lane)` shows `surplus = insurance − badDebt < 0` and `haircutBps` → alert `solvency:lane<i>`;
- withdrawals, pool withdrawals and keeper reward claims in that lane pay `previewWithdraw` (pro-rata haircut) → event `LaneHaircut` → alert `haircut:lane<i>`;
- fresh deposits and pool deposits into the lane revert `LaneInDeficit` (new money is never diluted by old debt); holders' margin top-ups still work and are exposed to the haircut.

**Procedure:**

1. Confirm: `/solvency` (per-lane `surplus`, `haircutBps`) and the lane's recent `LaneHaircut` / `BadDebtRealized` events. Other lanes are unaffected (lane-local accounting).
2. Decide whether to pause (it stops new risk everywhere; it does not stop haircut withdrawals).
3. **Repair:** the treasury Safe calls `fundLane(lane, badDebt + buffer)` (permissionless; repays bad debt first). A Safe batch: `npm run timelock -- --network mainnet seed --insurance <amount> --lanes <i>` or a single `fundLane` call in the Transaction Builder.
4. Verify `laneSolvency(lane).surplus ≥ 0`, `badDebt = 0`; the alert resolves; fresh deposits work again.
5. Communicate: who was haircut (from `LaneHaircut` events), by how much, and whether the treasury will make them whole.

The rehearsal's MockPyth leg runs exactly this: lane 7 with 20 AUSD insurance, a BTC short wins 81 AUSD → bad debt 51 AUSD, haircut 29.7 % → a bystander withdrawing 40 AUSD is paid 28.11 → fresh deposit `LaneInDeficit` → treasury `fundLane` → surplus back to ≥ 0, alert resolved.

## 13c. Dead feed: replacing a market's Pyth feed (v3)

A feed is "dead" when Pyth stops publishing it (Hermes keeps returning an old `publish_time`; `oracle:stale:<market>` goes critical and never resolves). Positions on that market cannot be priced; the contract rejects stale prices. Procedure (also `contracts/SECURITY_NOTES.md` §4.7):

1. **Pick the new feed id** from Hermes `/v2/price_feeds` (same asset, e.g. another venue's MON/USD). Check its price is within a few % of the old feed's last price.
2. **Pause** if the market is actively traded (section 6).
3. **Schedule:** `npm run timelock -- --network mainnet feed-swap --market MON/AUSD --feed 0xNEW --max-deviation-bps 500` writes the schedule/execute Safe files and prints the steps. The multisig signs the schedule (24 h). Announce it publicly.
4. **Keep the new feed fresh at execution:** nobody pushes a new feed on Monad, and `replaceMarketFeed` requires its stored price ≤ 15 s old. Start `npm run pyth:push -- --network mainnet --feeds 0xNEW --every 10 --yes-mainnet` (OPS key, ≈ 0.013 MON per push) shortly before executing.
5. **Execute** the execute file with the multisig while the pusher runs. The contract checks every lane with open interest against its last price (≤ `maxDeviationBps`, at most 10 %; v4 may allow up to 50 % when the old feed is provably dead), resets the lane price markers and repoints the market. A swap too far from the reference reverts `FeedSwapDeviation`.
6. The keeper sees `MarketFeedReplaced`, switches every loop and the `/hermes` proxy to the new feed live (alert `gov:feed`). Stop the pusher; unpause through the timelock if you paused.

The rehearsal's MockPyth leg runs this end to end: the MON feed freezes → `oracle:stale:MON/AUSD` → schedule → 1 h → `pyth:push` → a 20 %-off candidate reverts `FeedSwapDeviation` → execute → the keeper switches → a MON order fills on the new feed.

