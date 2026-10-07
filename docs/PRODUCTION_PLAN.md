# Production plan: guarded real-money beta on Monad mainnet (chain 143)

Interface contract between parallel agents. The demo stack (`ParaclrClearinghouse`,
`...Demo`, `NaiveClearinghouseDemo`, `MockOracle`, `MockAUSD`, anvil/testnet keeper
flows, X-ray, bench) **stays as-is** — it is the evidence for the hackathon. Production
is a **separate contract set** under `contracts/src/prod/`. Deviations → bottom.

## Launch gate (no exceptions)
Mainnet launch with real AUSD happens only if ALL pass: full forge suite incl.
invariants; Slither with every high/medium finding fixed or justified in writing; an
adversarial internal review with all criticals fixed; a full rehearsal on an anvil
fork of Monad mainnet (real AUSD + real Pyth contracts); caps set to the beta values.
Otherwise the hackathon submission falls back to testnet/no-value and production
ships after an external audit. The product is labelled **"Unaudited beta · capped ·
use only what you can afford to lose"** everywhere.

## Fixed external facts (re-verify on chain in the deploy script)
- AUSD (Agora) on Monad mainnet: `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a` (6 decimals — verify).
- Pyth on Monad mainnet: `0x2880aB155794e7179c9eE2e38200202908C17B43`; MON/USD feed
  `0x31491744e2dbf6df7fcf4ac0820d18a609b49076d45066d3568424e62f686cd1`; SOL/USD, BTC/USD
  from Pyth's official feed list (verify each).
- Verify Monad's max contract size (docs.monad.xyz) — if > 24 KB, document it; tests
  and anvil must use a matching `--code-size-limit`.
- Verify whether Safe is deployed on Monad mainnet; if not, the owner is a timelock
  whose proposer/executor is a hardware-wallet address supplied by the human.

## Contracts (`contracts/src/prod/`, contracts agent)
Design principle kept from the demo: **every per-trade accumulator or cap is
lane-local** (lane = `uint160(account) % 8`), or is written only by a dedicated
once-per-interval tx that other txs merely read (price/funding update "star", no
lane-to-lane dependencies).

- **Collateral:** real AUSD via an immutable token address; no mint, no faucet.
- **Oracle:** Pyth pull oracle verified on chain. Prices: expo-normalised to 18 dp,
  staleness bound, **confidence check** (`conf / price ≤ maxConfBps`), revert on
  non-positive price. Excess `msg.value` for Pyth fees is refunded.
- **Delayed orders (anti front-running):**
  `commitOrder(bytes32 market, int256 sizeDelta, uint256 marginDelta, uint256 acceptablePrice) payable returns (uint256 orderId)`
  — escrows margin + an execution fee (native MON) for the keeper.
  `executeOrder(uint256 orderId, bytes[] calldata priceUpdate) payable` — anyone; must
  use the **first** Pyth update with `publishTime ≥ commitTime + MIN_EXEC_DELAY`
  (e.g. `parsePriceFeedUpdatesUnique`), within `MAX_EXEC_DELAY`; slippage vs
  `acceptablePrice`; charges trading fee; pays the executor.
  `cancelOrder(uint256 orderId)` — only after `MAX_EXEC_DELAY` (no free option).
  Supports increase, reduce and full close of one position per market; no flips in
  one order.
- **Fees & funding:** trading fee (bps of notional) → lane insurance; per-market
  funding from **global** skew (sum of the 8 lanes' OI) via a rate-limited
  `updateFunding(bytes32 market)` that writes a cumulative index; positions settle
  funding when touched.
- **Caps:** max leverage; per-account deposit cap; per-lane TVL cap; per-lane
  per-market OI cap sized against that lane's insurance + backstop; min position size.
- **Liquidation:** the fair-liquidation auction path from the demo (start / take /
  backstop take / cure / expire, external-taker cap at trader equity), with verified
  Pyth prices. Backstop pools per lane (LPs deposit real AUSD; NAV, shares, guards).
- **Withdrawals:** health-checked with a verified fresh price.
- **Solvency:** per-lane ledgers + `solvency()` exactly as in the demo, now with real AUSD.
- **Admin:** owner = OpenZeppelin-style `TimelockController` (min delay from env,
  proposer/executor = multisig). Guardian role: `pause()` only (blocks deposits and
  new increase orders; withdrawals, reduce/close orders and liquidations keep
  working). Unpause and every parameter/oracle/role change go through the timelock.
  No `seedAccounts`, no `sharedState`, no `setOracle` without timelock, no MockOracle.
- **Tests:** unit + fuzz + invariants for the whole prod set, including oracle edge
  cases (stale, wide confidence, negative expo, zero/negative price), order timing
  (too early, too late, replay, cancel windows), funding sign/accrual, cap edges,
  pause semantics, timelock-only admin, reentrancy, fee-on-transfer resistance, and a
  storage-access test that two lanes' order executions and liquidation batches don't
  write a common slot. A `MockPyth` exists **only under `contracts/test/`**.
- **Deploy:** `contracts/script/DeployProd.s.sol` reading `keeper/.env.mainnet`
  values (passed by the keeper deploy flow): verifies AUSD/Pyth code + decimals + feed
  ids on chain, deploys, sets beta caps, wires roles, transfers ownership to the
  timelock, renounces deployer powers, writes `deployments/143.json` with a
  `"production": true` flag. ABIs exported to `src/lib/chain/abi/` (`npm run abi`).

## Keeper / ops (keeper agent)
- Env: `keeper/.env.mainnet` (template `keeper/.env.mainnet.example`, already written —
  keep its variable names). Network flag `--network mainnet` everywhere; mainnet
  commands require an explicit confirmation flag and print balances + cost first.
- Roles: DEPLOYER (deploy only), GUARDIAN (pause), OPS (funding updates, monitoring),
  8 lane KEEPERS (execute their lane's orders; run auctions with Pyth updates).
- Pyth Hermes client: fetch update data for order execution and liquidations.
- Order executor, funding updater, sweeper (auctions) on mainnet; no faucet, no
  price pusher, no demo takers, no synthetic crash on mainnet.
- Monitoring + alerting to `ALERT_WEBHOOK_URL`: low hot-key balances, failed/late
  executions, oracle staleness or wide confidence, pause events, solvency ≠ ok,
  cap utilisation. `/health` exposes `production`, `paused`, `caps`, `priceSource:
  "pyth"`.
- `keeper:init --network mainnet` (generates the hot keys into `keeper/.env.mainnet`,
  prints addresses only) and `keeper:fund --network mainnet` (preview from measured
  gas, then send).
- **Mainnet-fork rehearsal** (port 8945, rehearsal output dirs only): deploy prod set,
  fund test accounts with AUSD via storage cheats, commit/execute orders with real
  Hermes updates, trigger liquidations by mocking nothing but time (or by using the
  test MockPyth on a non-fork anvil), verify solvency and pause semantics.
- Hosting: keeper `Dockerfile` + `keeper/HOSTING.md` (secrets, HTTPS, CORS, health
  checks, restart policy) + `docs/RUNBOOK.md` (pause, key rotation, top-ups,
  incident response, timelock procedures).

## App (frontend agent)
- Chain mode `monad-mainnet` (viem `monad`, monadscan.com) with `production: true`
  from the deployment file.
- Real AUSD: balance, approve, deposit with caps shown; withdraw with price update.
- Orders: two-step UX (submitted → executing → filled at price X, or expired/cancel
  after window), slippage setting, execution fee and trading fee shown up front.
- Funding rate and next accrual per market; caps/utilisation; paused state.
- Risk acknowledgement before first deposit (unaudited beta, caps, loss possible,
  jurisdiction notice); persistent beta banner; links to terms + risk page.
- No faucet, no flash-crash button, no demo bots on mainnet. Clearing shows real
  auctions as they happen; the X-ray panel shows recorded testnet/anvil evidence,
  labelled as such.
- Demo/testnet/anvil modes keep working unchanged.

## Landing + docs (content agent)
- Production beta positioning with the launch gate and risk disclosures; contract
  table from `deployments/143.json` when present; audit status ("not audited");
  caps; "Built with" adds Pyth, real Agora AUSD on mainnet.
- `/terms` and `/risk` pages (drafts, clearly marked "draft — get legal review").
- README, SUBMISSION, X drafts updated; no claims beyond what is deployed and tested.

## Deviations
(append here)

### Frontend agent
- **Pyth price data for `priceUpdate` calls** (`src/lib/chain/prod/priceUpdate.ts`; used by
  `withdraw`, `cancelAuction`, `take`, `backstopDeposit/Withdraw`): stored Pyth prices on
  mainnet were seen up to 122 s old, beyond `maxPriceAge`. So the app sends `[]` only if
  every listed feed's stored price is younger than 70% of `maxPriceAge` (60 s → 42 s;
  adapts to the planned 15 s → 10 s). Otherwise it fetches Hermes "latest" for **all**
  listed feeds from the keeper's `/hermes` proxy (`${NEXT_PUBLIC_KEEPER_URL}/hermes`, or
  `NEXT_PUBLIC_PYTH_HERMES_URL` if set) and attaches it with
  `msg.value = IPyth.getUpdateFee(update)` (read every time). The proxy holds the API key;
  the browser never sees it. The data is Wormhole-signed and verified on chain, so the
  proxy can only withhold, not forge. Proxy down + stored price too old → "Prices are
  refreshing — retry in a few seconds". Backstop calls skip prices when the pool holds no
  positions. No browser self-execution of orders.
