import Link from "next/link";
import { MONAD_TESTNET_CHAIN_ID, type BenchRun } from "./benchResults.server";
import { ArrowRight, Key } from "./icons";
import { fmtInt, shortHash } from "./format";
import ui from "./Landing.module.css";
import styles from "./Terminal.module.css";

// Illustrative sparkline (a fixed path, not market data).
const SPARK = [
  42, 44, 43, 47, 46, 49, 48, 52, 50, 53, 51, 55, 54, 57, 56, 54, 58, 61, 59, 62, 60, 63, 66, 64, 67, 65, 69, 71, 70, 73,
];

function sparkPath(w: number, h: number): { line: string; area: string } {
  const min = Math.min(...SPARK);
  const max = Math.max(...SPARK);
  const pts = SPARK.map((v, i) => {
    const x = (i / (SPARK.length - 1)) * w;
    const y = h - 6 - ((v - min) / (max - min)) * (h - 14);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return { line: `M${pts.join(" L")}`, area: `M0,${h} L${pts.join(" L")} L${w},${h} Z` };
}

function PricesMock() {
  const { line, area } = sparkPath(320, 96);
  return (
    <div className={styles.mock}>
      <div className={styles.pairs}>
        <span className={styles.pairOn}>
          MON <em className={styles.up}>+0.33%</em>
        </span>
        <span className={styles.pair}>
          SOL <em className={styles.up}>+2.98%</em>
        </span>
        <span className={styles.pair}>
          BTC <em className={styles.down}>−0.52%</em>
        </span>
      </div>
      <div className={styles.priceRow}>
        <span className={styles.price}>0.04013</span>
        <span className={styles.perp}>MON / AUSD · PERP</span>
      </div>
      <svg className={styles.spark} viewBox="0 0 320 96" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#3ddc97" stopOpacity="0.22" />
            <stop offset="1" stopColor="#3ddc97" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#spark-fill)" />
        <path d={line} fill="none" stroke="#3ddc97" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className={styles.oracle}>
        <span className={styles.oracleDot} aria-hidden="true" />
        On-chain oracle · simulated feed
        <span className={styles.oracleAge}>1s</span>
      </div>
    </div>
  );
}

function OrderMock() {
  return (
    <div className={styles.mock}>
      <div className={styles.toggle}>
        <span className={styles.toggleOn}>Long</span>
        <span>Short</span>
      </div>
      <div className={styles.field}>
        <span className={styles.fieldLabel}>Margin</span>
        <span className={styles.fieldValue}>
          250 <span className={styles.ausd}>AUSD</span>
        </span>
      </div>
      <div className={styles.lev}>
        <span className={styles.fieldLabel}>Leverage</span>
        <span className={styles.levValue}>10x</span>
      </div>
      <div className={styles.slider} aria-hidden="true">
        <span className={styles.sliderFill} />
        <span className={styles.sliderThumb} />
      </div>
      <div className={styles.swipe}>
        <span className={styles.swipeThumb} aria-hidden="true">
          <ArrowRight className={styles.swipeIcon} />
        </span>
        <span className={styles.swipeText}>Swipe to Long 10x</span>
      </div>
    </div>
  );
}

function PositionsMock() {
  return (
    <div className={styles.mock}>
      <div className={styles.posHead}>
        <span>Positions</span>
        <span className={styles.posCount}>2</span>
        <span className={styles.posEquity}>Cross margin · AUSD</span>
      </div>
      <div className={styles.pos}>
        <div className={styles.posTop}>
          <span className={styles.sideLong}>LONG 10x</span>
          <span className={styles.posPair}>MON</span>
          <span className={styles.pnlUp}>+12.40</span>
        </div>
        <div className={styles.posGrid}>
          <span>Entry</span>
          <span>Mark</span>
          <span>Liq. price (cross)</span>
          <b>0.04013</b>
          <b>0.04021</b>
          <b className={styles.liq}>0.03318</b>
        </div>
      </div>
      <div className={styles.pos}>
        <div className={styles.posTop}>
          <span className={styles.sideShort}>SHORT 4x</span>
          <span className={styles.posPair}>SOL</span>
          <span className={styles.pnlDown}>−3.10</span>
        </div>
        <div className={styles.posGrid}>
          <span>Entry</span>
          <span>Mark</span>
          <span>Liq. price (cross)</span>
          <b>181.20</b>
          <b>181.90</b>
          <b className={styles.liq}>236.40</b>
        </div>
      </div>
    </div>
  );
}

function ReplayMock({ run }: { run: BenchRun | null }) {
  const monad = run?.chainId === MONAD_TESTNET_CHAIN_ID;
  const perLane = run ? Math.max(1, run.accountsScanned / 8) : 1;
  // Cells per lane ≈ that lane's share of underwater accounts; v2 runs colour by outcome.
  const laneCounts = Array.from({ length: 8 }, (_, k) => {
    const o = run?.underwater?.perLane[k];
    if (o) return o.backstop + o.external + o.cured + o.expired;
    return run?.lanes[k]?.liquidated ?? 0;
  });
  return (
    <div className={styles.mock}>
      <div className={styles.replayHead}>
        <span>Auction replay</span>
        <span className={monad ? styles.replayNetMonad : styles.replayNet}>
          {run ? (monad ? "Monad testnet" : "local anvil · not Monad") : "replay"}
        </span>
      </div>
      <div className={styles.replayLanes} aria-hidden="true">
        {Array.from({ length: 8 }, (_, k) => {
          const n = run ? Math.max(1, Math.round((laneCounts[k] / perLane) * 14)) : 2 + (k % 3);
          return (
            <div key={k} className={styles.replayLane}>
              <span>L{k}</span>
              <span className={styles.replayDots}>
                {Array.from({ length: 14 }, (_, i) => (
                  <i key={i} className={(i * 5 + k * 3) % 14 < n ? styles.dotTaken : undefined} />
                ))}
              </span>
            </div>
          );
        })}
      </div>
      {run ? (
        <div className={monad ? styles.replayCardMonad : styles.replayCard}>
          <span className={styles.replayTag}>
            {monad ? "Measured on Monad testnet" : "Local anvil — not Monad"}
            {run.auctions ? "" : " · pre-auction"}
          </span>
          <span className={styles.replayLine}>
            {run.auctions ? (
              <>
                <b>{fmtInt(run.auctions.started)}</b> auctions · <b>{fmtInt(run.auctions.takenByBackstop)}</b> to backstops
                {run.underwater?.maxBlocks != null ? (
                  <>
                    {" "}
                    · max <b>{fmtInt(run.underwater.maxBlocks)}</b> blocks
                  </>
                ) : null}
              </>
            ) : (
              <>
                <b>{fmtInt(run.liquidated ?? 0)}</b> liquidated · <b>{run.batchCount}</b> txs ·{" "}
                {run.sameBlock && run.blocks.length === 1 ? (
                  <>
                    block <b>#{run.blocks[0]}</b>
                  </>
                ) : (
                  <>
                    <b>{run.blocks.length}</b> blocks
                  </>
                )}
              </>
            )}
          </span>
          <span className={styles.replayTx}>
            {run.lanes.slice(0, 2).map((l) => (
              <span key={l.lane} className={styles.txChip}>
                L{l.lane} {shortHash(l.txHash, 4, 4)}
              </span>
            ))}
            <span className={styles.txMore}>+{Math.max(0, run.lanes.length - 2)}</span>
          </span>
        </div>
      ) : null}
    </div>
  );
}

function PasskeyMock() {
  return (
    <div className={`${styles.mock} ${styles.passkey}`}>
      <span className={styles.passkeyIcon} aria-hidden="true">
        <Key className={styles.passkeyGlyph} />
      </span>
      <span className={styles.passkeyTitle}>Sign in to Paraclr</span>
      <span className={styles.passkeyBtn}>Sign in with passkey</span>
      <span className={styles.passkeyAlt}>Try demo mode (burner wallet)</span>
      <span className={styles.passkeyNote}>No seed phrase · embedded wallet on Monad testnet</span>
    </div>
  );
}

function DevicesMock() {
  return (
    <div className={`${styles.mock} ${styles.devices}`} aria-hidden="true">
      <div className={styles.desktop}>
        <div className={styles.desktopBar}>
          <i />
          <i />
          <i />
        </div>
        <div className={styles.desktopGrid}>
          <span className={styles.skChart}>
            <svg viewBox="0 0 100 40" preserveAspectRatio="none">
              <path d="M0,32 L12,28 L22,30 L34,20 L46,24 L58,14 L70,18 L82,8 L100,12" fill="none" stroke="#3ddc97" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            </svg>
          </span>
          <span className={styles.skOrder}>
            <i />
            <i />
            <i className={styles.skBtn} />
          </span>
          <span className={styles.skTable}>
            <i />
            <i />
          </span>
        </div>
      </div>
      <div className={styles.phone}>
        <span className={styles.phoneNotch} />
        <span className={styles.phoneChart}>
          <svg viewBox="0 0 100 40" preserveAspectRatio="none">
            <path d="M0,30 L15,26 L30,28 L45,18 L60,22 L75,10 L100,14" fill="none" stroke="#3ddc97" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          </svg>
        </span>
        <span className={styles.phoneSwipe} />
        <span className={styles.phoneTabs}>
          <i />
          <i />
          <i />
        </span>
      </div>
    </div>
  );
}

export function Terminal({ replayRun }: { replayRun: BenchRun | null }) {
  const features = [
    {
      title: "Live oracle prices",
      body: "In chain mode the chart reads the on-chain MockOracle every block. The keeper pushes a simulated price feed about once a second. It isn't a real market feed, and the app says so.",
      mock: <PricesMock />,
    },
    {
      title: "One swipe, leveraged, in AUSD",
      body: "Pick MON, SOL or BTC, set margin in AUSD and leverage up to 20x, then swipe to open on a phone or click on desktop. Approve, deposit and openPosition each show pending and confirmed states.",
      mock: <OrderMock />,
    },
    {
      title: "Cross-margin, with a way back",
      body: "One AUSD collateral balance backs every position, with liquidation prices for the whole account at a 2.5% maintenance margin. If your account goes into auction, a banner shows the discount, what you'd keep, and that adding collateral cures it.",
      mock: <PositionsMock />,
    },
    {
      title: "Crash it, watch the auctions",
      body: "Trigger a −20% crash from the clearing screen and watch each lane's auctions start, tick up and resolve, with time underwater, equity returned to traders and tx links. The Conflict X-ray and the solvency badge sit right there too.",
      mock: <ReplayMock run={replayRun} />,
    },
    {
      title: "Passkey sign-in via Privy",
      body: "WebAuthn passkey login with a Privy embedded wallet, no seed phrase. A clearly labelled demo burner wallet (a throwaway testnet key kept in your browser) works too.",
      mock: <PasskeyMock />,
    },
    {
      title: "Desktop and phone",
      body: "A full-viewport terminal: chart, order panel and positions side by side on desktop; bottom tabs and swipe-to-trade on a phone.",
      mock: <DevicesMock />,
    },
  ];

  return (
    <section id="terminal" className={ui.section} aria-labelledby="terminal-title">
      <div className={ui.container}>
        <div className={styles.head}>
          <div className={ui.sectionHead}>
            <p className={ui.eyebrow}>The terminal</p>
            <h2 id="terminal-title" className={ui.h2}>
              Trade it from your phone. <em>Crash it from the clearing screen.</em>
            </h2>
            <p className={ui.lede}>
              The clearinghouse comes with a complete trading terminal: on-chain positions margined in AUSD, a lane view
              of every auction, a backstop tab for LPs, and sign-in that takes one tap.
            </p>
          </div>
          <p className={styles.previewNote}>UI previews, built in HTML. Values are illustrative unless labelled measured.</p>
        </div>

        <div className={styles.grid}>
          {features.map((f) => (
            <article key={f.title} className={`${ui.card} ${styles.feature}`}>
              {f.mock}
              <div className={styles.featureText}>
                <h3 className={ui.h3}>{f.title}</h3>
                <p className={ui.body}>{f.body}</p>
              </div>
            </article>
          ))}
        </div>

        <div className={styles.cta}>
          <Link href="/app" className={`${ui.btn} ${ui.btnPrimary}`}>
            Launch app
            <ArrowRight className={ui.arrow} />
          </Link>
          <span className={styles.ctaNote}>
            <span className={ui.dot} aria-hidden="true" />
            Demo burner wallet available, nothing to install
          </span>
        </div>
      </div>
    </section>
  );
}
