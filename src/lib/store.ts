"use client";

// Tiny global store shared by every screen. Feature modules read it with
// `useParaclr(selector)` and mutate it only through the exported actions.

import { useSyncExternalStore } from "react";
import { MARKETS, type MarketSymbol, type Position, type PriceTick, type Session, type Side } from "./types";
import { CHAIN_MODE, type ChainMode } from "./chain/config";
import type { ChainAccountSnapshot } from "./chain/account";
import type { LiveContracts } from "./chain/runtime";
import type { KeeperHealth } from "./chain/keeper";
import type { ProdState } from "./chain/prod/state";

// ---- chain-mode state (NEXT_PUBLIC_CHAIN_MODE = anvil | monad) ---------------

/**
 * off          sim mode, no chain at all (default)
 * connecting   chain mode requested; probing deployment + RPC
 * ready        on-chain trading/clearing live
 * unavailable  chain mode requested but unusable → app runs the simulation
 */
export type ChainStatus = "off" | "connecting" | "ready" | "unavailable";

export interface ChainWalletState {
  kind: "privy" | "burner" | null;
  address: string | null;
  /** A signer is registered and can send transactions. */
  ready: boolean;
  error: string | null;
  /** Burner only: whether the key is persisted in localStorage. */
  persisted: boolean;
}

export interface FaucetState {
  status: "idle" | "checking" | "requesting" | "funded" | "skipped" | "failed";
  message: string | null;
  gasTxHash: string | null;
  ausdTxHash: string | null;
}

export interface KeeperState {
  status: "unknown" | "online" | "offline";
  error: string | null;
  health: KeeperHealth | null;
  checkedAt: number;
}

export interface ChainState {
  mode: ChainMode;
  status: ChainStatus;
  /** Why the chain mode is unavailable (shown inline; app falls back to sim). */
  reason: string | null;
  contracts: LiveContracts | null;
  block: number | null;
  /** Latest RPC read error after connecting (null when healthy). */
  rpcError: string | null;
  wallet: ChainWalletState;
  account: ChainAccountSnapshot | null;
  accountError: string | null;
  faucet: FaucetState;
  keeper: KeeperState;
  /**
   * Production deployments only (`"production": true`): pause flag, fees,
   * order timing, caps + utilisation, funding. Null otherwise.
   */
  prod: ProdState | null;
}

const initialWallet: ChainWalletState = { kind: null, address: null, ready: false, error: null, persisted: false };
const initialFaucet: FaucetState = { status: "idle", message: null, gasTxHash: null, ausdTxHash: null };

const initialChain: ChainState = {
  mode: CHAIN_MODE,
  status: CHAIN_MODE === "sim" ? "off" : "connecting",
  reason: null,
  contracts: null,
  block: null,
  rpcError: null,
  wallet: initialWallet,
  account: null,
  accountError: null,
  faucet: initialFaucet,
  keeper: { status: "unknown", error: null, health: null, checkedAt: 0 },
  prod: null,
};

export interface ParaclrState {
  session: Session | null;
  prices: Record<MarketSymbol, PriceTick | null>;
  selectedMarket: MarketSymbol;
  ausdBalance: number; // free AUSD collateral of the signed-in user
  positions: Position[];
  /** Multiplier the price feed applies to every tick (1 = normal, 0.8 = -20% flash crash). Sim only. */
  priceShock: number;
  /** Chain-mode state; `status === "off"` in sim mode. */
  chain: ChainState;
}

const initialState: ParaclrState = {
  session: null,
  prices: { "MON/AUSD": null, "SOL/AUSD": null, "BTC/AUSD": null },
  selectedMarket: "MON/AUSD",
  ausdBalance: 10_000,
  positions: [],
  priceShock: 1,
  chain: initialChain,
};

let state = initialState;
const listeners = new Set<() => void>();