- **Display prices**: Hermes "latest" polled via the same proxy (badge "Pyth · Hermes");
  falls back to the on-chain stored price (`latestPrice`, "Pyth · on-chain" + age).
- The app reads `paraclrClearinghouseProdAbi` (generated) through `src/lib/chain/prod/`.
- In `monad-mainnet` mode the app never takes contract addresses from the keeper's
  `/health` (deployment file only), refuses a deployment without `"production": true` or
  whose `ausd()` differs from the file, never falls back to the simulation, and offers no
  burner wallet unless the RPC is local (fork rehearsal). Privy shows its confirmation UI
  on mainnet. Server env `PARACLR_DEPLOYMENTS_DIR` points the app at a rehearsal's
  deployment file.
- **Increase orders deposit margin + 2× the trading fee** (plus any unrealized loss on other
  legs): with exactly the margin deposited the fill fails `InsufficientMargin` because the fee
  comes out of collateral before the IM check (seen on a private stack).

### Content agent (landing, /terms, /risk, docs)
- **What the landing reads from `deployments/143.json`** (`src/components/landing/production.server.ts`, build time):
  "live" only if the file parses, `chainId` is 143 or absent, `"production": true`, and at least one contract address
  is present; anything else renders "Mainnet beta: pending launch gate". Contract rows come from every address-valued
  key at the top level or under `contracts` / `addresses` / `roles` / `governance` (an `{ address }` object, e.g.
  `pyth: { address, feeds }`, works too); known names (`clearinghouse`, `oracle`, `timelock`, `multisig`/`owner`,
  `guardian`, `ops`, `ausd`, `pyth`, `deployer`) get labels, others are humanized. **Request to the contracts agent:**
  write the beta parameters into a `params` (or `caps`) object with these names, so the landing shows values instead
  of "set at launch": `maxLeverage` (x; ≥1e15 is read as 1e18 fixed point), `maxDepositPerAccountAusd`,
  `maxTvlPerLaneAusd`, `maxOiPerLaneMarketAusd`, `minPositionSizeAusd` (whole AUSD; the same names without `Ausd`
  are read as raw 6-dp units), `tradingFeeBps`, `maintenanceMarginBps`, `maxConfBps`, `executionFeeWei` (or
  `executionFeeMon`), `minExecDelaySeconds`, `maxExecDelaySeconds`, `maxPriceAgeSeconds`, `timelockMinDelaySeconds`,
  `fundingIntervalSeconds`, plus optional `deployBlock`, `deployedAt`, `markets`. Matching ignores case and
  underscores (`MAX_TVL_PER_LANE_AUSD` works). The app keeps reading live values on chain; the landing says so.
- **Shared copy for the app:** `src/components/landing/disclosures.ts` (client-safe) exports `TERMS_PATH`, `RISK_PATH`,
  `BETA_LABEL`, `AUDIT_STATUS`, `LEGAL_DRAFT_NOTICE`, `RISK_ACK_POINTS` (short points for the first-deposit modal, each
  with a `/risk` anchor) and `RISK_ANCHORS` (stable section ids on `/risk`). The frontend's risk modal may import it.
- **Results honesty fixes (landing, owned here):** per the keeper's fair-liquidation deviations, `auctions.badDebt` is
  now labelled "Lane-funded shortfall", external takes are labelled "(demo bots)" when `externalTakers.demo` is true,
  and a "Taken from traders by the auction" tile (`traderEquityAtStart − traderResidualReturned`) sits next to the
  legacy counterfactual so the two are comparable. README and SUBMISSION results tables are filled for the committed
  local-anvil runs only; Monad rows stay `[TBD]`.
- Root metadata and the OG/Twitter card are now status-aware (they read the same file). "Built with" adds Pyth and
  Slither ("not an audit").

### Contracts agent: production set landed (`ParaclrClearinghouseProd`), API notes
> **Partly superseded by "v2 after the adversarial review" below.** Price ages, `priceUpdate` coverage, LP
> withdrawals, OI cap backing, deposit rules and the `getOrder` / `getPosition` / operator signatures changed.
ABI: `src/lib/chain/abi/ParaclrClearinghouseProd.ts` (`paraclrClearinghouseProdAbi`). Full API, defaults and
verified facts: `contracts/README.md` → *Production*. Differences from / additions to the plan:
- **Hermes needs an API key (verified 2026-10-07):** `hermes.pyth.network/v2/updates/*` returns HTTP 401 since
  Pyth's Aug 26 2026 cutover (`Authorization: Bearer <PYTH_API_KEY>`; `/v2/price_feeds` still works). A browser
  can't hold that key, so **the app should call `withdraw(amount, [])` with an empty `priceUpdate`**: the contract
  then uses the prices stored in the Pyth contract (pushed on Monad mainnet every few seconds; observed 0–30 s old),
  which must be ≤ `maxPriceAge` (default 60 s). The keeper needs the key for order execution / auctions.
