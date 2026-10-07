# Testnet production plan (Monad testnet, chain 10143)

Goal: make the integrations real on Monad testnet with the **production** contract
(`ParaclrClearinghouseProd`, v5, unchanged): real Agora testnet AUSD, real Pyth
verification, a Safe behind the timelock, OpenZeppelin, Privy. No real money.
Interface contract between agents; deviations go at the bottom.

## Verified facts (2026-10-07)
- Agora AUSD on Monad testnet: `0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC`
  (Agora docs, contract deployments); faucet `0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C`.
  Verify decimals and code on chain before use.
- Pyth on Monad testnet: `0x2880aB155794e7179c9eE2e38200202908C17B43` (same as mainnet), same feed ids.
- **Nobody pushes Pyth prices on testnet** (MON stored price ~8 days old, BTC ~45 min),
  so every price the contract uses comes from updates the keeper or app submits.
- Hermes needs `Authorization: Bearer $PYTH_API_KEY` on every host. The user's key is a
  13-day **trial** (ends ~2026-10-20): entitled to SOL/USD and BTC/USD, **not MON/USD**.
  After the trial, the Free plan has no API access.
- Safe supports Monad testnet (tx service `https://api.safe.global/tx-service/monad-testnet`).

## Decisions
- **Markets on testnet: SOL/AUSD and BTC/AUSD only.** MON is listed later, through the
  timelock, if Hermes access for MON is obtained.
- **Timelock min delay on testnet: 600 s** (env), so the demo can be maintained during
  judging. Mainnet keeps 24 h.
- **Trial-end fallback (documented, not executed now):** deploy a keeper-fed price
  contract implementing the same `IPyth` surface the clearinghouse uses (the test
  `MockPyth` is the model), and point the clearinghouse at it with a timelocked
  `setPyth`. The app and landing then label prices "simulated after the Pyth trial".
  Write the runbook steps and a `timelock prepare` template; don't deploy it now.
- **Deployment file:** `deployments/10143.json`, written by the production deploy with
  `"production": true, "network": "monad-testnet"`. Every reader of `10143.json` must
  branch on `production` (the older demo-stack testnet format has no such flag).

## Keeper / deploy (chain agent)
- `--network testnet` everywhere the mainnet flow has `--network mainnet`: env file
  `keeper/.env.testnet` (template `keeper/.env.testnet.example`, gitignored real file),
  chain id 10143, RPC `https://testnet-rpc.monad.xyz`, AUSD testnet address above,
  Pyth above, `PROD_MARKETS=SOL/AUSD,BTC/AUSD` (deploy script lists only these, with
  their feed ids), `TIMELOCK_MIN_DELAY_SECONDS=600`, caps the same as mainnet beta.
  `keeper:init --network testnet` (fresh keys, addresses only), `keeper:fund --network
  testnet` (budget for testnet volume; keep it small), `deploy:testnet` (dry run by
  default, `--yes-testnet` to broadcast), `keeper -- --network testnet`.
- The keeper pushes Pyth updates for the listed feeds into storage (on-demand / within
  its own txs as on mainnet) and serves `/hermes` for the app.
- Rehearse on an anvil fork of Monad **testnet** (real testnet AUSD + Pyth) end to end.

## App + landing (frontend agent)
- New chain mode `NEXT_PUBLIC_CHAIN_MODE=monad-testnet` = the **production** adapter on
  chain 10143 (viem `monadTestnet`, explorer testnet.monadexplorer.com), reading
  `deployments/10143.json` with `production: true`. Same fail-closed rules as mainnet
  (no simulation fallback), but the burner/demo wallet is allowed on testnet, labelled.
- Markets come from the deployment (`markets` keys), not the hard-coded list: unlisted
  markets (MON) are hidden or shown as "not listed".
- AUSD: show "Get testnet AUSD" linking to Agora's faucet (address above; find Agora's
  faucet UI URL if one exists, else explain the contract faucet), and a "TESTNET" token tag.
- Labels everywhere: "Monad testnet · test funds, no real value".
- Landing status strip / beta section: "Live on Monad testnet" when `10143.json` has
  `production: true` (keep mainnet logic for 143), contract table with testnet explorer
  links. Honest copy about the Pyth trial and MON not listed.

