import Link from "next/link";
import type { ProductionStatus } from "./production.server";
import { ArrowRight } from "./icons";
import { README_AT } from "./content";
import { RISK_PATH } from "./disclosures";
import b from "./brand/Brand.module.css";
import s from "./StatusBar.module.css";
import { NoticeClose } from "@/components/prod/NoticeClose";

/* ---- Announcement bar (top of the page, above the nav) ------------------ */

/**
 * `testnetDeployed`: deployments/10143.json is the demo stack on Monad testnet.
 * `testnet`: deployments/10143.json is the production deployment ("production": true).
 */
export function StatusBar({
  status,
  testnet,
  testnetDeployed,
}: {
  status: ProductionStatus;
  testnet: ProductionStatus;
  testnetDeployed: boolean;
}) {
  return (
    <div
      className={`${b.dark} ${s.bar}`}
      role="note"
      aria-label="Deployment status"
      data-notice={!status.live && testnet.live ? "testnet" : undefined}
    >
      <div className={`${b.container} ${s.barInner}`}>
        {!status.live && testnet.live ? (
          <>
            <span className={s.barPill}>
              <span className={`${b.dot} ${b.dotPos}`} aria-hidden="true" />
              Live on Monad testnet
            </span>
            <span className={s.barNote}>
              Production contracts with Agora&rsquo;s testnet AUSD and{" "}
              {testnet.pricesSimulated ? "prices simulated after the Pyth trial" : "Pyth prices"}: test funds, no real
              value. Unaudited. Mainnet beta: launch pending.
            </span>
            <span className={s.barLinks}>
              <a href="#testnet">
                Contracts <ArrowRight className={s.barIcon} />
              </a>
              <Link href={RISK_PATH}>Risks</Link>
              <NoticeClose className={s.barClose} />
            </span>
          </>
        ) : status.live ? (
          <>
            <span className={s.barPill}>
              <span className={`${b.dot} ${b.dotPos}`} aria-hidden="true" />
              Live on Monad mainnet
            </span>
            <span className={s.barNote}>Unaudited beta · capped. Use only what you can afford to lose.</span>
            <span className={s.barLinks}>
              <a href={README_AT.mainnetContracts} target="_blank" rel="noreferrer">
                Contracts &amp; limits
              </a>
              <Link href={RISK_PATH}>Risks</Link>
            </span>
          </>
        ) : (
          <>
            <span className={s.barPill}>
              <span className={`${b.dot} ${b.dotWarn}`} aria-hidden="true" />
              Mainnet beta: pending launch gate
            </span>
            <span className={s.barNote}>
              Today: {testnetDeployed ? "a Monad testnet and local-anvil demo" : "a local-anvil demo"} with test AUSD
              and no real value. No Paraclr contracts on Monad mainnet yet.
            </span>
            <span className={s.barLinks}>
              <a href={README_AT.launchGate} target="_blank" rel="noreferrer">
                What has to pass <ArrowRight className={s.barIcon} />
              </a>
            </span>
          </>
        )}
      </div>
    </div>
  );
}
