import type { LandingEvidence } from "./benchResults.server";
import { MONAD_EXPLORER } from "./content";
import { shortHash } from "./format";
import ui from "./Landing.module.css";
import styles from "./Architecture.module.css";

function Addr({ address }: { address: string | null | undefined }) {
  if (!address) return null;
  return (
    <a className={styles.addr} href={`${MONAD_EXPLORER}/address/${address}`} target="_blank" rel="noreferrer">
      {shortHash(address, 4, 4)} ↗
    </a>
  );
}

export function Architecture({ deployment }: { deployment: LandingEvidence["monadDeployment"] }) {
  return (
    <section id="architecture" className={`${ui.section} ${ui.sectionAlt}`} aria-labelledby="arch-title">
      <div className={ui.container}>
        <div className={ui.sectionHead}>
          <p className={ui.eyebrow}>Architecture</p>
          <h2 id="arch-title" className={ui.h2}>
            Three pieces, <em>one source of truth.</em>
          </h2>
          <p className={ui.lede}>
            The contracts hold every position, run every auction and keep the books. The app signs your trades. The
            keeper holds the operator keys: it pushes prices, funds test wallets and runs one sweeper key per lane.
          </p>
        </div>

        <div className={styles.diagram}>
          {/* App */}
          <div className={`${styles.box} ${styles.app}`}>
            <div className={styles.boxHead}>
              <span className={styles.boxKicker}>Client</span>
              <h3 className={styles.boxTitle}>App</h3>
              <span className={styles.boxSub}>Next.js 16 · desktop and phone</span>
            </div>
            <ul className={styles.list}>
              <li>Passkey → Privy embedded wallet, or a labelled demo burner</li>
              <li>Trade: oracle prices, swipe → deposit + openPosition</li>
              <li>Clearing: auctions per lane, Conflict X-ray, labelled Simulated mode</li>
              <li>Backstop tab · solvency badge read every block</li>
              <li>
                <code>viem</code> for reads and your transactions
              </li>
            </ul>
          </div>

          {/* App <-> Keeper */}
          <div className={styles.http}>
            <span className={styles.httpLabel}>HTTP · JSON</span>
            <span className={styles.httpLine} aria-hidden="true" />
            <span className={styles.httpRoutes}>
              <code>POST /faucet</code>
              <code>POST /crash</code>
              <code>GET /runs/:id</code>
              <code>GET /runs/:id/xray</code>
              <code>GET /solvency</code>
              <code>GET /backstop</code>
            </span>
          </div>

          {/* Keeper */}
          <div className={`${styles.box} ${styles.keeper}`}>
            <div className={styles.boxHead}>
              <span className={styles.boxKicker}>Service</span>
              <h3 className={styles.boxTitle}>Keeper</h3>
              <span className={styles.boxSub}>Node · the only holder of operator keys</span>
            </div>
            <ul className={styles.list}>
              <li>Price pusher: simulated feed → MockOracle, ~1s</li>
              <li>Faucet: test gas + 10,000 test AUSD</li>
              <li>Sweeper: every block, each lane&rsquo;s key starts, takes, cures and expires that lane&rsquo;s auctions</li>
              <li>Crash runner: 1 shock tx, then the sweeper; X-ray vs the naive build</li>
              <li>
                Bench CLI → <code>bench/results</code> + <code>bench/xray</code>
              </li>
            </ul>
            <div className={styles.keepers} aria-label="8 lane keeper keys">
              {Array.from({ length: 8 }, (_, k) => (
                <span key={k}>K{k}</span>
              ))}
            </div>
          </div>

          {/* vertical links */}
          <div className={`${styles.vlink} ${styles.vApp}`}>
            <span className={styles.vline} aria-hidden="true" />
            <span className={styles.vlabel}>reads · approve · deposit · openPosition · closePosition</span>
          </div>
          <div className={`${styles.vlink} ${styles.vKeeper}`}>
            <span className={styles.vline} aria-hidden="true" />
            <span className={styles.vlabel}>setPrices · shockPrices · startAuctions · backstopTakeBatch · expireBatch</span>
          </div>

          {/* Chain */}
          <div className={`${styles.box} ${styles.chain}`}>
            <div className={styles.chainHead}>
              <div className={styles.boxHead}>
                <span className={styles.boxKicker}>On-chain</span>
                <h3 className={styles.boxTitle}>Monad testnet contracts</h3>
                <span className={styles.boxSub}>chain 10143 · local anvil (31337) for dev, always labelled not Monad</span>
              </div>
              <span className={deployment ? styles.statusLive : styles.statusNext}>
                {deployment ? "Deployed on Monad testnet" : "Running on local anvil · Monad testnet deploy next"}
              </span>
            </div>

            <div className={styles.contracts}>
              <div className={styles.contract}>
                <code className={styles.contractName}>MockOracle</code>
                <span className={styles.contractSub}>prices the keeper pushes; shockPrices for the crash</span>
                <Addr address={deployment?.oracle} />
              </div>
              <span className={styles.flow} aria-hidden="true">
                <span>getPrice</span>
              </span>
              <div className={`${styles.contract} ${styles.contractMain}`}>
                <code className={styles.contractName}>ParaclrClearinghouse</code>
                <span className={styles.contractSub}>
                  cross-margin perps · up to 20x · per-lane auctions and backstop pools · <code>solvency()</code>
                </span>
                <Addr address={deployment?.clearinghouse} />
                <div className={styles.laneStrip} aria-label="8 lanes, each with its own insurance fund, bad debt and open interest">
                  {Array.from({ length: 8 }, (_, k) => (
                    <span key={k}>
                      <b>L{k}</b>
                    </span>
                  ))}
                </div>
                <span className={styles.laneCaption}>
                  each lane: insurance · bad debt · open interest · backstop pool · auctions · ledger · its accounts
                </span>
              </div>
              <span className={`${styles.flow} ${styles.flowRev}`} aria-hidden="true">
                <span>deposit</span>
              </span>
              <div className={styles.contract}>
                <code className={styles.contractName}>MockAUSD</code>
                <span className={styles.contractSub}>6-decimal testnet stand-in for AUSD</span>
                <Addr address={deployment?.ausd} />
              </div>
            </div>
          </div>
        </div>

        <p className={ui.caption}>
          The deployed clearinghouse is <code className={ui.code}>ParaclrClearinghouseDemo</code>: the production
          contract plus one owner-only <code className={ui.code}>seedAccounts</code> for benchmark accounts; auctions
          run the unchanged production code. <code className={ui.code}>NaiveClearinghouseDemo</code>
          {deployment?.naive ? (
            <>
              {" "}
              (<Addr address={deployment.naive} />)
            </>
          ) : null}{" "}
          is the same code with every per-lane aggregate on one shared key, deployed alongside only as the X-ray
          baseline.
        </p>
      </div>
    </section>
  );
}