## Deviations
(append here)

### Keeper / deploy (chain agent, 2026-10-07)

Implemented as specified unless listed here. Everything was exercised on anvil forks only; nothing was sent to Monad testnet or mainnet. Contract `ParaclrClearinghouseProd.sol` unchanged (sha256 `1643014507eaf16afd06d25a50d2f9bdac8a0556ede00f960cc9fcbda702a5ed`).

**Verified facts that change assumptions (read-only on chain; details in RUNBOOK §14.1–14.2):**
- **Testnet Pyth charges 1 wei per update message** (`singleUpdateFeeInWei` = 1; mainnet 0). Every priced call must send `getUpdateFee(update)` as `msg.value` (the app already reads it). Consequence via Monad's reserve-balance rule: an account below 10 MON can send a value-carrying tx only as its first tx in 3 blocks — this hits the keepers (handled: `MONAD_RESERVE_GUARD`) **and users** (`commitOrder`'s 0.1 MON fee already did on mainnet; on testnet also withdraw / pool calls with an update). **Frontend:** if a wallet holds < 10 MON, space priced txs ≥ ~2 s apart, and map a revert right after another tx to "wait a moment and retry".
- **Agora faucet** `0xd236…ee6C`: `requestFunds(address to)` → 10,000 AUSD; anyone may call it for any address; the 60 s `maxDripFrequency` is **global** (a different recipient within 60 s reverts `MaxFrequencyExceeded()` `0x20e5bc67`); recipients holding ≥ 100,000 AUSD revert `MaxAllowedExceeded()` `0x0949dab9`; `InsufficientFunds()` `0x356680b7`. **No faucet web page exists** (Agora's docs list only the contract and a viem snippet). ~113k gas limit.
- Testnet Pyth has the same Wormhole guardian set and Pythnet data source as mainnet: **mainnet-signed updates verify on testnet**. The rehearsal uses that (no API key was available): real signed SOL+BTC updates harvested from Monad mainnet txs, replayed on a testnet fork.
- Safe 1.4.1 (factory `0x4e1DCf7A…ec67`, SafeL2 `0x29fcB43b…C762`) exists on testnet. **anvil's dev accounts are EIP-7702-delegated on testnet** (sweeper-style contract): never derive a burner or owner from the anvil mnemonic on the real testnet.

**Interface changes / additions:**
- `--network testnet` now selects the **production** testnet profile in `keeper:init`, `keeper:fund` and `keeper`; the demo stack keeps `--network monad` / no flag (`keeper/.env`). The demo keeper now refuses a `"production": true` deployment file (`deployments/10143.json` is production from now on).
- `deployments/10143.json` = DeployProd's mainnet layout (`markets`, `pythFeeds`, `params`, …) **+** `"network": "monad-testnet"` (DeployProd `DEPLOY_NETWORK`) and, stamped by `deploy:testnet`, `"realPyth"`, `"priceSource": "pyth"`, `"ausdFaucet"`, `"testnet": true`. After the trial-end switch (`oracle:fallback record --live`): `"pyth"`/`"oracle"` = the KeeperSignedPyth address, `"priceSource": "keeper-signed"`, `"fallbackOracle"`, `"fallbackSigner"`, `"oracleSwitch": { to, at, note }`; `"realPyth"` keeps the real Pyth. **Frontend:** label prices "simulated after the Pyth trial" when `priceSource === "keeper-signed"` (also `/health.priceSource`); the update blobs then start with `PKS1`, not Pyth's `PNAU` — never parse `binary.data`, use `parsed`; fee 0.
- Keeper `/health` on testnet: `mode: "monad-testnet"`, `network: "monad-testnet"` (`"anvil"` on a fork), `testnet: true`, `sandbox: boolean`, `priceSource: "pyth" | "keeper-signed"`, `oracle.{mode, realPyth, fallbackOracle, signer, prepush}`, `reserveGuard`. Mainnet output gains the same fields with mainnet values.
- `/hermes` serves the listed feeds only: MON and AUSD/USD ids → 400. The keeper never asks Hermes for MON or AUSD/USD on testnet (depeg check off: `AUSD_DEPEG_CHECK=0`), asserted by the rehearsal.
- `DeployProd.s.sol` (script only): `PROD_MARKETS` ("SYM" or "SYM=0xfeed", ≤ 8), `DEPLOY_NETWORK` (optional `network` key), per-network AUSD default (10143 → testnet AUSD). Unset = the original MON/SOL/BTC mainnet behaviour, file layout unchanged. The 600 s timelock needs `ALLOW_SHORT_TIMELOCK=true` (passed by `deploy:testnet` only); the wrapper's preflight floor is 600 s on testnet, 1 h on mainnet.
- Testnet Safe threshold: the preflight requires ≥ 2 like mainnet; `SAFE_MIN_THRESHOLD=1` accepts a 1-of-1 Safe on testnet only. An EIP-7702-delegated owner is treated as an EOA (needs `OWNER_IS_EOA=true`).
- Funding on testnet: `FUNDING_SKIP_IDLE=1` (no max-age update while a market has no skew) and `FUNDING_MAX_AGE_S=21600`, to save testnet MON. Mainnet unchanged.

**Trial-end fallback (built, not deployed):** `contracts/src/testnet/KeeperSignedPyth.sol` + `contracts/test/testnet/KeeperSignedPyth.t.sol` (7 tests, incl. the production clearinghouse trading on it after `setPyth`). These two files are outside the paths assigned to the chain agent (new files; nothing existing in `contracts/src` changed). Keeper-signed prices relay Pyth's stored prices from Monad **mainnet** (read-only) by default — real Pyth numbers, but not Pyth-verified: honest only as long as the signer key is. `timelock set-pyth --to <oracle>` is the template; the keeper pushes into the fallback while that operation is pending and switches live on `PythUpdated`. Procedure: RUNBOOK §14.6. Do it ≥ 1 h before ~2026-10-20.

**Local sandbox (added scope):** `npm run sandbox [-- --detach --smoke | --stop]` — anvil fork of testnet on **:8645** (chain 10143, 1 s blocks), production keeper on **:8887** (`KEEPER_CORS_ORIGIN=http://localhost:3002`), deployment **`deployments/sandbox/10143.json`** (gitignored), owner = anvil dev account 0 `0xf39F…2266` (`OWNER_IS_EOA=true`, its 7702 delegation cleared on the fork), lanes seeded from Agora's faucet. `PYTH_API_KEY=` line in **`keeper/.env.sandbox`** (gitignored) → live Hermes; no key → the keeper-signed fallback switched in through the timelock (the 600 s delay is warped: **the sandbox's chain clock runs ~10 min ahead of the wall clock** in that mode). Sandbox-only `POST /faucet {address}` → `{ gasTxHash, ausdTxHash | null, method: "agora-faucet" | "storage-cheat", mon: "20", ausd: "10000", sandbox: true, label }` (an `ausdTxHash` of null = storage cheat, nothing to track). App: `npm run dev:sandbox` (= `NEXT_PUBLIC_CHAIN_MODE=monad-testnet NEXT_PUBLIC_MONAD_TESTNET_RPC_URL=http://127.0.0.1:8645 NEXT_PUBLIC_KEEPER_URL=http://127.0.0.1:8887 PARACLR_DEPLOYMENTS_DIR=deployments/sandbox next dev -p 3002`).

