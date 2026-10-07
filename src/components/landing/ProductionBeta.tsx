import Link from "next/link";
import type { ComponentType, ReactNode } from "react";
import type { ProdParams, ProductionStatus } from "./production.server";
import { MONADSCAN, PRODUCTION_FILE } from "./production.server";
import { ArrowRight, ArrowUpRight, Check, Clock, Coin, Cross, Gauge, Lanes, Percent, Pulse } from "./icons";
import { GITHUB_BLOB, GITHUB_TREE } from "./content";
import { AUDIT_STATUS, BETA_LABEL, RISK_ANCHORS, RISK_PATH, TERMS_PATH } from "./disclosures";
import { fmtDuration, fmtInt, fmtNum, fmtSmall, shortHash } from "./format";
import b from "./brand/Brand.module.css";
import s from "./Beta.module.css";

const SET_AT_LAUNCH = "set at launch";

/* ---- Announcement bar (top of the page, above the nav) ------------------ */

/** `testnetDeployed`: deployments/10143.json exists (the demo stack is on Monad testnet). */
export function StatusBar({ status, testnetDeployed }: { status: ProductionStatus; testnetDeployed: boolean }) {
  return (
    <div className={`${b.dark} ${s.bar}`} role="note" aria-label="Deployment status">
      <div className={`${b.container} ${s.barInner}`}>
        {status.live ? (
          <>
            <span className={s.barPill}>
              <span className={`${b.dot} ${b.dotPos}`} aria-hidden="true" />
              Live on Monad mainnet
            </span>
            <span className={s.barNote}>Unaudited beta · capped. Use only what you can afford to lose.</span>
            <span className={s.barLinks}>
              <a href="#beta">Contracts &amp; limits</a>
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
              <a href="#beta">
                What has to pass <ArrowRight className={s.barIcon} />
              </a>
            </span>
          </>
        )}
      </div>
    </div>
  );
}

/* ---- Launch gate -------------------------------------------------------- */

const GATE: { title: string; body: string }[] = [
  {
    title: "Full test suite",
    body: "Unit, fuzz and invariant tests over the whole production contract set, including oracle edge cases, order timing, funding, caps, pause and timelock-only admin.",
  },
  { title: "Slither", body: "Every high and medium finding fixed, or justified in writing." },
  {
    title: "Adversarial internal review",
    body: "A review that tries to break the contracts. Every critical finding fixed.",
  },
  {
    title: "Mainnet-fork rehearsal",
    body: "A full deploy and run on an anvil fork of Monad mainnet, against the real AUSD and Pyth contracts.",
  },
  {
    title: "Beta caps set",
    body: "Leverage, deposit, TVL and open-interest caps at the beta values before anyone can deposit.",
  },
];

function LaunchGate({ status }: { status: ProductionStatus }) {
  return (
    <div className={`${b.card} ${s.gate}`}>
      <div className={s.cardHead}>
        <p className={s.kicker}>Launch gate</p>
        <span className={`${b.chip} ${status.live ? b.chipPos : b.chipWarn}`}>
          <span className={`${b.dot} ${status.live ? b.dotPos : b.dotWarn}`} aria-hidden="true" />
          {status.live ? "deployed" : "pending"}
        </span>
      </div>
      <h3 className={s.cardTitle}>All five, or no mainnet.</h3>
      <ol className={s.gateList}>
        {GATE.map((g, i) => (
          <li key={g.title}>
            <span className={s.gateNum} aria-hidden="true">
              {i + 1}
            </span>
            <span>
              <b>{g.title}.</b> {g.body}
            </span>
          </li>
        ))}
      </ol>
      <p className={s.fine}>
        {status.live ? (
          <>
            Mainnet deploys only after all five pass. Check the test, Slither and review evidence in{" "}
            <a className={b.link} href={GITHUB_TREE} target="_blank" rel="noreferrer">
              the repo
            </a>{" "}
            before you deposit.
          </>
        ) : (
          <>
            If any check fails, the hackathon submission stays on testnet with no real value, and production waits for
            an external audit. The plan is in{" "}
            <a className={b.link} href={`${GITHUB_BLOB}/docs/PRODUCTION_PLAN.md`} target="_blank" rel="noreferrer">
              docs/PRODUCTION_PLAN.md
            </a>
            .
          </>
        )}
      </p>
    </div>
  );
}