function setState(next: Partial<ParaclrState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

export function getState(): ParaclrState {
  return state;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useParaclr<T>(selector: (s: ParaclrState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(initialState),
  );
}

// ---- actions ---------------------------------------------------------------

export function signIn(session: Session) {
  setState({ session });
}

export function signOut() {
  // Reset account state so the next session starts clean.
  setState({
    session: null,
    ausdBalance: initialState.ausdBalance,
    positions: [],
    chain: {
      ...state.chain,
      wallet: initialWallet,
      account: null,
      accountError: null,
      faucet: initialFaucet,
    },
  });
}

/** Demo-mode faucet: credits test AUSD to free collateral. */
export function faucet(amount: number) {
  if (amount > 0) setState({ ausdBalance: state.ausdBalance + amount });
}

export function selectMarket(symbol: MarketSymbol) {
  setState({ selectedMarket: symbol });
}

export function pushPrice(tick: PriceTick) {
  setState({ prices: { ...state.prices, [tick.symbol]: tick } });
}

/** Flash-crash hook: the price feed multiplies every tick by this factor. */
export function setPriceShock(factor: number) {
  setState({ priceShock: factor });
}

export function openPosition(args: {
  symbol: MarketSymbol;
  side: Side;
  margin: number;
  leverage: number;
}): Position | null {
  const tick = state.prices[args.symbol];
  if (!tick || args.margin <= 0 || args.margin > state.ausdBalance) return null;
  const position: Position = {
    id: `pos_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    owner: state.session?.address ?? "demo",
    symbol: args.symbol,
    side: args.side,
    size: (args.margin * args.leverage) / tick.price,
    entryPrice: tick.price,
    margin: args.margin,
    leverage: args.leverage,
    openedAt: Date.now(),
  };
  setState({
    positions: [...state.positions, position],
    ausdBalance: state.ausdBalance - args.margin,
  });
  return position;
}

export function closePosition(id: string) {
  const p = state.positions.find((x) => x.id === id);
  if (!p) return;
  const mark = state.prices[p.symbol]?.price ?? p.entryPrice;
  const payout = Math.max(0, p.margin + unrealizedPnl(p, mark));
  setState({
    positions: state.positions.filter((x) => x.id !== id),
    ausdBalance: state.ausdBalance + payout,
  });
}

/** Clearinghouse liquidation: positions are seized, remaining margin is not returned. */
export function liquidatePositions(ids: string[]) {
  const seized = new Set(ids);
  setState({ positions: state.positions.filter((p) => !seized.has(p.id)) });
}

// ---- chain-mode actions ------------------------------------------------------

/** True when trades/clearing go to the chain (status "ready"). */
export function isChainLive(s: ParaclrState = state): boolean {
  return s.chain.status === "ready";
}

export function setChain(patch: Partial<ChainState>) {
  setState({ chain: { ...state.chain, ...patch } });
}

export function setChainWallet(patch: Partial<ChainWalletState>) {
  setState({ chain: { ...state.chain, wallet: { ...state.chain.wallet, ...patch } } });
}

export function setFaucet(patch: Partial<FaucetState>) {
  setState({ chain: { ...state.chain, faucet: { ...state.chain.faucet, ...patch } } });
}

export function setKeeper(patch: Partial<KeeperState>) {
  setState({ chain: { ...state.chain, keeper: { ...state.chain.keeper, ...patch } } });
}

/**
 * Apply an on-chain account read. In chain mode the chain is the source of
 * truth: `positions` and `ausdBalance` (free collateral) mirror it so every
 * screen that reads them keeps working.
 */
export function applyChainAccount(snapshot: ChainAccountSnapshot) {
  if (!state.session || state.session.address.toLowerCase() !== snapshot.address.toLowerCase()) return;
  setState({
    chain: { ...state.chain, account: snapshot, accountError: null },
    positions: snapshot.positions,
    ausdBalance: snapshot.freeCollateral ?? 0,
  });
}

export function setChainAccountError(message: string | null) {
  setState({ chain: { ...state.chain, accountError: message } });
}

export function setProd(patch: Partial<ProdState> | null) {
  if (patch === null) {
    if (state.chain.prod !== null) setState({ chain: { ...state.chain, prod: null } });
    return;
  }
  const base = state.chain.prod;
  if (!base) return;
  setState({ chain: { ...state.chain, prod: { ...base, ...patch } } });
}

export function initProd(initial: ProdState) {
  setState({ chain: { ...state.chain, prod: initial } });
}

/**
 * Markets the UI offers: the connected deployment's listed markets (a
 * production deployment lists only some, e.g. SOL and BTC on testnet), all of
 * them otherwise.
 */
export function useListedMarkets(): readonly MarketSymbol[] {
  return useParaclr((s) => (s.chain.status === "ready" && s.chain.contracts ? s.chain.contracts.listed : MARKETS));
}

/** True when the connected deployment is the production contract set. */
export function isProduction(s: ParaclrState = state): boolean {
  return s.chain.status === "ready" && !!s.chain.contracts?.production;
}

// ---- pure helpers ----------------------------------------------------------

export function unrealizedPnl(p: Position, mark: number): number {
  const dir = p.side === "long" ? 1 : -1;
  return dir * (mark - p.entryPrice) * p.size;
}

/** Maintenance margin ratio: an account is liquidatable below this. */
export const MAINTENANCE_MARGIN = 0.025; // 20x max leverage ⇒ liq ~2.5% from entry

export function liquidationPrice(p: Position): number {
  // Chain modes attach the cross-margin liq price computed from on-chain state.
  if (p.liquidationPrice !== undefined) return p.liquidationPrice;
  // equity = margin + pnl hits notional * MM
  const dir = p.side === "long" ? 1 : -1;
  const notional = p.size * p.entryPrice;
  return p.entryPrice - (dir * (p.margin - notional * MAINTENANCE_MARGIN)) / p.size;
}