**Not done / untested:** live Hermes (no `PYTH_API_KEY` was readable here): the rehearsal replays real signed updates and the sandbox was verified in keeper-signed mode; Hermes mode with a real key is the rehearsed production code path but has not run end to end. The reserve-balance guard is exercised on forks (anvil doesn't enforce the rule) — its first real test is testnet.

### Frontend (app + landing), 2026-10-07
- **Mode** `NEXT_PUBLIC_CHAIN_MODE=monad-testnet` (alias `testnet`). The legacy `monad` mode (demo stack)
  now refuses a `deployments/10143.json` with `"production": true` and points at `monad-testnet`.
- **RPC**: `NEXT_PUBLIC_MONAD_TESTNET_RPC_URL` (falls back to `NEXT_PUBLIC_MONAD_RPC_URL`, then the public
  RPC). A localhost RPC = the local sandbox: labelled "Local sandbox (fork of Monad testnet) · not live",
  no explorer links, sandbox faucet button (keeper `POST /faucet`). `npm run dev:sandbox` runs it on :3002
  with `PARACLR_DEPLOYMENTS_DIR=deployments/sandbox`, keeper :8887, RPC :8645, and its own Next output dir
  `.next-sandbox` (Next 16 allows one `next dev` per output dir), so the :3001 demo keeps running.
  That needed small edits outside src/: `next.config.ts` (`distDir` from `PARACLR_DIST_DIR`), `.gitignore`,
  `eslint.config.mjs`, `tsconfig.json` (the `.next-sandbox` type globs Next would otherwise add itself).
- **Markets** (testnet and mainnet production): the file's `markets` keys that the clearinghouse also
  lists (`getMarkets()`); keys the app has no metadata for (anything but MON/SOL/BTC) are ignored. Every
  read, price feed and picker uses only those; an unlisted market shows as a disabled "not listed" pill and
  is never read. Feed id: on-chain `getMarkets` > file `pythFeeds` > Pyth's official id.
- **Oracle**: the clearinghouse's `pyth()` is the truth. It must equal the file's `realPyth` / `pyth`, or
  (testnet only) the file's `fallbackOracle`, in which case the app labels prices "simulated after the
  Pyth trial"; anything else fails closed. The landing has no RPC at build time, so it labels the switch
  from the file: `"oracle"` equal to `"fallbackOracle"` (what `oracle:fallback record --live` writes;
  `record --back` clears it). The app also reads `realPyth` when present.
- **Agora faucet**: no web UI exists (Agora's docs list only the contract). The wallet calls
  `requestFunds(self)` directly. Read from the implementation on chain: 10,000 AUSD per call, ONE drip per
  60 s across all callers (`lastDripTimestamp` is global), refused once the recipient holds 100,000.
  Gas: testnet MON from faucet.monad.xyz (linked). On an idle anvil fork the latest block's timestamp
  lags the wall clock, so the cooldown is enforced by the pre-send simulation, not a client pre-check.
- **Landing**: reads only the committed `deployments/10143.json` (never `PARACLR_DEPLOYMENTS_DIR`), so a
  rehearsal can't make it say "live". `benchResults.server.ts` treats a production 10143.json as "no demo
  stack on testnet".
- **Privy**: the embedded wallet's chain carries the app RPC as `privyWalletOverride`
  (`addRpcUrlOverrideToChain`). Privy's provider fills and broadcasts transactions from the page through
  that URL (only the signature comes from its iframe), so a localhost fork works; without the override
  Privy would use its own hosted RPC for chains it knows (it ships one for Monad mainnet), which would have
  sent mainnet-fork rehearsal transactions to the real chain. Wallet confirmation popups stay mainnet-only.
- **Reserve balance** (chain agent's note): the app's `sendTx` waits until 3 blocks have passed since the
  wallet's previous tx before sending a MON-carrying tx (commitOrder fee, Pyth fee) when the wallet holds
  < 10 MON, on a real Monad chain only; an on-chain revert in that situation says "wait a moment and retry".
- **Keeper-signed copy**: with the fallback oracle live, the banner, price badge ("Simulated · after the Pyth
  trial"), stored-price tile, order/position/wallet wording and the risk notice's oracle point say the prices
  are keeper-signed, not attested by Pyth (no "the relay can't alter it" claim). The landing lists
  `realPyth`, `ausdFaucet`, `fallbackOracle`, `fallbackSigner` with their own names.
- **Verified** (headless Chrome, `npm run sandbox -- --detach` + `npm run dev:sandbox`, keeper-signed prices):
  burner sign-in → sandbox faucet → SOL long (risk notice, exact approve, deposit, commit; keeper filled) →
  close (filled) → 20 AUSD backstop deposit. Passkey/Privy login was not exercised (needs a real passkey).
