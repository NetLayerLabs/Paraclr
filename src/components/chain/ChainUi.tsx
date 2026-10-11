"use client";

// Small shared chain-mode UI: status strip, network tag, inline notice,
// transaction link and the transaction tray.

import { LaneAlert, LaneCheck } from "@/components/brand/Glyph";
import type { ReactNode } from "react";
import { useParaclr } from "@/lib/store";
import { CHAIN_MODE_ON, NETWORK, txUrl } from "@/lib/chain/config";
import { clearTxs, useTxs, type TrackedTx } from "@/lib/chain/txs";
import { shortHash } from "@/lib/chain/units";
import { retryChainConnect } from "./ChainProvider";
import styles from "./Chain.module.css";

/** data-net for styling: real Monad chains share the Monad tone; anything local is "anvil". */
function netAttr(): "monad" | "anvil" {
  return NETWORK && NETWORK.isMonad ? "monad" : "anvil";
}

/** "Monad testnet" / "Local anvil - not Monad" / "Simulated" tag. */
export function NetworkTag({ simulated = false }: { simulated?: boolean }) {
  if (simulated || !NETWORK) {
    return (
      <span className={styles.netTag} data-net="sim">
        Simulated
      </span>
    );
  }
  return (
    <span className={styles.netTag} data-net={netAttr()} title={`Chain ${NETWORK.chainId}`}>
      {NETWORK.mode === "anvil" ? "Local anvil · not Monad" : NETWORK.shortLabel}
    </span>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "warn" | "error" | "ok"; children: ReactNode }) {
  return (
    <div className={styles.notice} data-tone={tone} role={tone === "error" ? "alert" : undefined}>
      <div>{children}</div>
    </div>
  );
}

/** Explorer link on Monad; plain short hash on anvil (no explorer). */
export function TxLink({ hash, label }: { hash: string | null | undefined; label?: string }) {
  if (!hash || hash === "0x") return <span className="mono">-</span>;
  const url = txUrl(hash);
  const text = label ?? shortHash(hash);
  return url ? (
    <a className="mono" href={url} target="_blank" rel="noreferrer" title={hash}>
      {text} ↗
    </a>
  ) : (
    <span className="mono" title={`${hash} (local anvil, no explorer)`}>
      {text}
    </span>
  );
}

/**
 * Header pill: where this app's numbers come from. "Monad testnet" /
 * "Local anvil - not Monad" with the live block, "Simulation" in sim mode or
 * after a chain-mode fallback.
 */
export function NetworkPill() {
  const status = useParaclr((s) => s.chain.status);
  const block = useParaclr((s) => s.chain.block);
  const rpcError = useParaclr((s) => s.chain.rpcError);

  if (!CHAIN_MODE_ON || !NETWORK) {
    return (
      <span className={styles.pill} data-net="sim" title="Fully in-browser simulation, no chain">
        <i className={styles.pillDot} />
        <b>Simulation</b>
      </span>
    );
  }

  if (status === "connecting") {
    return (
      <span className={styles.pill} data-net="connecting">
        <i className={styles.pillDot} />
        <b>Connecting…</b>
        <span className={styles.pillMeta}>{NETWORK.mode === "anvil" ? "local anvil" : NETWORK.shortLabel}</span>
      </span>
    );
  }

  if (status === "unavailable") {
    // Production modes never run the simulation behind an unavailable chain.
    if (NETWORK.requiresProduction) {
      return (
        <span className={styles.pill} data-error="" title={`${NETWORK.label} unavailable`}>
          <i className={styles.pillDot} />
          <b>{NETWORK.shortLabel}</b>
          <span className={styles.pillMeta}>unavailable</span>
        </span>
      );
    }
    return (
      <span className={styles.pill} data-net="fallback" title={`${NETWORK.label} unavailable, running the simulation`}>
        <i className={styles.pillDot} />
        <b>Simulation</b>
        <span className={styles.pillMeta}>chain unavailable</span>
      </span>
    );
  }

  return (
    <span
      className={styles.pill}
      data-net={netAttr()}
      data-error={rpcError ? "" : undefined}
      title={rpcError ? `${NETWORK.label}: ${rpcError}` : `${NETWORK.label} · chain ${NETWORK.chainId} · latest block`}
    >
      <i className={styles.pillDot} />
      {NETWORK.mode !== "anvil" ? (
        <b>{NETWORK.shortLabel}</b>
      ) : (
        <>
          <b data-part="net-full">Local anvil, not Monad</b>
          <b data-part="net-short">Anvil · not Monad</b>
        </>
      )}
      <span className={`${styles.pillMeta} mono`} data-part="block">
        {block !== null ? `#${block.toLocaleString("en-US")}` : "…"}
      </span>
    </span>
  );
}

