# Hosting the production keeper (Monad testnet today, Monad mainnet at launch)

The production keeper is one long-running Node process. Run **exactly one instance per key set**. Two instances would race the same nonces and send every execution twice. The duplicates revert harmlessly with `OrderNotPending`, but each one still burns gas.

It needs:

- outbound HTTPS to your Monad RPC and to Hermes;
- one inbound HTTPS port for the app (`/health`, `/orders`, `/hermes/…`).

It holds no state worth keeping. On restart it rebuilds everything from chain logs: it backfills orders over 2 × `maxExecDelay`.

What it does and what it refuses to do is in [`keeper/README.md`](README.md#production-monad-mainnet). Procedures (deploy, pause, key rotation, incidents) are in [`docs/RUNBOOK.md`](../docs/RUNBOOK.md).

## Testnet (what runs today)

The production contracts have been live on **Monad testnet** (chain 10143) since 2026-10-07; nothing is on mainnet yet. The testnet keeper is the same process with the testnet profile:

| | Testnet |
| --- | --- |
| Deployment file | `deployments/10143.json` (`"production": true, "network": "monad-testnet"`, committed) |
| Command | `node keeper/src/keeper.cjs --network testnet --yes-testnet` (from source: `npm run keeper -- --network testnet --yes-testnet`) |
| Env template | `keeper/.env.testnet.example` → the platform's secret store (`KEEPER_SECRETS_FROM_ENV=1`), or `keeper/.env.testnet` (mode 600) when run from source |
| Host | `https://api.paraclr.xyz` (planned; the app at `https://paraclr.xyz` sets `NEXT_PUBLIC_KEEPER_URL=https://api.paraclr.xyz` and `NEXT_PUBLIC_PYTH_HERMES_URL=https://api.paraclr.xyz/hermes`) |
| RPC | a dedicated endpoint; see [RPC tuning](#rpc-tuning) for the public-RPC and QuickNode-free settings |
| Refuses | any chain but 10143, `KEEPER_CORS_ORIGIN=*`, a deployment file without `"production": true`, a missing or rejected `PYTH_API_KEY` |

Everything below applies to both profiles unless it says mainnet; the Docker image, secrets table, health checks and platform notes are the same. The [Monad testnet](#monad-testnet) section at the end covers the trial-end oracle fallback.

## The image

```bash
docker build -f keeper/Dockerfile -t paraclr-keeper .     # context = repo root
```

- **Contents.** One bundled file, `keeper/src/prod/cli.ts` → `keeper.cjs` (viem included), plus the committed `deployments/*.json`. No demo code is in it: no faucet, price pusher, crash or demo takers. No keys or env files are in it either. `.dockerignore` and `keeper/Dockerfile.dockerignore` allowlist only `keeper/src`, the production ABI and `deployments/*.json`.
- **Deployment file.** Build the image **after** the profile's deployment file is committed: `deployments/10143.json` for testnet (committed), `deployments/143.json` for mainnet. Without it the keeper refuses to start: `no production deployment at deployments/143.json`.
- **Build dependencies.** Only viem and esbuild are installed, at the versions pinned as `ARG`s. This sidesteps a lockfile that npm 10 rejects. Keep the `ARG`s equal to `package-lock.json`.
- **Runtime.** It runs as the unprivileged `node` user and starts with `node keeper/src/keeper.cjs --network mainnet --yes-mainnet`; for testnet override the command with `--network testnet --yes-testnet`. Deploying the container is the confirmation. At startup it still:
  - prints every hot-key balance and the expected MON burn;
  - refuses any chain other than the profile's (143 on mainnet, 10143 on testnet);
  - refuses to start without `PYTH_API_KEY`, or when Hermes answers 401/403.
- **Size.** About 350 MB (`node:22-bookworm-slim`). The bundle itself is about 0.8 MB.

Verified locally:

- `docker build` succeeds with the legacy builder.
- `docker run` against `https://rpc.monad.xyz` with throwaway keys stops at the missing `deployments/143.json`, as intended.

## Secrets

Set `KEEPER_SECRETS_FROM_ENV=1` (the image default). The keeper then reads no file: every variable of `keeper/.env.mainnet.example` comes from the platform's secret store.

| Variable | Secret? | On the keeper host? |
| --- | --- | --- |
| `KEEPER_RPC_URL` | yes (paid RPC URLs embed a key) | yes. Use a dedicated / paid endpoint |
| `OPS_PRIVATE_KEY` | **yes** | yes |
| `KEEPER_PRIVATE_KEYS` (8) | **yes** | yes |
| `PYTH_API_KEY` | **yes** | yes (required) |
| `ALERT_WEBHOOK_URL` | yes (the URL is the credential) | yes |
| `KEEPER_CORS_ORIGIN` | no | yes, your app origin(s). Never `*` (refused on both production profiles, testnet and mainnet) |
| `GUARDIAN_PRIVATE_KEY` | **yes** | **no**. Keep it on a separate machine (laptop / hardware-backed). Only needed here with `AUTO_PAUSE_ON_INSOLVENCY=1` |
| `DEPLOYER_PRIVATE_KEY` | **yes** | **no**. Powerless after deploy. The keeper warns if it finds it |
| `OWNER_MULTISIG_ADDRESS` | no (an address) | optional |
| thresholds / tuning (`ALERT_*`, `FUNDING_*`, `CLAIM_*`, …) | no | optional |

The keeper never logs keys, RPC URL paths/queries or the webhook URL.

## HTTPS, CORS and the app

- **Port and TLS.** The platform terminates TLS. The keeper listens on `KEEPER_PORT`, falling back to `$PORT` and then 8787, on 0.0.0.0.
- **App settings.** Set two variables in the app:
  - `NEXT_PUBLIC_KEEPER_URL=https://<keeper host>`;
  - `NEXT_PUBLIC_PYTH_HERMES_URL=https://<keeper host>/hermes`.

  The second one routes the app's Hermes calls through the keeper, so the Pyth API key never ships to browsers.
- **Hermes proxy limits.** The proxy:
  - serves only this deployment's feed ids;
  - caches `latest` for 1 s;
  - rate-limits 5 req/s per IP, with bursts of 20;
  - answers `/v2/updates/price/latest` and `/v2/updates/price/{t}`;
  - returns 404 for `…/stream`, so the app falls back to polling.
- **CORS.** `KEEPER_CORS_ORIGIN=https://app.example,https://www.app.example`. Requests from other origins get no `Access-Control-Allow-Origin` header.
- **Demo endpoints.** `/faucet`, `/crash`, `/recover`, `/price-loop`, `/demo-takers` and `/runs` answer **403** in production.

## Health checks and restart policy

| Endpoint | Use | Healthy when |
| --- | --- | --- |
| `GET /livez` | platform liveness / restart check | the head poller saw a new block in the last 60 s (else 503) |
| `GET /health` | humans, dashboards, the app | always 200. Read `paused`, `solvency`, `oracle.hermes`, `hotKeys[].low`, `alerts.active`, `executor`, `funding`, `sweeper` |

- **Restart policy.** Always restart, with backoff. A crash loses nothing: the process rebuilds its state from the chain.
- **Single instance.** One replica, and no overlapping deploys (see each platform below). During an overlap, two processes send from the same keys.
- **Graceful stop.** On SIGTERM the keeper stops polling, lets in-flight receipts settle for up to 5 s, sends a `keeper:stop` alert and exits. Give it a 10 s grace period.
- **Liveness only.** Do **not** use `/health` as a liveness check. A Hermes outage or a paused contract is not fixed by restarting, and the alerts already page you.

## Railway

1. New service from the repo, Dockerfile builder.
   - Set `RAILWAY_DOCKERFILE_PATH=keeper/Dockerfile`.
   - Root directory: the repo root.
2. Variables: the secrets above, plus `KEEPER_SECRETS_FROM_ENV=1`. Railway injects `PORT`.
3. Settings:
   - Networking → generate a domain (HTTPS);
   - Healthcheck path `/livez`;
   - Restart policy "Always";
   - **Replicas 1**.
4. Set `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS=0` and draining time ≥ 10 s, so the old container stops before the new one starts sending.

## Fly.io

```toml
# fly.toml (keep it outside the image; fly deploy --dockerfile keeper/Dockerfile)
app = "paraclr-keeper"
primary_region = "iad"            # close to your RPC provider

[build]
  dockerfile = "keeper/Dockerfile"

[deploy]
  strategy = "immediate"          # stop the old machine first: never two keepers at once

[env]
  KEEPER_SECRETS_FROM_ENV = "1"
  KEEPER_PORT = "8787"

[http_service]
  internal_port = 8787
  force_https = true
  auto_stop_machines = "off"       # the keeper must run continuously
  auto_start_machines = false
  min_machines_running = 1
  [[http_service.checks]]
    grace_period = "90s"
    interval = "30s"
    method = "GET"
    path = "/livez"
    timeout = "5s"

[[restart]]
  policy = "always"
```

- **Secrets.** `fly secrets set OPS_PRIVATE_KEY=… KEEPER_PRIVATE_KEYS=… PYTH_API_KEY=… KEEPER_RPC_URL=… ALERT_WEBHOOK_URL=… KEEPER_CORS_ORIGIN=…`
  - Run it from your machine, and type values in, or pipe them from `keeper/.env.mainnet`.
  - Never paste them into chat or a ticket.
- **Scale.** `fly scale count 1`.

## Render

- **Service type.** A **Background Worker** has no inbound port, so the app couldn't reach `/health` or `/hermes`. Use a **Web Service** with Docker:
  - Dockerfile path `keeper/Dockerfile`;
  - Docker context `.`.
- **Health check path** `/livez`. Instance count **1**.
- **Deploys.** Render deploys with zero downtime, so the old and new instances overlap briefly (seconds). That overlap is harmless: a duplicate execution reverts with `OrderNotPending`, and the nonce conflicts resync themselves. If you want none at all, suspend the service, deploy, then resume.
- **Secrets.** Environment → Secret Files are not needed. Add each variable as an environment variable and set `KEEPER_SECRETS_FROM_ENV=1`.

## Any VM (systemd)

```ini
# /etc/systemd/system/paraclr-keeper.service
[Service]
EnvironmentFile=/etc/paraclr/keeper.env     # mode 600, owned by the service user
Environment=KEEPER_SECRETS_FROM_ENV=1
ExecStart=/usr/bin/docker run --rm --name paraclr-keeper --env-file /etc/paraclr/keeper.env -p 127.0.0.1:8787:8787 paraclr-keeper
ExecStop=/usr/bin/docker stop -t 10 paraclr-keeper
Restart=always
RestartSec=5
```

Put Caddy or nginx in front of it for TLS (`reverse_proxy 127.0.0.1:8787`).

## RPC choice

- **Public RPC limits.** The public `https://rpc.monad.xyz`:
  - limits `eth_getLogs` to 100 blocks, which the keeper respects (`KEEPER_LOG_RANGE=100`);
  - rate-limits calls.
- **Use a paid endpoint.** A dedicated or paid endpoint is strongly recommended. Steady-state load:
  - one `eth_getBlockByNumber` per head poll (200 ms);
  - per sweep (≥ 1 s), one `eth_simulateV1` per lane plus a few reads;
  - log scans, plus receipts for the keeper's own txs.
- **Required methods.** The keeper needs `eth_simulateV1` (Monad supports it) and state overrides. It does **not** need `debug_*`: there is no X-ray on mainnet.

### RPC tuning

| Variable | Default | What it does | Set it when |
| --- | --- | --- | --- |
| `KEEPER_LOG_RANGE` | 100 | Blocks per `eth_getLogs` query for the order executor's scans and startup backfill | The provider's window is smaller than 100 blocks: QuickNode's free Discover plan allows 5, so set `4` there. The public Monad RPCs allow 100 |
| `KEEPER_RPC_BATCH_SIZE` | 50 | Max calls per JSON-RPC batch request (a tick's reads, receipts and sends go out as one batch) | The public RPC (`testnet-rpc.monad.xyz` / `rpc.monad.xyz`): every call in a batch counts against its per-second cap (15/s per IP on testnet), so set `10`. A dedicated endpoint can use 50 |
| `KEEPER_RPC_BATCH` | on | JSON-RPC batching at all | `0` for a provider that rejects batch requests |
| `KEEPER_MULTICALL` | on | Same-tick contract reads go out as one Multicall3 call | `0` on a bare anvil (no Multicall3 deployed) or a provider where the aggregate call misbehaves; forks of Monad keep it on |

Rate-limited calls (`-32007`, "request limit reached") are retried with backoff on both profiles; the settings above keep the keeper under the cap in the first place.

## Monad testnet

The same image runs the testnet keeper: override the command with `node keeper/src/keeper.cjs --network testnet --yes-testnet`, build it **after** `deployments/10143.json` (`"production": true, "network": "monad-testnet"`) is committed, and pass the variables of `keeper/.env.testnet.example` as secrets (`KEEPER_SECRETS_FROM_ENV=1`). After the Pyth trial, add `PRICE_SIGNER_PRIVATE_KEY` (and `KEEPER_SIGNED_PYTH_ADDRESS` until the deployment file records `fallbackOracle`); see `docs/RUNBOOK.md` §14.6. The signer writes a small state file (`SIGNER_STATE_FILE`, default `keeper/.signer-state-<chain>-<oracle>.json`): on an ephemeral filesystem a restart makes orders whose `execAfter` fell into the restart gap expire (users cancel them), which is the safe outcome.