- **`priceUpdate` everywhere** (withdraw, startAuctions, take, backstopTakeBatch, cancelAuction, expireBatch,
  backstopDeposit/Withdraw/Reduce, and executeOrder's other legs): `bytes[]`, payable, fee =
  `IPyth.getUpdateFee(priceUpdate)`, excess refunded. Empty → Pyth-stored prices. Non-empty → must carry **every
  listed feed** (one Hermes "latest" request with all feed ids); per feed the newer of (update, stored) is used. If
  Pyth rejects it, the stored prices are used (and must be fresh). Every auction/backstop function from the fair-
  liquidation plan therefore has an extra trailing `bytes[] priceUpdate` argument and is payable.
- **Orders:** `getOrder(id)` returns `(account, commitTime, status, market, sizeDelta, marginDelta,
  acceptablePrice, executionFee, execAfter, deadline)`; status 0 None, 1 Pending, 2 Executed, 3 Failed, 4 Cancelled.
  `orderId = uint160(account) << 96 | nonce` (no global counter). One pending order per account per market
  (`pendingOrderOf(account, market)`). Delay getters are `minExecDelay()` / `maxExecDelay()` (timelock-settable
  params, defaults 2 s / 60 s); each order stores its own `execAfter`/`deadline`. Fill = Pyth
  `parsePriceFeedUpdatesUnique(update, [feed], execAfter, deadline)`; `block.timestamp` must be in
  [execAfter, deadline]. The keeper should send `[updateAt(execAfter) for ALL feeds]` (plus a latest blob if the
  account has other legs and execution is late).
- **Failed fills:** if the price is valid but the fill is impossible (slippage, IM, leverage, min size, OI cap,
  flip, account in auction) the order becomes `Failed` (event `OrderFailed(orderId, account, market, executor,
  reason)`), escrow is released and the **executor is still paid**. Oracle problems and out-of-gas revert instead.
  Pause makes increase executions revert (order stays pending; cancel after the deadline refunds the fee).
- **Execution fee (native MON):** escrowed at commit; executors are paid by a lane-keyed credit
  (`ExecutionFeeCredited`), claimed with `claimExecutionFees()` (`executionFeesOwed(addr)`), so the execution hot
  path never moves native value. `cancelOrder` (anyone, after `deadline`) pushes the fee back to the account
  (credited instead if the push fails). Event `OrderCancelled(orderId, account, market, caller, feeRefunded)`.
- **Pause** blocks deposits only for accounts **without** open positions (holders can still top up margin, since
  liquidations keep running during a pause), pool deposits, and committing/executing increase orders.
- **Caps:** `laneTvl(lane)` = trader collateral + backstop pool cash (pool deposits count); per-account cap is on
  the account's collateral after a deposit; OI cap per lane, market and side = `laneOiCap(lane, market)` =
  min(market `maxLaneOi`, (lane insurance + pool cash⁺) × `oiCapMultiplierBps` / 10⁴).
- **Funding:** rate = maxFundingBpsPerDay × clamp(globalSkew / skewScale, ±1), skew = Σ lanes (long − short entry
  notional, incl. backstop pools); paid on entry notional to/from the lane fund (the counterparty); backstop pools
  pay/receive too. `fundingState(market)` → (index, ratePerSec, lastUpdate, indexNow, nextUpdate).
- No `liquidateBatch`, no `seedAccounts`, no `sharedState`, no MockOracle. `setPyth` exists but is owner
  (timelock) only. `renounceOwnership` is disabled.
- **Pyth on Monad has two Core contracts:** `0x2880…C17B43` (the plan's, `version()` 1.4.6, upgraded in place on
  Aug 26) and `0xB754BA51…36508d` ("upgraded" listing on docs.pyth.network). A real mainnet payload parses on both
  (eth_call replay). We keep `0x2880…` (plan / env); switching later is a timelock `setPyth`.
- **Size:** 40,102 B runtime (> EIP-170, < Monad's 128 KB). anvil (incl. fork rehearsals) must run with
  `--code-size-limit 131072`.
- **Deploy (`contracts/script/DeployProd.s.sol`):** reads the `keeper/.env.mainnet` names. Use `GUARDIAN_ADDRESS` /
  `KEEPER_ADDRESSES` if possible; deriving them from `GUARDIAN_PRIVATE_KEY` / `KEEPER_PRIVATE_KEYS` also works, but
  passes more secrets to forge. The **forge command must include `--code-size-limit 131072`**: without it, forge's
  on-chain simulation rejects the 40 KB contract against EIP-170, even with `--broadcast`.
  - Output goes to `DEPLOYMENTS_OUT` or `deployments/<chainId>.json`, on broadcast only. It contains the existing keys
    plus `production: true`, `contract`, `pyth`, `oracle` (= pyth), `timelock`, `owner` (multisig), `guardian`,
    `backstopOperators`, `deployedAt`, `pythFeeds`, and a `params` object with the names the content agent asked for.
    `executionFeeWei` is a **string**; `maxOiPerLaneMarketAusd` is the absolute per-market cap, and the live cap also
    scales with lane insurance + pool cash. There is no `naive` key on mainnet.
  - Optional `LANE_INSURANCE_SEED_AUSD` funds the lanes from the deployer. With 0, **every OI cap is 0 until the lanes
    are funded**. Seed backstop pools from the multisig, not the deployer: LP shares belong to the depositor.
  - Read-only fork simulation on mainnet state: every on-chain check passed; 14.7M gas, about 2.97 MON at 202 gwei
    (budget ~4 MON).
- **Real-chain check:** `ProdForkTest` (opt-in `MONAD_FORK_RPC`) commits and executes against the real AUSD and the
  real Pyth `0x2880…`, using a signed update captured from chain. It fills exactly at the Pyth price. `executeOrder`
  costs **854k gas with real verification** of a 20-feed blob (smaller for a 3-feed Hermes blob). Keepers: Monad bills
  the gas limit, so the 0.1 MON default `minExecutionFee` covers about 0.5M gas at 200 gwei. Retune it via the
  timelock from measured costs.
- **Issuer risk (verified):** Agora's EOA roles can freeze the clearinghouse, pause AUSD transfers, burn AUSD from any
  address, and upgrade AUSD instantly. Ops alerting should watch `solvency().surplus < 0` and AUSD
  `isTransferPaused()`. A Pyth AUSD/USD feed exists for depeg alerts.

### Keeper / ops agent
Details are in `keeper/README.md` → *Production*, `docs/RUNBOOK.md` and `keeper/HOSTING.md`.

- **Hermes needs `PYTH_API_KEY`.**
  - Added to `keeper/.env.mainnet.example`. The keeper sends `Authorization: Bearer`.
  - On 401/403 it fires a critical `hermes:auth` alert and does not retry.
  - On chain 143 the keeper **refuses to start** without a key, or when Hermes rejects it.
  - Transient failures get backoff with jitter, then `PYTH_HERMES_FALLBACK_URLS`, then a circuit breaker. `hermes:down` fires after 30 s.
- **Keeper Hermes proxy (`/hermes/v2/updates/price/{latest|t}`).**
  - It serves only the deployment's feeds, cached for 1 s, rate-limited per IP. The key stays server-side.
  - **Recommendation to the frontend:** point `NEXT_PUBLIC_PYTH_HERMES_URL` at `https://<keeper>/hermes` and pass that update to `withdraw` / `backstop*` instead of `[]`. Measured on Monad mainnet, the Pyth price **stored** for MON/SOL/BTC was up to **122 s old** at a random block, and pushes that cover all three feeds were up to 143 s apart (harvests of ~4,000 blocks). Both exceed the 60 s `maxPriceAge`, so `withdraw(amount, [])` for an account with positions can revert `StalePrice`.
  - The rehearsal withdraws through the proxy successfully.
- **What `executeOrder` is sent** (differs from the contracts note's "all feeds at execAfter"):
  - **Fill update.** The fill update is the first Hermes update ≥ `execAfter` for the order's own feed only. It is checked locally:
    - it is the first one (`prev < execAfter`);
    - `publishTime ≤ deadline`;
    - its confidence is within `maxConfBps`.
  - **Other legs.** If the account has other open legs, a fresh `latest` update for every feed is appended, because `_ingestFresh` runs only then.
  - **Fee value.** `msg.value` = 2 × `getUpdateFee`: the contract meters the fee once per parse, and the excess is refunded.
  - **Measured cost (real Pyth, fork).** 430k gas limit on average and 681k at most (a second leg), i.e. 0.044 / 0.069 MON at 102 gwei. The 0.1 MON `minExecutionFee` covers this up to about 145 gwei.
- **Funding is change-triggered, not sent every interval.**
  - The keeper computes the rate `updateFunding` would set (same integer formula, from `openInterest` and `getMarket`). It sends only when the rate moves by more than `FUNDING_MIN_CHANGE_BPS` (5 %) or crosses zero, or once it is older than `FUNDING_MAX_AGE_S` (1 h).
  - In the rehearsal the stored rates matched the keeper's formula.
  - Cost: ≈ 1.9 MON/day, against ≈ 38.6 MON/day for an update every 60 s. `FUNDING_MIN_CHANGE_BPS=0` restores the every-interval behaviour.
- **`deploy:mainnet` pushes a fresh Pyth update right before forge.**
  - `DeployProd._verifyWiring` calls `markPrice()`, which needs stored prices ≤ 60 s old. On a fork of a random block the oldest was 122 s, so the deploy would fail without the push.
  - The push is `updatePriceFeeds` (~165k gas, fee 0). It needs `PYTH_API_KEY`.
  - Contracts agent: consider making that check tolerant of stale prices (e.g. `latestPrice`).
- **Rehearsal pricing.**
  - Without an API key, the fork leg uses **real Wormhole-signed Pyth updates harvested from Monad mainnet txs**. They are verified by the real Pyth contract on the fork and served by a local Hermes-compatible replay that subsets them per request, as Hermes does.
  - `--hermes live` (real Hermes, real time) exists but is untested, because no key was available.
  - Liquidations run on a **plain anvil (chain id 143) with the test MockPyth**, because real prices didn't move enough.
  - Ports: fork 8945 (keeper 9187), mock 8947 (keeper 9189). 8946 was taken by another agent's anvil.
- **`/health` network label.** It reports `"monad-mainnet"` on chain 143, and `"anvil"` plus `fork: { of: "monad-mainnet" }` on a rehearsal, following the existing rule that anvil numbers are never labelled Monad. It also reports `mode: "monad-mainnet"` and `production: true`.
- **Ops additions:**
  - AUSD issuer-risk alerts: `isTransferPaused()`, `isAccountFrozen(clearinghouse)`, and Pyth `Crypto.AUSD/USD` `0xd9912df360b5b7f21a122f15bdd5e27f62ce5e72bd316c291f7c86620e07fb2a` for depeg;
  - `/livez` for platform restarts;
  - automatic `claimExecutionFees` / `claimKeeperRewards`;
  - `npm run guardian:pause`;
  - `npm run timelock` (Safe Transaction Builder JSON for schedule/execute, plus a `seed` batch for lane insurance and pools from the treasury Safe).
- **Not done:** no keeper policy for `backstopReduce`. Keepers are backstop operators per DeployProd, but pool exposure is left to the pools.
- **Infrastructure:**
  - `keeper/src/foundry.ts`'s shadow foundry root now handles the multi-line `fs_permissions` and relative `remappings` in `contracts/foundry.toml`. Without that, private demo stacks and X-ray slot labels broke.
  - CLI flag `--env PATH`, not `--env-file`: tsx hands `--env-file` to node.
  - The keeper image installs only viem + esbuild, because `npm ci` with node 22's npm 10 rejects `package-lock.json` ("Missing: zod@3.25.76 from lock file"). Hosted app builds that run `npm ci` on npm 10 may hit the same problem.
  - Added a root `.dockerignore` (allowlist) next to `keeper/Dockerfile.dockerignore`.

### Contracts agent: v2 after the adversarial review (`contracts/REVIEW.md`). **Keeper and frontend must adapt**
> **Partly superseded by v3 below:**
> - the cure buffer is now cure at maintenance (`CURE_BUFFER_BPS` removed);
> - holder top-ups are now bounded by `topUpAllowance`;
> - other legs are now priced from the executor's update;
> - the request window is now 1 h and single-use.
Every finding (R-01…R-11 and the info items) is fixed per the coordinator's decisions. Each fix maps to a regression in
`contracts/SECURITY_NOTES.md` §1; the PoCs in `contracts/test/review/` are flipped and now assert the exploits fail. ABI
regenerated.

**ABI delta (v1 → v2):**
- **Changed:**
  - `getOrder` adds `reduceOnly` (after `status`) and `positionId` (last).
  - `getPosition` adds `id` (after `isLong`).
  - `setOracleParams(maxPriceAge, maxStoredPriceAge, maxConfBps)`.
  - `setBackstopOperator(operator, lane, allowed)` and `isBackstopOperator(operator, lane)`.
  - Events: `OracleParamsUpdated(maxPriceAge, maxStoredPriceAge, maxConfBps)` and
    `BackstopOperatorSet(operator, lane, allowed)`.
- **Added functions:** `backstopRequestWithdraw(lane, shares)`, `backstopWithdrawRequest(lane, lp)` returning
  (shares, readyAt, expiresAt), `backstopEpoch(lane)`, `backstopWithdrawDelay()`, `setBackstopParams(delay)`,
  `previewWithdraw(account, amount)`, `laneSolvency(lane)` returning (held, claims, surplus, insurance, badDebt,
  haircutBps), `lanePrice(lane, market)` returning (price, publishTime), `markPriceInLane(lane, market)`,
  `maxStoredPriceAge()`.
- **Added constants:** `CURE_BUFFER_BPS`, `MAX_AUCTION_DISCOUNT_BPS`, `MAX_OI_CAP_MULTIPLIER_BPS`,
  `MAX_PRICE_AGE_LIMIT`, `MIN_FIRST_DEPOSIT`, `BACKSTOP_WITHDRAW_WINDOW`.
- **Added events:** `AccountSkipped(lane, account)`, `BackstopLossAbsorbed(lane, amount)`,
  `BackstopPoolReset(lane, epoch, retiredShares, deficit)`, `BackstopWithdrawRequested(lane, lp, shares, readyAt)`,
  `LaneHaircut(lane, account, debited, paid)`, `BackstopParamsUpdated(delay)`.
- **Added errors:** `DepositTooSmall`, `LaneInDeficit`, `LaneInsolvent`, `MarketHasOpenInterest`, `NoWithdrawRequest`,
  `PositionChanged`, `WithdrawNotReady`, `WithdrawRequestExpired`.

**Behaviour the keeper and app must handle:**
1. **Prices are monotonic per lane.** Stored and lane prices expire after **15 s**; supplied updates after **30 s**.
   - The keeper must keep Pyth storage fresh (push `updatePriceFeeds` ≤ 15 s apart).
   - `[]` calls (the browser) revert with `StalePrice` when storage is older than 15 s and no newer price has been used
     in that lane. Retry after the next push.
   - `priceUpdate` may be **partial**: only the markets a call touches are parsed.
2. **`executeOrder` uses `priceUpdate` only for the order's own unique fill update.** Other legs come from Pyth storage
   or the lane price (keep storage fresh), and appending a "latest" blob is no longer needed. An order whose position
   was taken or replaced since commit becomes `Failed` (`PositionChanged`); the executor is still paid. The default
   `minExecDelay` is now **3 s**.
3. **LP withdrawals are two-step:** `backstopRequestWithdraw(lane, shares)`, then after `backstopWithdrawDelay` (1 h)
   and within 1 day, `backstopWithdraw(lane, shares, priceUpdate)` at the NAV of that moment. A request works while
   paused; `0` cancels it.
4. **Haircuts:**
   - `withdraw`, `backstopWithdraw` and `claimKeeperRewards` pay `previewWithdraw` if the lane has bad debt.
   - `Withdraw` and `BackstopWithdraw` carry the **paid** amount, and `LaneHaircut` is emitted.
   - Fresh deposits and pool deposits into a lane with bad debt revert `LaneInDeficit`.
   - **Alert on `laneSolvency(lane).surplus < 0`.** `solvency()` now only detects token-level losses.
5. **Deposits:** fresh deposits are capped as before, and the first must be ≥ 1 AUSD. **Accounts holding positions can
   top up** beyond the 50 AUSD cap, up to `maxDepositPerAccount + Σ margins`, ignoring the lane TVL cap and allowed
   while paused. The UI should offer "add margin" to holders.
6. **Auctions:**
   - Pool and external takers are paid `min(P, max(E, 0))`, and `AuctionTaken.badDebt` is the negative equity only.
   - A cure needs equity ≥ 110% of MM and at least one block after the start.
   - Batches skip unpriceable accounts (`AccountSkipped`), and `getLiquidatableAccounts` never reverts on a bad feed.
7. **OI cap = lane insurance × 5 only** (pool deposits do not count). With `LANE_INSURANCE_SEED_AUSD = 0`, trading
   is impossible until lanes are funded.
8. **Pools:** an insolvent flat pool retires all shares (`BackstopPoolReset`, a new epoch), and old shares read as 0.
   Pool cash is the second loss layer after insurance (`BackstopLossAbsorbed`).
9. **Operators are per lane:** keeper *i* may `backstopReduce` lane *i* only. The deploy script maps
   `KEEPER_ADDRESSES[i]` to lane *i*.
10. **Deploy script env:**
    - New: `MAX_STORED_PRICE_AGE_SECONDS` (15), `BACKSTOP_WITHDRAW_DELAY_SECONDS` (3600), `OWNER_IS_EOA` (false; the
      owner must be a contract otherwise).
    - Changed defaults: `MIN_EXEC_DELAY_SECONDS` 3, `MAX_PRICE_AGE_SECONDS` 30.
    - New `params` keys: `maxStoredPriceAgeSeconds`, `backstopWithdrawDelaySeconds`, `cureBufferBps`.
    - The read-only fork simulation passes: 16.8M gas, about 3.39 MON at 202 gwei.
11. **Tighter bounds:** auction max discount ≤ 5%, price ages ≤ 60 s, confidence ≤ 5%, OI multiplier ≤ 10×. A
    market's feed cannot change while it has OI.
12. **Size 47,287 B** (anvil and forge script need `--code-size-limit 131072`).

**Deviations from the coordinator's decisions (refinements, documented):**
- **R-04:** holders' top-ups are exempt from the lane TVL cap and the fixed per-account cap, but bounded by
  `maxDepositPerAccount + Σ position margins`. Fully unbounded would let a 1-AUSD position unlock unlimited deposits.
- **R-05:** the haircut is computed on realised claims, and fresh and pool deposits into a deficit lane are refused so
  that new money is never diluted by old debt. Holders' top-ups into a deficit lane are allowed and exposed to the
  haircut.
- **R-07:** the OI cap is based on insurance only.

### Keeper / ops agent: adapted to contract v2 (+ R2-09 chunking)
Details are in `docs/RUNBOOK.md` (8b push policy, 4b LP exit, 13b lane deficit) and `keeper/README.md` → *Production*.

- **Pyth push policy, decided by cost (runbook 8b).**
  - **Measured on the fork:** a 3-feed `updatePriceFeeds` costs 166.6k gas (183k limit) = 0.0187 MON at 102 gwei; 1 feed costs 0.0128 MON.
  - **Measured third-party cadence on Monad mainnet** (`npm run pyth:cadence`, read-only): MON is pushed 171–224 times per hour, SOL and BTC 116–171 times. The **stored** price is ≤ 15 s old only 38–64 % of the time.
  - **(a) Interval pushes every ≈ 12 s** cost 83–102 MON/day (4,450–5,469 pushes/day despite the third-party pushes).
  - **(b) On-demand only inside keeper txs** costs 0, but multi-leg executions then revert `StalePrice` about half the time.
  - **(c) Hybrid — chosen, `PYTH_PUSH_MODE=on-demand`.** It pushes exactly the stale feeds, from the lane keeper, right before a multi-leg execution: ≈ 0.5–0.7 MON/day at 200 orders/day.
  - Auctions carry their own update, the fill uses its own unique update, and users get fresh updates through `/hermes`.
- **`executeOrder` sends only the fill update.** The extra "latest" blob was dropped. For v3's "other legs priced from the executor's update", `EXEC_OTHER_LEGS=append` restores an appended blob for just those feeds with no push. It is a switch, not yet the default.
- **Per-lane solvency.** `laneSolvency(lane).surplus < 0` raises `solvency:lane<i>` (critical); `solvency()` stays as the token-level alert. Events are alerted, not treated as failures: `LaneHaircut` → `haircut:lane<i>`, `BackstopLossAbsorbed` → `pool:loss`, `BackstopPoolReset` → `pool:reset`, `AccountSkipped` → `auction:skipped`. A `LaneInsolvent` revert raises `lane:insolvent:<i>`.
- **Cure.** The cure line is the contract's `CURE_BUFFER_BPS` (110 % in v2); if the getter is absent the keeper uses 100 % of maintenance (v3); `SWEEPER_CURE_BPS` overrides both. A cure is never sent in the start block.
- **R2-09 chunking.** Every `startAuctions` / `backstopTakeBatch` / `expireBatch` stays ≤ 30M × 0.8.
  - **Per-account gas measured** on a 600-account lane: 73.7k to start, 94.8k to take (the review estimated 57.5k / 75.5k). The keeper re-learns these values from receipts.
  - **Rehearsal scale leg:** 600 accounts in one lane → 3 start txs (max 22.8M) + 4 take txs (max 23.9M), all taken, solvent. Run against the v2 artifacts while the v3 source was mid-edit, via a debug-only deploy hook.
- **Deploy wrapper (v2).**
  - **Preflight:** `OWNER_IS_EOA`, and the guardian and keepers must be distinct.
  - **Verification adds:**
    - the per-lane operator matrix (keeper i ↔ lane i only; the deployer on no lane);
    - `maxStoredPriceAge` 15, `maxPriceAge` 30, `minExecDelay` 3 and `backstopWithdrawDelay` 3600;
    - the v2 `params` keys.
  - **Forge environment:** forge now receives only the deployer key and role **addresses**; every other secret is stripped.
  - **Pyth refresh push:** only when a feed is older than `PYTH_MAX_FEED_AGE_SECONDS`, since v2's DeployProd reads `latestPrice`.
- **Rehearsal (v2).**
  - **Fork leg:**
    - the owner is a **real Safe** (2-of-2) created through Monad's canonical SafeProxyFactory 1.4.1;
    - the timelock unpause executes as that Safe;
    - an on-demand push before the second-leg order is asserted;
    - the LP two-step exit runs (request → `WithdrawNotReady` → 1 h → withdraw).
  - **MockPyth leg:**
    - cure at 110 %;
    - a lane-7 **deficit drill**: a BTC short wins 81 AUSD against 20 AUSD of insurance → bad debt 51 AUSD, haircut 29.7 %;
    - `solvency:lane7` and `haircut:lane7` alerts fire, and a fresh deposit reverts `LaneInDeficit`;
    - the runbook repair batch (`timelock seed --lanes 7`) clears the deficit and the alert resolves.

  On v2: fork leg 24/24, MockPyth leg 13/13 (deficit repaired with a direct `fundLane`; the batch path is in the v3 run), scale leg 5/5.

### Contracts agent: v3 after the v2 re-review (`contracts/REVIEW.md` § v2 re-review). **Keeper and frontend must adapt**
All four Mediums (R2-01, R2-02, R2-05, R2-08) and the Lows R2-03, R2-04 and R2-07 are fixed per the coordinator's
decisions. R2-06 is accepted and R2-09 documented. Every R2 PoC in `contracts/test/review/` is flipped into a
regression (FLIPPED header), except R2-06 (accepted bound) and R2-09 (gas measurement). Mapping:
`contracts/SECURITY_NOTES.md` §1a. ABI regenerated. Contract sha256 in the final report; size 50,051 B (initcode
51,413 B: Monad allows 256 KB, anvil and forge need `--code-size-limit 131072`).

**ABI delta (v2 → v3):**
- **Removed:** `CURE_BUFFER_BPS()`.
- **Added functions:**
  - `replaceMarketFeed(bytes32 marketId, bytes32 newFeedId, uint256 maxDeviationBps)` (timelock);
  - `topUpAllowance(address account)` (view);
  - `backstopReceivable(uint8 lane)` (view);
  - `TOP_UP_TARGET_BPS()` = 11000, `MAX_FEED_SWAP_DEVIATION_BPS()` = 1000.
- **Added events:** `MarketFeedReplaced(marketId, oldFeedId, newFeedId, newPrice)`, `BackstopRepaid(lane, amount)`.
- **Added errors:** `FeedSwapDeviation(lane, referencePrice, newPrice)`, `NoReferencePrice(market)`,
  `MarginAboveNotional(margin, notional)`.
- **Changed value:** `BACKSTOP_WITHDRAW_WINDOW()` is 3600 (was 86400).
- No other signature changed.

**Behaviour the keeper and app must handle:**
1. **Deposits (R2-01).** Only `topUpAllowance(account)` may bypass the caps. It is non-zero only while an account
   holding positions has equity below its initial margin, and brings equity to 110% of initial margin. Everything else
   obeys the 50 / 500 caps and `LaneInDeficit`. The app should show "add margin (beyond cap): up to
   `topUpAllowance`". An increase that adds margin above notional now fails at fill (`MarginAboveNotional`).
2. **Auctions (R2-05, R2-07).**
   - **Cure at maintenance**, with the ≥ 1-block rule unchanged. The keeper's 100% fallback is now the contract rule.
   - `startAuctions` **closes out negative-equity accounts at once** (`AuctionExpired`, counted in
     `auctionStats.expired`) instead of auctioning them. The return value counts only auctions started.
   - **Reduce-only orders may be committed and executed while in auction.** They fill only if they leave the account at
     or above maintenance (at the fill and current prices), and then end the auction (`AuctionCancelled`). The UI
     should offer "reduce / close" to an account in auction.
3. **Order execution (R2-03).** Other legs are priced from the executor's `priceUpdate` through the monotonic lane
   path. Send `[latest for the account's feeds, unique update at execAfter]`, which is the keeper's
   `EXEC_OTHER_LEGS=append` and should now be the default. No Pyth push is needed for multi-leg orders; storage stays
   the fallback.
4. **Pools (R2-04, R2-08).**
   - LP withdrawal requests are **single-use**: any withdrawal consumes them. The execution **window is 1 h** after the
     1 h delay.
   - NAV counts unrealised gains only up to lane insurance.
   - Pool cash used by the loss waterfall is a **loan** (`backstopReceivable`), repaid from lane inflows before
     insurance (`BackstopRepaid`).
5. **Dead feed (R2-02).** The procedure is in `contracts/SECURITY_NOTES.md` §4.7:
   1. Push the new feed's price.
   2. The timelock calls `replaceMarketFeed(market, newFeed, ≤ 1000 bps)`.
   3. The call checks every lane with OI against its newest price, resets the market's lane price markers, and
      repoints the market.
6. **Keeper rewards (I2-8).** `claimKeeperRewards` skips a lane that cannot pay instead of reverting; those rewards
   stay claimable.
7. **Deploy `params`:** added `topUpTargetBps` and `backstopWithdrawWindowSeconds`; removed `cureBufferBps`. The fork
   simulation passes: 17.5M gas, about 3.54 MON at 202 gwei.

**Deviations from the coordinator's decisions (refinements, documented):**
- **R2-01:** the exemption triggers when equity is **below 100%** of initial margin (target 110%), not below ~110%. With
  a 110% trigger, a 1× all-in account (equity = IM) is always exempt and can ratchet geometrically with real 1×
  orders. The 100% trigger needs real losses to open headroom.
- **R2-02:** a dedicated `replaceMarketFeed` with an explicit `maxDeviationBps` argument (≤ 10%, recommended 500)
  instead of a fixed 5%. A dead feed's last price may be stale, and the bound is visible in the 24 h timelock
  proposal. The reference price is each OI lane's last-used price, or the old feed's last stored price for a lane
  without one.
- **R2-07:** the regression also documents the remaining first-come residual for **unrealised winners**
  (`test_R2_07b`, SECURITY_NOTES §4.5); the decision closes only the negative-equity-at-start window.
- **R10:** by decision R2-03, the v2 regression "same outcome for every data shape" no longer holds for **newer**
  prices. It now asserts that older prices cannot steer (`test_R10_ExecutorCannotChooseOutcomeViaOlderOtherLegPrices`).


### Keeper / ops agent: adapted to contract v3
- **`EXEC_OTHER_LEGS=auto`** (now the default) detects v3 via `TOP_UP_TARGET_BPS()` and sends `[latest for the account's feeds, unique update at execAfter]`. The latest blob also covers the order market when the account is in auction, so a reduce-only fill gets a current price. On v3 no push is needed for executions; v2 keeps the on-demand push.
- **Measured on the fork (v3):**
  - multi-leg execution: 673.7k gas limit vs 496.8k for the largest single-leg fill (+177k ≈ 0.018 MON);
  - Pyth push: 183k (3 feeds) / 126k (1 feed).
- **Pyth cadence on mainnet** (four windows): stored ≤ 15 s old 38–79 % of the time. An interval policy would push 3,146–5,469 times/day ≈ 59–102 MON/day.
- **Push decision on v3: (b)**, only inside the keeper's own txs. That costs ≈ 1.1 MON/day of appended verification at 200 orders/day, reimbursed by execution fees. Interval mode stays opt-in.
- **Cure / close-out.** The cure line falls back to 100 % (`CURE_BUFFER_BPS` gone). Close-outs at start are counted from `auctionStats.expired`.
- **New alerts:** `BackstopRepaid` → `pool:repaid` (info). `MarketFeedReplaced` → `gov:feed` (critical); the keeper switches the market's feed in every loop and in the `/hermes` proxy without a restart.
- **Dead-feed tooling:**
  - `npm run timelock -- feed-swap --market … --feed 0x… --max-deviation-bps 500` prepares `replaceMarketFeed`;
  - `npm run pyth:push -- --feeds 0x…` keeps the new feed's stored price ≤ 15 s while the Safe executes (nobody else pushes a new feed);
  - the runbook procedure is §13c.
- **LP exit:** a 1 h window and single-use requests. The rehearsal asserts `NoWithdrawRequest` on reuse.
- **`/backstop`** adds per-lane `receivable` and the LP's `withdrawRequest`.
- **Rehearsal results (v3):**
  - fork leg 22/22 — run against a v3 artifact snapshot through a debug deploy hook, because the source was already mid-edit for v4 (DeployProd v3 itself ran on the MockPyth and scale legs);
  - MockPyth leg 15/15: cure at 100 %, reduce-close in auction, deficit drill, dead-feed swap drill with a `FeedSwapDeviation` negative;
  - scale leg 5/5 (600 accounts: 3 start + 5 take txs, max 23.8M gas).
- **MON budget (v3, two weeks):** ≈ 195 MON on the hot keys and ≈ 200 MON gross spend; users' 0.1 MON execution fees (280 MON) cover executions.
- **Finding for the frontend:** top-ups beyond the deposit cap (`topUpAllowance`) need a usable stored or lane price (≤ 15 s); with stale storage the allowance reads 0. v4's planned `depositWithPrice` addresses this.

### Contracts agent: v4 after the v3 re-review (`contracts/REVIEW.md` § v3 re-review). **Keeper and frontend must adapt**
R3-01 … R3-05 are fixed per the coordinator's decisions, and I3-4 (invariant gaps) is closed. Every R3 PoC in
`contracts/test/review/` is flipped into a regression (FLIPPED header). Mapping: `contracts/SECURITY_NOTES.md` §1a.
ABI regenerated (`npm run abi`; `npx tsc --noEmit` passes). Contract sha256
`3e30e90153fd352abea43d5225bd79e7ebfd5d85a772e74ff423a9c4c109df19`; size 51,418 B (initcode 52,780 B; Monad allows
256 KB, anvil and forge need `--code-size-limit 131072`).

**ABI delta (v3 → v4), additions only (nothing removed or re-typed):**
- **Added functions:**
  - `depositWithPrice(uint256 amount, bytes[] priceUpdate) payable` (R3-04; `deposit(uint256)` unchanged);
  - `backstopDepositStatus(uint8 lane) view returns (bool open, uint256 receivable, int256 unrealizedUncapped, uint256 insurance)`;
  - constants `MAX_DEAD_FEED_SWAP_DEVIATION_BPS()` = 5000 and `DEAD_FEED_AGE()` = 3600.
- **Changed value:** `TOP_UP_TARGET_BPS()` is **10000** (was 11000). The deploy JSON's `params.topUpTargetBps` reads it
  from the contract, so it is 10000 too.
- **Added events:** `BackstopReceivableNetted(uint8 indexed lane, uint256 amount)`,
  `BackstopSwept(uint8 indexed lane, uint256 cash, uint256 receivableForgiven)`.
- **Added errors:** `BackstopReceivableOutstanding(uint8 lane, uint256 receivable)`,
  `BackstopGainCapBinding(uint8 lane, int256 unrealized, uint256 insurance)`.

**Behaviour the keeper and app must handle:**
1. **Pool deposits (R3-01).** `backstopDeposit` now also reverts `BackstopReceivableOutstanding` while the pool is owed
   a receivable, and `BackstopGainCapBinding` while the pool's unrealised gain exceeds lane insurance. Check
   `backstopDepositStatus(lane).open` before offering the deposit button; show "pool deposits paused: the lane owes the
   pool X" / "pool gain above lane insurance". Exits are unchanged.
2. **Pool accounting (R3-01).** A flat pool whose cash goes negative first nets its receivable
   (`BackstopReceivableNetted`) and is reset only if cash + receivable ≤ 0 (`BackstopPoolReset` unchanged). When the
   last LP leaves, the receivable is forgiven and any orphaned cash goes to the lane (`BackstopSwept`). Keeper alert
   suggestion: `BackstopSwept` with `receivableForgiven > 0` → `pool:forgiven` (warn).
3. **Margin top-ups (R3-03, R3-04).** The exemption now restores equity to exactly 100% of initial margin. The app
   should call `depositWithPrice(amount, latestUpdateForTheAccountsFeeds)` (fee from `IPyth.getUpdateFee`, excess
   refunded) whenever the account holds positions, so the exemption is computed at fresh prices even when Pyth
   storage is stale. `topUpAllowance` (view) still reads storage / lane prices only.
4. **In-auction reduce executions (R3-05).** The "current" price must be **strictly newer than `execAfter`** and at most
   `maxStoredPriceAge` (15 s) old. The keeper's `[latest, unique]` blob already satisfies it when executed at least
   1 s after `execAfter`. Otherwise the call reverts `StalePrice` and the order stays pending; retry with a fresh
   latest message. Blob order no longer matters.
5. **Dead feed (R3-02).** `replaceMarketFeed` accepts `maxDeviationBps` up to **5000** when the old feed is provably dead
   on chain (Pyth has no stored price, or it is older than `DEAD_FEED_AGE` = 1 h when the timelock executes), and up
   to 1000 otherwise. Anyone can refute a false "dead" during the 24 h delay by pushing the old feed. The runbook's
   `feed-swap` should allow up to 5000 bps for a dead feed.
6. **Deploy:** no new variables. Fork simulation (no broadcast) passes all on-chain checks: 17.95M gas, about
   3.63 MON at 202 gwei.

**Deviations from the coordinator's decisions (refinements, documented):**
- **R3-01 (option chosen): refuse, don't re-price.** Deposits are refused while a receivable is outstanding or the cap
  binds (the coordinator's "acceptable" option). Exits stay at the conservative NAV (receivable at 0, gain capped):
  an LP who exits while a receivable is outstanding forfeits its share of it, to the LPs who stay.
- **R3-01d (my call): the same gain-cap refusal.** The attack needs a deposit priced while the cap is depressed. With
  the refusal, every deposit is priced at the full, uncapped NAV, and later cap movements can only lower NAV below
  that, never raise it above, so a cap that rises after the deposit transfers nothing to the new LP. Rejected
  alternatives: an insurance snapshot or TWAP for the cap (more state, still movable over time), and a two-NAV scheme
  (more code for the same guarantee). Residual: a hedged pair can still depress NAV at the moment another LP exits;
  that LP loses, the stayers gain, the attacker pays fees (SECURITY_NOTES §4.6).
- **R3-01 sweep:** orphaned cash goes through the normal inflow waterfall (bad debt first, then insurance), not
  straight into insurance. The receivable is forgiven by zeroing it (future inflows then go to insurance).
- **R3-05:** the coordinator asked for "a price within `maxStoredPriceAge` of block time, independent of blob order".
  That alone would still let the fill message (published at `execAfter`, usually < 15 s old) be the "current" price,
  so the PoC would pass. v4 also requires the current price to be **strictly newer than `execAfter`**, and applies the
  bound to the resolved price too (so pushing the fill message into Pyth storage doesn't help either). The executor
  can still choose which real price in that ≤ 15 s window to supply (documented residual).
- **Added view** `backstopDepositStatus(lane)` so the app can pre-check the new refusals without a revert.
- **`backstopDeposit` checks `LaneInDeficit` after settling the pool** (settlement can itself create bad debt).

### Keeper / ops agent: adapted to contract v4; final rehearsal (v4)
- **Executor.** An in-auction reduce-only execution waits until chain time ≥ `execAfter` + 1. It requires the appended `latest` price for the order market to be strictly newer than `execAfter`, and retries on `StalePrice`.
- **Seed / repair batch (`timelock seed`).** It reads `backstopDepositStatus(lane)` and leaves pool deposits out for closed lanes, printing why (`BackstopReceivableOutstanding` / `BackstopGainCapBinding`). Insurance top-ups are never skipped.
- **`timelock feed-swap`** accepts up to 5000 bps. It prints the dead-feed condition (old feed missing or > 1 h stale when the operation **executes**) and the note that anyone can refute it during the 24 h delay.
- **Alerts:**
  - `BackstopReceivableNetted` → `pool:netted` (info);
  - `BackstopSwept` → `pool:forgiven` (warning, when `receivableForgiven > 0`) or `pool:swept` (info);
  - **`pool:closed:lane<i>`**: deposits closed longer than `ALERT_POOL_CLOSED_H` (6 h), against a hedged-pair deposit DoS. `/health.poolDeposits` shows the per-lane status. Runbook §13d.
- **Rehearsal drill:** a beyond-cap rescue top-up through `depositWithPrice` (collateral 29.87 → 54.46 AUSD against the 50 cap, then the cure). The mock leg now runs 2 s blocks, so the top-up lands before the lane pool's 75 bps take.
- **Final rehearsal on v4, real DeployProd on every leg (`contracts/cache/rehearsal/v4-final`): 43/43.**

  | Leg | Steps | Notes |
  | --- | --- | --- |
  | Fork | 23/23 | DeployProd v4: 21 txs, 17.96M gas limit |
  | MockPyth | 15/15 | |
  | Scale | 5/5 | 600 accounts; 3 start + 5 take txs, max 23.8M gas |
- **Final MON budget (v4 gas, two weeks):** ≈ 195 MON on the hot keys. Gross spend ≈ 200.5 MON; users' execution fees (280 MON) cover executions.
- **Pyth push decision unchanged:** option (b) on v3+. Cadence in this run: stored ≤ 15 s old 48–58 % of the time; an interval policy would push 5,056 times/day ≈ 94 MON/day.
- **The launch gate needs this rehearsal re-run on the v5 hash.**

### Contracts agent: v5 after the v4 re-review (`contracts/REVIEW.md` § v4 re-review). **Keeper and frontend must adapt (small)**
The v4 re-review found no Critical, High or Medium (the review item of the gate passes). v5 is a small, targeted fix
of its four Lows; every R4 PoC is flipped (FLIPPED v5 headers), mapping in `contracts/SECURITY_NOTES.md` §1a. Final
contract sha256 **`1643014507eaf16afd06d25a50d2f9bdac8a0556ede00f960cc9fcbda702a5ed`**; size 51,876 B (initcode
53,238 B). `forge test`: 272 passed, 1 skipped (the opt-in fork test, which passes). Slither on a clean build: 158
results, no new categories. ABI regenerated (two new errors); `npx tsc --noEmit` passes.

**ABI delta (v4 → v5):** added errors `BackstopPositionsOpen(uint8 lane)` and
`CollateralAboveCap(int256 collateral, uint256 cap)`. No function, event or constant changed.

**Behaviour the keeper and app must handle:**
1. **LP exits (R4-01).** `backstopWithdraw` pays its share of `cash + min(unrealised, 0)`: unrealised gains and the
   receivable count 0 until realised. `backstopNav` now reports exactly this exit NAV (`unrealized = equity − cash`,
   ≤ 0); show the uncapped figure from `backstopDepositStatus(lane).unrealizedUncapped` as "pending gain (paid when
   realised)". Deposits are still priced at the full NAV.
2. **Last LP (R4-02).** The withdrawal that would leave zero shares reverts `BackstopPositionsOpen(lane)` while the pool
   holds any position, dust included. Keeper: when a pool's last LP has a ripe request, unwind the lane's pool
   positions with `backstopReduce(lane, market, type(uint256).max, update)`. App: explain the error.
3. **Margin above the cap (R4-03).** `commitOrder` with `marginDelta > 0` reverts `CollateralAboveCap` while the
   account's collateral is above `maxDepositPerAccount`, and such an order already committed fails at fill. Reduces,
   closes and margin-free increases are unaffected. App: offer "withdraw down to the cap".
4. **Zombie feeds (R4-04).** `replaceMarketFeed`'s 50% bound also applies when the old feed's newest stored price is
   unusable (non-positive, bad exponent, confidence above `maxConfBps`). The runbook's `feed-swap` should treat such a
   feed as dead.
5. **Ops alerts (I4-1, I4-3).** Alert when `backstopDepositStatus(lane).open == false` lasts (deposit-closure DoS via a
   hedged pair; cleared by lane inflows or `fundLane`). An in-auction reduce parses the update three times: read
   `getUpdateFee` per call (three fees if Pyth's fee ever returns; 0 today).
6. **Deploy:** unchanged. Fork simulation (no broadcast) passes all checks: 18.08M gas, about 3.65 MON at 202 gwei.

**Deviations from the coordinator's decisions (refinements, documented):**
- **R4-01:** the preferred option (`cash + min(unrealised, 0)`) as asked. `backstopNav`'s return values keep their
  shape but now describe the exit NAV, so `equity = cash + unrealized` still holds for the app.
- **R4-03:** the cap rule is checked at commit **and at fill** (a top-up between the two must not slip through).
- **R4-04, found while flipping:** classifying a zombie as dead was not enough. A lane with open interest but no
  recorded price (single-leg accounts never record one, because fills are historical) took its reference from the old
  feed's stored price only if usable, so a zombie still reverted `NoReferencePrice`. The reference now ignores the
  confidence (it only has to catch a wrong-asset feed) and falls back to the market's newest price in any lane
  (regressions `test_R4_04d`, `test_R4_04e`).
- **Fair-value ghost (Info):** the reviewer suggested "cash + realisable gain + receivable". The realisable gain
  depends on insurance, the quantity R4-01 manipulates, so the ghost uses the independent bound "an exit is paid at
  most its share of the pool's ledger cash". It catches the v4 exit rule as a mutation within 32 runs. I also added an
  empty-pool ghost checked at the exit itself (it catches a missing R4-02 guard at 256 runs; the end-of-sequence invariant could
  miss it once a later unwind flattened the pool).

### Keeper / ops agent: v5 and the final rehearsal (launch-gate evidence)
- **Contract v5:** sha256 `1643014507eaf16afd06d25a50d2f9bdac8a0556ede00f960cc9fcbda702a5ed` (verified on the source file).
- **Final `npm run rehearse:mainnet`, real DeployProd v5 on every leg: 43/43.**

  | Leg | Steps |
  | --- | --- |
  | Fork | 23/23 |
  | MockPyth | 15/15 |
  | Scale | 5/5 |

  Deploy: 21 txs, 18.09M gas limit (14.84M used).
- **Tracked evidence:** `bench/rehearsal/143-fork-v5-2026-10-07T05-41-11Z.json` (checked: no keys in it) and `bench/rehearsal/README.md` with the hash. The `contracts/cache` copies are gitignored.
- **Keeper additions for v5:**
  - **Pool exit helper** (`keeper/src/prod/poolexit.ts`). When a lane's last LP has a ripe exit request and the pool holds positions, that lane's keeper (its only backstop operator) calls `backstopReduce` per position with a fresh update. It is not exercised by the rehearsal.
  - **Expected reverts.** `BackstopPositionsOpen`, `CollateralAboveCap` and `MarginAboveNotional` are recorded as expected refusals and never page.
  - **Pyth fee.** `getUpdateFee` is read per call, for every blob.
- **Final MON budget (v5 gas, 102 gwei, two weeks, 200 orders/day, 20 liquidations/day):**

  | Key | MON |
  | --- | --- |
  | Deployer | 3.65 |
  | Guardian | 0.5 |
  | OPS | 40.6 |
  | Each of the 8 keepers | 18.8 |
  | **Total** | **≈ 195** |

  Gross spend is ≈ 201 MON; users' execution fees (≈ 280 MON) cover the executions.
