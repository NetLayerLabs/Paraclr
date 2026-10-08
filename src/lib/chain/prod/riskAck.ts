"use client";

// Risk acknowledgement (production): required once per wallet per chain before
// the first deposit - trading collateral, auto-deposit on order submit, or a
// backstop deposit. Kept in localStorage; bump RISK_ACK_VERSION to re-ask
// everyone (e.g. after the terms change).
//
// `requireRiskAck()` opens the modal (rendered by <RiskAckModal/>) and resolves
// when the user accepts, or rejects with a readable error when they don't.

import { useSyncExternalStore } from "react";
import { NETWORK } from "../config";
import { ChainActionError } from "../errors";

export const RISK_ACK_VERSION = "2026-10-beta-1";

const key = (address: string) => `paraclr.riskAck.${RISK_ACK_VERSION}.${NETWORK?.chainId ?? 0}.${address.toLowerCase()}`;

/** In-memory fallback when localStorage is blocked (acknowledged for this page load only). */
const memory = new Set<string>();

export function hasRiskAck(address: string | null | undefined): boolean {
  if (!address) return false;
  const k = key(address);
  if (memory.has(k)) return true;
  try {
    return window.localStorage.getItem(k) !== null;
  } catch {
    return false;
  }
}

function recordAck(address: string) {
  const k = key(address);
  memory.add(k);
  try {
    window.localStorage.setItem(k, JSON.stringify({ at: new Date().toISOString(), version: RISK_ACK_VERSION }));
  } catch {
    /* storage blocked: memory only */
  }
  emit();
}

// ---- modal state --------------------------------------------------------------

interface Pending {
  address: string;
  resolve: () => void;
  reject: (e: Error) => void;
}

let pending: Pending | null = null;
let open: { address: string } | null = null;
let version = 0;
const listeners = new Set<() => void>();

function emit() {
  version++;
  listeners.forEach((l) => l());
}

/** Resolves at once if this wallet already acknowledged; otherwise opens the modal. */
export function requireRiskAck(address: string): Promise<void> {
  if (hasRiskAck(address)) return Promise.resolve();
  if (pending) pending.reject(new ChainActionError("Superseded by a new request."));
  return new Promise<void>((resolve, reject) => {
    pending = { address, resolve, reject };
    open = { address };
    emit();
  });
}

/** Open the modal just to read/accept it (e.g. from the wallet screen). */
export function showRiskAck(address: string) {
  open = { address };
  emit();
}

export function acceptRiskAck() {
  if (!open) return;
  recordAck(open.address);
  const p = pending;
  pending = null;
  open = null;
  emit();
  p?.resolve();
}

export function dismissRiskAck() {
  const p = pending;
  pending = null;
  open = null;
  emit();
  p?.reject(new ChainActionError("Deposit cancelled: please read and accept the beta risk notice first."));
}

export function useRiskAckModal(): { open: boolean; address: string | null } {
  const v = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
    () => 0,
  );
  void v;
  return { open: open !== null, address: open?.address ?? null };
}

/** Re-render when an acknowledgement is recorded. */
export function useRiskAcked(address: string | null | undefined): boolean {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
    () => 0,
  );
  return hasRiskAck(address);
}
