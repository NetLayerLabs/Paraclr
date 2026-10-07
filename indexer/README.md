# Paraclr indexer (Envio HyperIndex)

Indexes the production clearinghouse on Monad testnet (chain 10143,
`0xbC1fD0165FBfF4EF32337E42D0e2Ad59bF52b203`, from its deploy block 69,041,758) with
[Envio HyperIndex](https://docs.envio.dev), reading the chain through Envio's HyperSync. The app reads the
GraphQL API for the **order history** on the Trade tab and **activity since deploy** on the Clearing tab.

## What it records

| Entity | One row per | Fields |
| --- | --- | --- |
| `Order` | delayed order | commit, then fill / failure / cancel: fill price, realized PnL, trading fee, notional, seconds to fill, both tx hashes |
| `Auction` | per-block Dutch auction | start equity and notional, outcome (taken / cured / expired), taker, backstop or not, discount, blocks elapsed, payment, equity back to the trader, bad debt |
| `PositionChange` | `PositionUpdated` event | the position after each order, take or reduction |
| `CollateralFlow` | trader deposit / withdrawal | amount, lane, tx |
| `BackstopFlow` | LP deposit, exit request, withdrawal, lane insurance top-up | amount, shares, ready time |
| `Account`, `Lane`, `Market`, `DailyStat`, `Protocol` | running totals | volume, trades, fees, auctions by outcome, equity returned, backstop earnings, insurance, funding rate |
| `GuardianAction` | pause / unpause | who, when |

Units are the contract's: AUSD amounts have 6 decimals, sizes and prices 18, execution fees are MON wei.
Addresses are stored lowercase. Bad debt is counted once, from `BadDebtRealized`.

## Run it locally

Needs Node ≥ 22, pnpm and Docker (Postgres + Hasura run in containers).

```bash
cd indexer
cp .env.example .env          # paste a free token from https://envio.dev/app/api-tokens
pnpm install
pnpm dev                      # GraphQL: http://localhost:8080/v1/graphql (console password: testing)
```

With Colima instead of Docker Desktop, point Envio at its socket first:
`export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock`.

Then run the app with `NEXT_PUBLIC_ENVIO_GRAPHQL_URL=http://localhost:8080/v1/graphql`.

`pnpm test` runs the handler tests on simulated events (no network): an order from commit to fill, an
auction taken by a backstop pool, a cured auction. `pnpm codegen` regenerates types after editing
`config.yaml` or `schema.graphql`.

## Example queries

```graphql
# An account's orders, newest first
{ Order(where: { account_id: { _eq: "0x…lowercase" } }, order_by: { committedBlock: desc }, limit: 20) {
    status sizeDelta fillPrice realizedPnl tradingFee latency resolvedTx market { symbol } } }

# Totals since deploy, per lane, and indexer progress
{ Protocol { accounts ordersExecuted volume auctionsStarted auctionsTaken equityReturned }
  Lane(order_by: { index: asc }) { index accounts volume auctionsTakenByBackstop backstopEarned }
  _meta { progressBlock isReady } }
```

## Hosting

Envio's hosted service runs this directory as is: connect the GitHub repo in the
[Envio dashboard](https://envio.dev/app), set the root to `indexer/`, add `ENVIO_API_TOKEN`, and deploy.
Set the app's `NEXT_PUBLIC_ENVIO_GRAPHQL_URL` to the GraphQL endpoint it gives you.

A new deployment (another address or start block) needs `config.yaml` updated from `deployments/10143.json`.