/** Header pill: keeper reachability (chain modes only). */
export function KeeperPill() {
  const status = useParaclr((s) => s.chain.status);
  const keeper = useParaclr((s) => s.chain.keeper.status);
  const error = useParaclr((s) => s.chain.keeper.error);
  const production = useParaclr((s) => !!s.chain.contracts?.production);

  if (!CHAIN_MODE_ON || !NETWORK || status === "unavailable") return null;
  const text = keeper === "online" ? "online" : keeper === "offline" ? "offline" : "…";
  return (
    <span
      className={styles.keeper}
      data-part="keeper"
      data-s={keeper}
      title={
        keeper === "offline"
          ? (error ?? "Keeper unreachable")
          : production
            ? `Keeper (executes delayed orders with Pyth prices, funding updates, auction sweeper) at ${NETWORK.keeperUrl}`
            : `Keeper (prices, faucet, auction sweeper, crash runs) at ${NETWORK.keeperUrl}`
      }
    >
      <i className={styles.pillDot} />
      <span data-part="label">
        Keeper <span className={styles.keeperState}>{text}</span>
      </span>
    </span>
  );
}

/**
 * Slim banner under the header in chain modes, only when something needs
 * attention: chain mode unavailable (running the simulation, with retry) or a
 * failing RPC. The healthy state - network, block, keeper - lives in the
 * header pills. Renders nothing in sim mode.
 */
export function ChainStatusStrip() {
  const status = useParaclr((s) => s.chain.status);
  const reason = useParaclr((s) => s.chain.reason);
  const rpcError = useParaclr((s) => s.chain.rpcError);

  if (!CHAIN_MODE_ON || !NETWORK) return null;

  if (status === "unavailable") {
    return (
      <div className={styles.strip} data-tone="warn" data-expanded="">
        <span className={styles.stripDot} />
        <span className={styles.stripText}>
          <b>On-chain mode unavailable, running the simulation.</b> {reason}
        </span>
        <button className={styles.stripBtn} onClick={retryChainConnect}>
          Retry
        </button>
      </div>
    );
  }

  if (status === "ready" && rpcError) {
    return (
      <div className={styles.strip} data-tone="error">
        <span className={styles.stripDot} />
        <span className={styles.stripText}>
          <b>{NETWORK.label}</b> · {rpcError}
        </span>
      </div>
    );
  }

  return null;
}

const STATUS_TEXT: Record<TrackedTx["status"], string> = {
  simulating: "simulating…",
  signing: "signing…",
  pending: "pending…",
  confirmed: "confirmed",
  failed: "failed",
};

/** Recent transactions with their lifecycle, block and explorer link. */
export function TxTray({ max = 4 }: { max?: number }) {
  const txs = useTxs();
  if (!NETWORK || txs.length === 0) return null;
  const shown = [...txs].reverse().slice(0, max);
  return (
    <section className={styles.tray} aria-live="polite">
      <header className={styles.trayHead}>
        <span>Transactions · {NETWORK.label}</span>
        <button className={styles.trayClear} onClick={clearTxs}>
          Clear
        </button>
      </header>
      <ul className={styles.trayList}>
        {shown.map((t) => (
          <li key={t.id} className={styles.trayRow} data-s={t.status}>
            <span className={styles.trayIcon} data-s={t.status} aria-hidden>
              {t.status === "confirmed" ? <LaneCheck size={11} /> : t.status === "failed" ? <LaneAlert size={11} /> : null}
            </span>
            <span className={styles.trayLabel}>
              {t.label}
              {t.error ? (
                <small>{t.error}</small>
              ) : t.hash ? (
                <small>
                  <TxLink hash={t.hash} />
                </small>
              ) : null}
            </span>
            <span className={styles.trayMeta}>
              {t.status === "confirmed" && t.block !== null ? (
                <>
                  <span className="mono">#{t.block}</span>
                  {t.sentAt && t.confirmedAt ? (
                    <span className="mono" title="Sent → receipt seen, measured in this browser">
                      {" "}
                      · {t.confirmedAt - t.sentAt} ms
                    </span>
                  ) : null}
                </>
              ) : (
                STATUS_TEXT[t.status]
              )}
            </span>
          </li>
        ))}
      </ul>
      <p className={styles.trayFoot}>Confirmation times are measured in this browser (send → receipt seen).</p>
    </section>
  );
}
