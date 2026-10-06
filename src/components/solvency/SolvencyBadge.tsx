"use client";

// Header solvency badge + detail dialog. Reads `solvency()` and the eight
// `laneLedger(lane)` views every block, straight from the clearinghouse (no
// keeper in the loop). Hidden in sim mode and on deployments that predate the
// solvency proof.

import { useEffect, useRef, useState } from "react";
import { useParaclr } from "@/lib/store";
import { NETWORK } from "@/lib/chain/config";
import { useSolvency } from "@/lib/chain/solvency";
import type { SolvencySnapshot } from "@/lib/chain/fair";
import styles from "./Solvency.module.css";

const full = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function compact(n: number): string {
  const a = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${sign}${(a / 1e3).toFixed(1)}K`;
  return `${sign}${a.toFixed(2)}`;
}

const signed = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "") + full(Math.abs(n));

function ShieldIcon({ ok }: { ok: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden className={styles.icon}>
      <path
        d="M12 3l7.5 3v5.6c0 4.6-3.1 8.4-7.5 9.4-4.4-1-7.5-4.8-7.5-9.4V6L12 3z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {ok ? (
        <path d="M8.6 12.2l2.4 2.4 4.6-4.8" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="M12 8v5M12 16.4v.1" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      )}
    </svg>
  );
}

export function SolvencyBadge() {
  const live = useParaclr((s) => s.chain.status === "ready");
  const { status, snapshot, error } = useSolvency(live);
  const [open, setOpen] = useState(false);

  if (!live || status === "unsupported" || status === "idle") return null;

  const tone = !snapshot ? "pending" : snapshot.solvent ? "ok" : "alert";
  const title = !snapshot
    ? (error ?? "Reading solvency() from the clearinghouse…")
    : `${snapshot.solvent ? "Solvent" : "INSOLVENT"}: the clearinghouse holds ${full(snapshot.ausdHeld)} AUSD against ${full(
        snapshot.liabilities,
      )} AUSD of liabilities. Read from solvency() every block — click for the per-lane ledger.`;

  return (
    <>
      <button
        type="button"
        className={styles.badge}
        data-tone={tone}
        onClick={() => setOpen(true)}
        title={title}
        aria-label={`${!snapshot ? "Solvency loading" : snapshot.solvent ? "Solvent" : "Insolvent"} — open the solvency proof`}
      >
        <ShieldIcon ok={tone !== "alert"} />
        <b>{!snapshot ? "Solvency…" : snapshot.solvent ? "Solvent" : "Insolvent"}</b>
        {snapshot && (
          <span className={`${styles.meta} mono`} data-part="surplus">
            {snapshot.solvent ? "surplus" : "deficit"} {compact(Math.abs(snapshot.surplus))}
          </span>
        )}
      </button>
      {open && <SolvencyDialog snapshot={snapshot} error={error} onClose={() => setOpen(false)} />}
    </>
  );
}

function SolvencyDialog({
  snapshot,
  error,
  onClose,
}: {
  snapshot: SolvencySnapshot | null;
  error: string | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (!d.open) d.showModal();
    const onCancel = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    d.addEventListener("cancel", onCancel);
    return () => d.removeEventListener("cancel", onCancel);
  }, [onClose]);

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby="solvency-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={styles.sheet}>
        <header className={styles.head}>
          <div>
            <h2 id="solvency-title" className={styles.title}>
              Solvency proof
            </h2>
            <p className={styles.sub}>
              <span className="mono">solvency()</span> + <span className="mono">laneLedger(0…7)</span>
              {snapshot?.block != null && (
                <>
                  {" "}
                  at block <span className="mono">#{snapshot.block.toLocaleString("en-US")}</span>
                </>
              )}{" "}
              · re-read every block · {NETWORK?.label ?? "chain"}
            </p>
          </div>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        {!snapshot ? (
          <p className={styles.note}>{error ?? "Reading the clearinghouse…"}</p>
        ) : (
          <SolvencyBody s={snapshot} error={error} />
        )}
      </div>
    </dialog>
  );
}

function SolvencyBody({ s, error }: { s: SolvencySnapshot; error: string | null }) {
  const lanes = s.lanes;
  const sum = lanes
    ? lanes.reduce(
        (a, l) => ({
          collateral: a.collateral + l.collateral,
          insurance: a.insurance + l.insurance,
          backstopCash: a.backstopCash + l.backstopCash,
          keeperRewards: a.keeperRewards + l.keeperRewards,
          badDebt: a.badDebt + l.badDebt,
          net: a.net + l.net,
        }),
        { collateral: 0, insurance: 0, backstopCash: 0, keeperRewards: 0, badDebt: 0, net: 0 },
      )
    : null;
  const matches = sum ? Math.abs(sum.net - s.liabilities) < 0.01 : null;

  return (
    <>
      <div className={styles.verdict} data-tone={s.solvent ? "ok" : "alert"}>
        <ShieldIcon ok={s.solvent} />
        <span>
          <b>{s.solvent ? "Solvent" : "Insolvent"}</b> · {s.solvent ? "surplus" : "deficit"}{" "}
          <span className="mono">{signed(s.surplus)}</span> AUSD
        </span>
      </div>

      <dl className={styles.identity}>
        <div>
          <dt>
            AUSD held by the clearinghouse
            <small className="mono">AUSD.balanceOf(clearinghouse)</small>
          </dt>
          <dd className="mono">{full(s.ausdHeld)}</dd>
        </div>
        <div>
          <dt>
            − Liabilities
            <small>Σ lanes: collateral + insurance + backstop cash + keeper rewards owed − bad debt</small>
          </dt>
          <dd className="mono">{full(s.liabilities)}</dd>
        </div>
        <div className={styles.identityTotal}>
          <dt>= Surplus</dt>
          <dd className="mono" data-tone={s.surplus < 0 ? "alert" : "ok"}>
            {signed(s.surplus)}
          </dd>
        </div>
      </dl>

      {lanes && sum && (
        <>
          <h3 className={styles.h3}>Per-lane ledgers</h3>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Lane</th>
                  <th data-long="">Collateral</th>
                  <th data-short="" title="Collateral">
                    Coll.
                  </th>
                  <th data-long="">Insurance</th>
                  <th data-short="" title="Insurance">
                    Ins.
                  </th>
                  <th title="Backstop pool cash">Backstop</th>
                  <th title="Keeper rewards owed">Keeper</th>
                  <th data-long="">Bad debt</th>
                  <th data-short="" title="Bad debt">
                    Debt
                  </th>
                  <th>Net</th>
                </tr>
              </thead>
              <tbody>
                {lanes.map((l) => (
                  <tr key={l.lane}>
                    <td>{l.lane + 1}</td>
                    <td className="mono">{compact(l.collateral)}</td>
                    <td className="mono">{compact(l.insurance)}</td>
                    <td className="mono">{compact(l.backstopCash)}</td>
                    <td className="mono">{compact(l.keeperRewards)}</td>
                    <td className="mono" data-tone={l.badDebt > 0 ? "warn" : undefined}>
                      {l.badDebt > 0 ? `−${compact(l.badDebt)}` : "0.00"}
                    </td>
                    <td className="mono">{compact(l.net)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Σ</td>
                  <td className="mono">{compact(sum.collateral)}</td>
                  <td className="mono">{compact(sum.insurance)}</td>
                  <td className="mono">{compact(sum.backstopCash)}</td>
                  <td className="mono">{compact(sum.keeperRewards)}</td>
                  <td className="mono">{sum.badDebt > 0 ? `−${compact(sum.badDebt)}` : "0.00"}</td>
                  <td className="mono">{compact(sum.net)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className={styles.check} data-tone={matches ? "ok" : "warn"}>
            {matches
              ? `Σ lane nets = ${full(sum.net)} AUSD = the liabilities solvency() reports.`
              : `Σ lane nets = ${full(sum.net)} AUSD, solvency() reports ${full(s.liabilities)} AUSD of liabilities — see the contract docs for the exact terms.`}
          </p>
        </>
      )}

      {error && <p className={styles.note}>Last refresh failed: {error} (showing the previous read).</p>}
      <p className={styles.note}>
        Each lane keeps its own ledger in lane-local storage, so keeping this proof current never makes two lanes
        write the same slot. The identity is checked by Foundry invariant tests; this badge re-reads it from the
        contract every block.
      </p>
    </>
  );
}