/* ---- Contracts ---------------------------------------------------------- */

function Contracts({ status }: { status: ProductionStatus }) {
  if (!status.live) {
    return (
      <div className={`${b.card} ${s.contracts}`}>
        <div className={s.cardHead}>
          <p className={s.kicker}>Mainnet contracts · chain 143</p>
        </div>
        <h3 className={s.cardTitle}>None yet.</h3>
        <p className={s.cardBody}>
          This table fills itself from <code className={b.code}>{PRODUCTION_FILE}</code> once the production deploy
          commits it, with a Monadscan link for every address. Until then, Paraclr has no contracts on Monad mainnet:
          anything on mainnet that claims to be Paraclr isn&rsquo;t ours.
        </p>
        <ul className={s.ghostRows} aria-hidden="true">
          {["Clearinghouse", "Timelock", "Owner multisig", "Guardian", "AUSD (Agora)", "Pyth"].map((n) => (
            <li key={n}>
              <span>{n}</span>
              <i />
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div className={`${b.card} ${s.contracts}`}>
      <div className={s.cardHead}>
        <p className={s.kicker}>Mainnet contracts · chain 143</p>
        <span className={`${b.chip} ${b.chipPos}`}>
          <span className={`${b.dot} ${b.dotPos}`} aria-hidden="true" />
          live
        </span>
      </div>
      <h3 className={s.cardTitle}>Check every address.</h3>
      <div
        className={`${b.scrollX} ${s.tableWrap}`}
        tabIndex={0}
        role="region"
        aria-label="Monad mainnet contract addresses"
      >
        <table className={s.table}>
          <thead>
            <tr>
              <th scope="col">Contract / role</th>
              <th scope="col">Address</th>
            </tr>
          </thead>
          <tbody>
            {status.contracts.map((c) => (
              <tr key={`${c.key}-${c.address}`}>
                <td>
                  <span className={s.cName}>
                    {c.name}
                    {c.external ? <span className={s.extTag}>external</span> : null}
                  </span>
                  {c.role ? <span className={s.cRole}>{c.role}</span> : null}
                </td>
                <td>
                  <a
                    className={s.addr}
                    href={`${MONADSCAN}/address/${c.address}`}
                    target="_blank"
                    rel="noreferrer"
                    title={c.address}
                  >
                    {shortHash(c.address, 6, 4)}
                    <ArrowUpRight className={s.addrIcon} />
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={s.fine}>
        From <code className={b.code}>{PRODUCTION_FILE}</code>
        {status.deployBlock !== null ? <> · deploy block #{fmtInt(status.deployBlock)}</> : null}
        {status.markets.length ? <> · markets {status.markets.join(", ")}</> : null}. Links open monadscan.com.
      </p>
    </div>
  );
}

/* ---- Limits ------------------------------------------------------------- */

function limitTiles(p: ProdParams): { k: string; v: string | null; sub: string }[] {
  const ausd = (n: number | null) => (n === null ? null : `${fmtNum(n)} AUSD`);
  const delay =
    p.minExecDelaySeconds !== null && p.maxExecDelaySeconds !== null
      ? `${fmtDuration(p.minExecDelaySeconds)} – ${fmtDuration(p.maxExecDelaySeconds)}`
      : p.minExecDelaySeconds !== null
        ? `≥ ${fmtDuration(p.minExecDelaySeconds)}`
        : null;
  const oracle =
    p.maxPriceAgeSeconds !== null || p.maxConfBps !== null
      ? [
          p.maxPriceAgeSeconds !== null ? fmtDuration(p.maxPriceAgeSeconds) : null,
          p.maxConfBps !== null ? `${fmtNum(p.maxConfBps)} bps` : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : null;
  return [
    { k: "Max leverage", v: p.maxLeverage === null ? null : `${fmtNum(p.maxLeverage)}x`, sub: "per position" },
    { k: "Deposit cap", v: ausd(p.depositCapPerAccount), sub: "per account" },
    { k: "TVL cap", v: ausd(p.tvlCapPerLane), sub: "per lane (8 lanes)" },
    { k: "Open-interest cap", v: ausd(p.oiCapPerLaneMarket), sub: "per lane and market" },
    { k: "Min position", v: ausd(p.minPositionSize), sub: "notional" },
    {
      k: "Trading fee",
      v: p.tradingFeeBps === null ? null : `${fmtNum(p.tradingFeeBps)} bps`,
      sub: "of notional → lane insurance",
    },
    {
      k: "Execution fee",
      v: p.executionFee === null ? null : `${fmtSmall(p.executionFee)} MON`,
      sub: "per order → its executor",
    },
    { k: "Order delay", v: delay, sub: "min wait → cancel window" },
    {
      k: "Oracle bounds",
      v: oracle,
      sub:
        p.maxPriceAgeSeconds !== null && p.maxConfBps !== null
          ? "max price age · max confidence"
          : p.maxPriceAgeSeconds !== null
            ? "max price age"
            : p.maxConfBps !== null
              ? "max confidence"
              : "Pyth price age · confidence",
    },
    {
      k: "Timelock delay",
      v: p.timelockDelaySeconds === null ? null : fmtDuration(p.timelockDelaySeconds),
      sub: "before any change applies",
    },
  ];
}

function Limits({ status }: { status: ProductionStatus }) {
  return (
    <div className={s.block}>
      <div className={s.blockHead}>
        <h3 className={s.blockTitle}>Beta limits</h3>
        <p className={s.blockSub}>
          {status.live
            ? `Read from ${PRODUCTION_FILE} when this page was built. They change only through the timelock, so the app's on-chain values win if they differ.`
            : `Set by the deploy script at launch and changeable afterwards only through the timelock. Each value appears here from ${PRODUCTION_FILE}.`}
        </p>
      </div>
      <dl className={s.limitGrid}>
        {limitTiles(status.params).map((t) => (
          <div key={t.k} className={s.limit}>
            <dt>{t.k}</dt>
            <dd className={t.v === null ? s.limitPending : s.limitValue}>{t.v ?? SET_AT_LAUNCH}</dd>
            <dd className={s.limitSub}>{t.sub}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/* ---- What changes for real money --------------------------------------- */

function DelayTimeline({ p }: { p: ProdParams }) {
  const min = p.minExecDelaySeconds !== null ? fmtDuration(p.minExecDelaySeconds) : "min delay";
  const max = p.maxExecDelaySeconds !== null ? fmtDuration(p.maxExecDelaySeconds) : "max delay";
  return (
    <ol className={s.timeline} aria-label="Delayed order timeline">
      <li>
        <b>commit</b>
        <span>size, margin, worst price</span>
      </li>
      <li className={s.tlFill}>
        <b>+{min}</b>
        <span>fills at the first Pyth price published from here</span>
      </li>
      <li>
        <b>+{max}</b>
        <span>not filled? cancel, margin back</span>
      </li>
    </ol>
  );
}

interface Feature {
  icon: ComponentType<{ className?: string }>;
  tag: string;
  title: string;
  body: ReactNode;
  extra?: ReactNode;
}

function features(status: ProductionStatus): Feature[] {
  return [
    {
      icon: Coin,
      tag: "collateral",
      title: "Real AUSD collateral",
      body: (
        <>
          Margin, PnL, fees and backstop deposits are Agora&rsquo;s AUSD on Monad mainnet, fixed as an immutable token
          address at deploy. No mint, no faucet. AUSD is issued by Agora, not by Paraclr, so its{" "}
          <Link className={b.link} href={`${RISK_PATH}#${RISK_ANCHORS.stablecoin}`}>
            stablecoin risk
          </Link>{" "}
          is yours too.
        </>
      ),
    },
    {
      icon: Pulse,
      tag: "prices",
      title: "Pyth prices, verified on chain",
      body: (
        <>
          Fills, liquidations and withdrawals carry a signed Pyth update that the contract verifies through Pyth&rsquo;s
          on-chain contract. It rejects a price that is stale, not positive, or whose confidence interval is too wide a
          share of the price, and refunds unused update fees.
        </>
      ),
    },
    {
      icon: Clock,
      tag: "orders",
      title: "Delayed orders",
      body: (
        <>
          You commit a size, margin and the worst price you&rsquo;ll accept. The order fills at the first Pyth price
          published after the minimum delay, so neither you nor the executor can choose its price. That stops trading a
          stale on-chain price against a newer one. It narrows MEV; it doesn&rsquo;t remove it.
        </>
      ),
      extra: <DelayTimeline p={status.params} />,
    },
    {
      icon: Percent,
      tag: "fees · funding",
      title: "Fees and funding",
      body: (
        <>
          A trading fee in bps of notional goes to the lane&rsquo;s insurance fund; an execution fee in MON pays whoever
          executes the order. Funding follows the global long/short skew across all 8 lanes, accrued into an index that
          a rate-limited update writes and settled when a position is touched.
        </>
      ),
    },
    {
      icon: Gauge,
      tag: "caps",
      title: "Hard caps",
      body: (
        <>
          Max leverage, a deposit cap per account, a TVL cap per lane, an open-interest cap per lane and market sized
          against that lane&rsquo;s insurance and backstop, and a minimum position. Reducing and closing aren&rsquo;t
          capped.
        </>
      ),
    },
    {
      icon: Lanes,
      tag: "liquidation",
      title: "The same fair liquidations",
      body: (
        <>
          The per-block auctions, per-lane backstop pools and solvency ledgers on this page carry over unchanged, priced
          with verified Pyth prices instead of a simulated feed. Every per-trade write stays lane-local.
        </>
      ),
    },
  ];
}

/* ---- Who can do what ---------------------------------------------------- */

function Powers({ status }: { status: ProductionStatus }) {
  const delay =
    status.params.timelockDelaySeconds !== null
      ? fmtDuration(status.params.timelockDelaySeconds)
      : "its delay (set at launch)";
  const rows: { role: string; who: string; can: string[]; cannot: string[] }[] = [
    {
      role: "Owner",
      who: "multisig → timelock",
      can: [
        "Change parameters, caps, fees, the oracle configuration and roles",
        "Unpause",
        `Every change is scheduled on chain and waits ${delay} before it applies`,
      ],
      cannot: ["Change anything instantly", "Skip the timelock delay"],
    },
    {
      role: "Guardian",
      who: "one key, pause only",
      can: ["Pause: blocks deposits and new increase orders"],
      cannot: [
        "Unpause or change parameters",
        "Stop withdrawals, reduce or close orders, or liquidations: those keep working while paused",
      ],
    },
    {
      role: "Keepers",
      who: "8 lane keys + ops key",
      can: [
        "Execute committed orders and run auctions with Pyth updates, earning execution fees",
        "Update funding (ops), at most once per interval",
      ],
      cannot: ["Choose the fill price: it's the first update after the delay", "Change parameters or pause"],
    },
    {
      role: "Anyone",
      who: "no special key",
      can: [
        "Execute pending orders and start auctions, by supplying a Pyth update",
        "Take an auction from an account in the same lane",
      ],
      cannot: ["Change an order's terms or fill it beyond its worst price"],
    },
    {
      role: "Deployer",
      who: "after deploy",
      can: ["Nothing: ownership moves to the timelock and deployer powers are renounced"],
      cannot: [],
    },
  ];
  return (
    <div className={s.block}>
      <div className={s.blockHead}>
        <h3 className={s.blockTitle}>Who can do what</h3>
        <p className={s.blockSub}>
          The admin design from the production plan. The deployed code is the final word; read it before you deposit.
        </p>
      </div>
      <div className={`${b.card} ${s.powers}`} role="table" aria-label="Roles and their powers">
        <div className={s.powerHeadRow} role="row">
          <span role="columnheader">Role</span>
          <span role="columnheader">Can</span>
          <span role="columnheader">Cannot</span>
        </div>
        {rows.map((r) => (
          <div key={r.role} className={s.power} role="row">
            <div className={s.powerRole} role="rowheader">
              <b>{r.role}</b>
              <span>{r.who}</span>
            </div>
            <ul className={s.powerCan} role="cell" aria-label={`${r.role} can`}>
              {r.can.map((c) => (
                <li key={c}>
                  <Check className={s.powerIcon} />
                  {c}
                </li>
              ))}
            </ul>
            <ul className={s.powerCannot} role="cell" aria-label={`${r.role} cannot`}>
              {r.cannot.length ? (
                r.cannot.map((c) => (
                  <li key={c}>
                    <Cross className={s.powerIcon} />
                    {c}
                  </li>
                ))
              ) : (
                <li className={s.powerNone}>–</li>
              )}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---- Section ------------------------------------------------------------ */

export function ProductionBeta({ status }: { status: ProductionStatus }) {
  return (
    <section id="beta" className={`${b.light} ${b.surface} ${b.section} ${s.section}`} aria-labelledby="beta-title">
      <div className={b.container}>
        <div className={b.sectionHead}>
          <p className={b.eyebrow}>Mainnet beta</p>
          <h2 id="beta-title" className={b.h2}>
            {status.live ? (
              <>
                Live on Monad mainnet, <em>capped and unaudited.</em>
              </>
            ) : (
              <>
                Real money comes last, <em>behind a launch gate.</em>
              </>
            )}
          </h2>
          <p className={b.lede}>
            The measured runs on this page come from a demo stack: a test token, a simulated price feed and seeded
            accounts. The production contracts are a separate set with <strong>real Agora AUSD</strong>,{" "}
            <strong>Pyth prices verified on chain</strong>, delayed orders, fees, funding and hard caps, owned by a
            timelock and a multisig.{" "}
            {status.live
              ? "They are deployed on Monad mainnet as a small, capped beta."
              : "They go to Monad mainnet only if every check in the launch gate passes."}
          </p>
        </div>

        <div className={s.topGrid}>
          <LaunchGate status={status} />
          <Contracts status={status} />
        </div>

        <Limits status={status} />

        <div className={s.block}>
          <div className={s.blockHead}>
            <h3 className={s.blockTitle}>What changes for real money</h3>
          </div>
          <ul className={s.features}>
            {features(status).map(({ icon: Icon, tag, title, body, extra }) => (
              <li key={title} className={`${b.card} ${b.cardPad} ${s.feature}`}>
                <div className={s.featureHead}>
                  <span className={b.iconTile}>
                    <Icon />
                  </span>
                  <span className={s.featureTag}>{tag}</span>
                </div>
                <h4 className={b.h3}>{title}</h4>
                <p className={s.featureBody}>{body}</p>
                {extra}
              </li>
            ))}
          </ul>
        </div>

        <Powers status={status} />

        <div className={s.audit}>
          <div className={s.auditCopy}>
            <p className={s.kicker}>Audit status</p>
            <p className={s.auditTitle}>{AUDIT_STATUS}.</p>
            <p className={s.auditSub}>
              {BETA_LABEL}. Smart-contract, oracle, liquidation, funding, keeper, stablecoin and regulatory risks are
              written out in plain language on the risk page.
            </p>
          </div>
          <div className={s.auditActions}>
            <Link href={RISK_PATH} className={`${b.btn} ${b.btnPrimary}`}>
              Read the risks
              <ArrowRight className={`${b.btnIcon} ${b.btnIconMove}`} />
            </Link>
            <Link href={TERMS_PATH} className={`${b.btn} ${b.btnQuiet}`}>
              Terms (draft)
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
