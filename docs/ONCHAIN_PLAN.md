# Paraclr on-chain plan (Metropolis, submissions close 2026-10-13)

Goal: Onchain Finance & Trading track + Grand Champion. Judges must see the
clearinghouse **running on Monad** with **measured** numbers, not a simulation.

This file is the interface contract between the parallel build agents.
Change it only through the coordinator.

## Chain modes

`NEXT_PUBLIC_CHAIN_MODE`:

| value   | meaning                                                                 |
|---------|-------------------------------------------------------------------------|
| `sim`   | (default) today's fully in-browser simulation, no chain                 |
| `anvil` | local anvil (chain id 31337, http://127.0.0.1:8545) — dev & CI          |
| `monad` | Monad testnet (chain id 10143)                                          |

Every on-chain UI number must say where it was measured: "Monad testnet" vs
"local anvil (not Monad)". Never label anvil numbers as Monad numbers.

## Contracts (owned by the chain agent)

Existing API is in `contracts/README.md`. Additions:

- `MockOracle`: an `updater` allowlist (`setUpdater(address,bool)`, owner only) so
  the price pusher and the crash operator can use separate keys / nonces.
  `setPrice`/`setPrices`/`shockPrice` allowed for owner or updaters.
- `ParaclrClearinghouseDemo is ParaclrClearinghouse` (demo-only, clearly
  documented as such): `seedAccounts(SeedParams[] calldata)` onlyOwner — creates
  synthetic cross-margin accounts (given addresses → their natural lane) with
  collateral + one or more positions at the current mark, pulling the AUSD from
  the owner so the solvency invariant holds. Used to put ~500 accounts on chain
  for the flash-crash run without 500 funded EOAs. Deploy script deploys the Demo
  variant.
- Generated ABIs live in `src/lib/chain/abi/*.ts` (`npm run abi`). Never hand-edit.
- Deployed addresses are written by the deploy flow to
  `deployments/<chainId>.json`:
  `{ chainId, clearinghouse, ausd, oracle, deployBlock, markets: { "MON/AUSD": "0x…id", … } }`
  and the frontend imports that JSON (falls back to `NEXT_PUBLIC_*_ADDRESS` env).

## Keeper service (owned by the chain agent) — `keeper/`

Long-running Node process (`npm run keeper`), the only holder of operator keys.
Reads `keeper/.env` (never committed): `KEEPER_RPC_URL`, `OPERATOR_PRIVATE_KEY`
(owner of oracle/clearinghouse), `PRICE_PUSHER_PRIVATE_KEY`,
`KEEPER_PRIVATE_KEYS` (comma-separated, 8 keys — one per lane),
`FAUCET_PRIVATE_KEY`, `KEEPER_PORT` (default 8787), `KEEPER_CORS_ORIGIN`.
On anvil it defaults to anvil's well-known dev keys so `npm run dev:chain` works
with zero config.

Responsibilities:
1. **Price loop**: GBM simulator (reuse the math in `src/lib/prices/simulated.ts`
   semantics) pushes MON/SOL/BTC to `MockOracle.setPrices` every
   `PRICE_PUSH_MS` (default 1000). The on-chain oracle is the single source of
   price truth in chain modes.
2. **HTTP API** (JSON, CORS for the app origin):
   - `GET  /health` → `{ chainId, mode, block, addresses, prices, crashed }`
   - `POST /faucet { address }` → `{ gasTxHash, ausdTxHash }` — sends a little
     native gas (`FAUCET_GAS_WEI`) + mints 10,000 AUSD. Rate limit per address.
   - `POST /crash { bps?: 8000 }` → `{ runId }` — starts a flash-crash run.
   - `GET  /runs/:runId` → `RunReport` (below); poll until `status === "done"`.
   - `POST /recover` → restores prices to pre-crash levels; `{ txHash }`.
3. **Crash run** (the measured benchmark):
   - shock all markets in one oracle tx (record submit/confirm times + block);
   - discover liquidatable accounts per lane (`getLiquidatableAccounts`);
   - submit one `liquidateBatch(lane, accounts)` per lane **concurrently from 8
     different keeper EOAs** (split a lane into several txs only if it exceeds a
     per-tx gas cap; gas limits from `estimateGas` + margin — note Monad bills the
     gas *limit*, so keep limits tight);
   - wait for receipts, decode `Liquidated` / `LaneSettled` logs.
4. **Bench CLI**: `npm run bench -- --accounts 500` seeds accounts via
   `seedAccounts`, runs a crash, prints the RunReport and writes it to
   `bench/results/<chainId>-<timestamp>.json` (these JSONs are evidence for the
   write-up — commit them).

```ts
interface RunReport {
  runId: string;
  status: "running" | "done" | "failed";
  error?: string;
  chainId: number;
  network: "anvil" | "monad-testnet";
  shock: TxTiming & { bps: number };
  batches: Array<TxTiming & {
    lane: number; keeper: `0x${string}`; accounts: number; liquidated: number;
    gasUsed: string; gasLimit: string;
  }>;
  liquidations: Array<{
    lane: number; account: `0x${string}`; equity: string; badDebt: string;
    txHash: `0x${string}`; logIndex: number;
  }>;
  totals: {
    accountsScanned: number; liquidated: number; badDebt: string; // AUSD 6dp, decimal string
    wallClockMs: number;      // first batch submitted → last batch receipt
    blocks: number[];         // distinct blocks the batches landed in
    sameBlock: boolean;
    totalGasUsed: string;
  };
}
interface TxTiming {
  txHash: `0x${string}`; block: number | null;
  submittedAt: number; confirmedAt: number | null; // ms epoch, measured by keeper
}
```

## Frontend (owned by the frontend agent)

In `anvil`/`monad` modes:
- **Prices**: `OraclePriceSource` reads `MockOracle.getPrice` for all markets each
  block (or watches `PriceUpdated`), source `"oracle"`; candles built from that.
- **Wallets**: passkey → Privy embedded wallet (EIP-1193 → viem walletClient);
  demo → burner key generated in the browser (localStorage), clearly labelled.
  On first sign-in call keeper `/faucet`.
- **Trading**: swipe → (approve + deposit if needed) → `openPosition`; close →
  `closePosition`. Pending/confirmed states with explorer links. Positions,
  collateral and equity are read from chain (`getAccount`, `getPosition`,
  `accountHealth`), refreshed on new blocks / events.
- **Clearing screen "Live" mode**: lane stats from `getLane(0..7)` /
  `laneAccountCount`; "Flash crash on Monad" → keeper `/crash`, poll
  `/runs/:id`, replay the real liquidation events lane by lane using measured
  timings; result card shows measured wall-clock, block number(s), same-block
  flag, gas, tx links. The simulation stays available as a clearly-labelled
  "Simulated" toggle.
- Copy fix everywhere: "8 conflict-free lanes", not "Monad threads 1–8" —
  contracts cannot choose Monad's execution threads.

## Not in scope this sprint
Chainlink CRE workflow bounty, real Agora AUSD, funding rates, LP vault.
