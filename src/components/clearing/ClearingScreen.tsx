"use client";

// Clearing screen.
//   sim mode:    the in-browser simulation only (instant-liquidation model,
//                clearly labelled) + the latest recorded Conflict X-ray.
//   chain modes: "Live" (auction lifecycle from chain events, keeper-run flash
//                crash with measured metrics and its Conflict X-ray) and a
//                clearly-labelled "Simulated" toggle. Both stay mounted so a
//                run survives switching views or tabs.

import { useState } from "react";
import { useParaclr } from "@/lib/store";
import { CHAIN_MODE_ON, NETWORK, PRODUCTION_MODE } from "@/lib/chain/config";
import type { RecordedXray } from "@/lib/chain/xray.server";
import { NetworkTag } from "@/components/chain/ChainUi";
import { LiveClearing } from "./LiveClearing";
import { SimulatedClearing } from "./SimulatedClearing";
import { XrayPanel } from "./XrayPanel";
import styles from "./ClearingScreen.module.css";

type View = "live" | "sim";

export function ClearingScreen({
  active = true,
  recordedXray = null,
}: {
  active?: boolean;
  recordedXray?: RecordedXray | null;
}) {
  const status = useParaclr((s) => s.chain.status);
  const production = useParaclr((s) => s.chain.status === "ready" && !!s.chain.contracts?.production);
  const [viewChoice, setView] = useState<View>("live");
  // Production: real auctions only - no simulated crash view next to real money.
  const view: View = production || PRODUCTION_MODE ? "live" : viewChoice;
  const chainLive = status === "ready";
  const showLive = CHAIN_MODE_ON && view === "live";

  return (
    <div className={styles.screen}>
      <header className={styles.head}>
        <div>
          <h1 className={styles.title}>Clearinghouse</h1>
          <p className={styles.subtitle}>
            {production
              ? "Real auctions as they occur · per-lane backstops · live solvency proof"
              : CHAIN_MODE_ON
              ? "Auction-priced liquidations · per-lane backstops · live solvency proof"
              : "In-browser simulation of the lane-sharded clearing engine · auctions run on chain"}
          </p>
        </div>
        {showLive ? (
          <NetworkTag />
        ) : (
          <span className={styles.badge}>
            <i /> SIMULATED
          </span>
        )}
      </header>

      {CHAIN_MODE_ON && NETWORK && !production && !PRODUCTION_MODE && (
        <div className={styles.modeToggle} role="tablist" aria-label="Clearing mode">
          <button
            role="tab"
            aria-selected={view === "live"}
            className={view === "live" ? styles.modeBtnOn : styles.modeBtn}
            data-live=""
            onClick={() => setView("live")}
          >
            Live · {NETWORK.mode === "anvil" ? "local anvil" : NETWORK.shortLabel}
          </button>
          <button
            role="tab"
            aria-selected={view === "sim"}
            className={view === "sim" ? styles.modeBtnOn : styles.modeBtn}
            onClick={() => setView("sim")}
          >
            Simulated
          </button>
        </div>
      )}

      {CHAIN_MODE_ON && (
        <div className={styles.view} hidden={view !== "live"}>
          <LiveClearing
            active={active && view === "live"}
            onUseSimulated={() => setView("sim")}
            recordedXray={recordedXray}
          />
        </div>
      )}
      <div className={styles.view} hidden={CHAIN_MODE_ON && view !== "sim"}>
        {!production && !PRODUCTION_MODE && <SimulatedClearing isolated={chainLive} />}
        {!CHAIN_MODE_ON && recordedXray && (
          <XrayPanel
            xray={recordedXray.report}
            source={{ kind: "file", file: recordedXray.file, savedAt: recordedXray.savedAt }}
          />
        )}
      </div>
    </div>
  );
}
