"use client";

import { useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import { faucet, signOut, unrealizedPnl, useParaclr } from "@/lib/store";
import { shortAddress } from "@/lib/auth/demo";
import { MONAD_CHAIN_ID, explorerAddressUrl, monadTestnet } from "@/lib/chain";
import { NETWORK, addressUrl } from "@/lib/chain/config";
import { readableError } from "@/lib/chain/errors";
import { mintTestAusd, refreshAccount, requestFaucet, withdrawFreeCollateral } from "@/lib/chain/trading";
import { Notice, TxLink, TxTray } from "@/components/chain/ChainUi";
import { useAuthContext } from "./AuthContext";
import { PrivySignOutButton } from "./PrivyAuth";
import { ProdWallet } from "@/components/prod/ProdWallet";
import { TokenIcon, TokenSymbol } from "@/components/prod/Token";
import { isPrivyMethod, METHOD_LABEL } from "@/lib/types";
import styles from "./WalletScreen.module.css";

const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtNative = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 4 });

function useCopy(text: string) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked; ignore */
    }
  };
  return { copied, copy };
}

/** Full address where there's room (desktop), shortened on phones. */
function Address({ address }: { address: string }) {
  return (
    <span className={`${styles.addr} mono`} title={address}>
      <span className={styles.addrShort}>{shortAddress(address, 10, 8)}</span>
      <span className={styles.addrFull}>{address}</span>
    </span>
  );
}

export function WalletScreen() {
  const chainLive = useParaclr((s) => s.chain.status === "ready");
  const production = useParaclr((s) => s.chain.status === "ready" && !!s.chain.contracts?.production);
  if (production) return <ProdWallet />;
  return chainLive ? <ChainWallet /> : <SimWallet />;
}

/** Sim mode (and chain-mode fallback): balances live in this browser only. */
function SimWallet() {
  const session = useParaclr((s) => s.session);
  const free = useParaclr((s) => s.ausdBalance);
  const positions = useParaclr((s) => s.positions);
  const prices = useParaclr((s) => s.prices);
  const { privyEnabled } = useAuthContext();
  const { copied, copy } = useCopy(session?.address ?? "");

  if (!session) return null;

  const isPasskey = isPrivyMethod(session.method);
  const margin = positions.reduce((sum, p) => sum + p.margin, 0);
  const pnl = positions.reduce((sum, p) => sum + unrealizedPnl(p, prices[p.symbol]?.price ?? p.entryPrice), 0);
  const equity = free + margin + pnl;
  const freePct = equity > 0 ? Math.max(0, Math.min(100, (free / equity) * 100)) : 100;

  return (
    <div className={`${styles.root} ${styles.rootSim}`}>
      <header className={styles.head}>
        <div>
          <h2 className={styles.title}>Wallet</h2>
          <p className={styles.name}>{session.displayName}</p>
        </div>
        <span className={isPasskey ? styles.badgePasskey : styles.badgeDemo}>
          {METHOD_LABEL[session.method]}
        </span>
      </header>

      <section className={styles.addressCard}>
        <div className={styles.cardTitle}>Account</div>
        <div className={styles.addrRow}>
          <Address address={session.address} />
          <button className={styles.copyBtn} onClick={copy} aria-label="Copy address">
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <div className={styles.chainRow}>
          <span className={styles.chainDot} data-net={isPasskey ? undefined : "sim"} />
          {isPasskey ? (
            <>
              {monadTestnet.name} · <span className="mono">{MONAD_CHAIN_ID}</span>
            </>
          ) : (
            "Simulated account · no chain"
          )}
          {isPasskey && (
            <a className={styles.explorer} href={explorerAddressUrl(session.address)} target="_blank" rel="noreferrer">
              Explorer ↗
            </a>
          )}
        </div>
      </section>

      <section className={styles.balanceCard}>
        <div className={styles.balanceLabel}>
          <TokenIcon /> Total equity · AUSD <span className={styles.simTag}>SIMULATED</span>
        </div>
        <div className={`${styles.equity} mono`}>{fmt(equity)}</div>
        {positions.length > 0 && (
          <div className={`${styles.pnl} mono`} data-sign={pnl >= 0 ? "pos" : "neg"}>
            {pnl >= 0 ? "+" : ""}
            {fmt(pnl)} unrealized
          </div>
        )}

        <div className={styles.bar} aria-hidden="true">
          <span style={{ width: `${freePct}%` }} />
        </div>

        <dl className={styles.split}>
          <div>
            <dt>Free collateral</dt>
            <dd className="mono">{fmt(free)}</dd>
          </div>
          <div>
            <dt>Margin in positions</dt>
            <dd className="mono">{fmt(margin)}</dd>
          </div>
          <div>
            <dt>Open positions</dt>
            <dd className="mono">{positions.length}</dd>
          </div>
        </dl>
      </section>

      <section className={styles.faucet}>
        <div className={styles.cardTitle}>Test funds</div>
        <button className={styles.faucetBtn} onClick={() => faucet(1_000)}>
          Get 1,000 test AUSD
        </button>
        <p className={styles.note}>Credits simulated collateral to this browser session.</p>
      </section>

      <section className={styles.sessionKey}>
        <div>
          <p className={styles.keyTitle}>{isPasskey ? "Privy embedded wallet" : "Demo mode: nothing is signed"}</p>
          <p className={styles.note}>
            {isPasskey
              ? "You're signed in with Privy. In this mode trading is simulated in the browser, so no transactions are sent."
              : "Balances and positions are simulated in this browser. There is no key and no on-chain transaction."}
          </p>
        </div>
      </section>

      {privyEnabled && isPasskey ? (
        <PrivySignOutButton className={styles.signOut} />
      ) : (
        <button className={styles.signOut} onClick={signOut}>
          Sign out
        </button>
      )}
    </div>
  );
}

/** Chain modes: every number below is read from the chain. */
function ChainWallet() {
  const session = useParaclr((s) => s.session);
  const acct = useParaclr((s) => s.chain.account);
  const accountError = useParaclr((s) => s.chain.accountError);
  const wallet = useParaclr((s) => s.chain.wallet);
  const faucetState = useParaclr((s) => s.chain.faucet);
  const keeper = useParaclr((s) => s.chain.keeper);
  const prices = useParaclr((s) => s.prices);
  const { privyEnabled } = useAuthContext();
  const { copied, copy } = useCopy(session?.address ?? "");
  const [busy, setBusy] = useState<null | "faucet" | "mint" | "withdraw">(null);
  const [actionMsg, setActionMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  if (!session || !NETWORK) return null;

  const isPasskey = isPrivyMethod(session.method);
  const explorer = addressUrl(session.address);
  const positions = acct?.positions ?? [];
  const pnl = positions.reduce((sum, p) => sum + unrealizedPnl(p, prices[p.symbol]?.price ?? p.entryPrice), 0);
  const equity = acct?.equity ?? null;
  const free = acct?.freeCollateral ?? null;
  const im = acct?.initialMargin ?? null;
  const freePct = equity && equity > 0 && free !== null ? Math.max(0, Math.min(100, (free / equity) * 100)) : 100;

  const run = async (kind: "faucet" | "mint" | "withdraw") => {
    setBusy(kind);
    setActionMsg(null);
    try {
      if (kind === "faucet") {
        await requestFaucet(session.address as Address, { onlyIfLow: false });
      } else if (kind === "mint") {
        await mintTestAusd(1_000);
        setActionMsg({ tone: "ok", text: "Minted 1,000 test AUSD to your wallet." });
      } else {
        const amount = await withdrawFreeCollateral();
        setActionMsg({ tone: "ok", text: `Withdrew ${fmt(amount)} AUSD to your wallet.` });
      }
    } catch (e) {
      setActionMsg({ tone: "error", text: readableError(e) });
    } finally {
      setBusy(null);
      void refreshAccount();
    }
  };

  return (
    <div className={styles.root}>
      <header className={styles.head}>
        <div>
          <h2 className={styles.title}>Wallet</h2>
          <p className={styles.name}>{session.displayName}</p>
        </div>
        <span className={isPasskey ? styles.badgePasskey : styles.badgeDemo}>
          {isPasskey ? `${METHOD_LABEL[session.method]} · Privy` : "Demo burner wallet"}
        </span>
      </header>

      <section className={styles.addressCard}>
        <div className={styles.cardTitle}>Account</div>
        <div className={styles.addrRow}>
          <Address address={session.address} />
          <button className={styles.copyBtn} onClick={copy} aria-label="Copy address">
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <div className={styles.chainRow}>
          <span className={styles.chainDot} data-net={NETWORK.mode} />
          {NETWORK.mode === "anvil" ? "Local anvil, not Monad" : NETWORK.label} ·{" "}
          <span className="mono">{NETWORK.chainId}</span>
          {acct && <span className="mono"> · L{acct.lane}</span>}
          {explorer && (
            <a className={styles.explorer} href={explorer} target="_blank" rel="noreferrer">
              Explorer ↗
            </a>
          )}
        </div>
      </section>

      {(!wallet.ready || accountError) && (
        <div className={styles.notices}>
          {!wallet.ready && (
            <Notice tone={wallet.error ? "warn" : "info"}>{wallet.error ?? "Connecting your wallet…"}</Notice>
          )}
          {accountError && <Notice tone="warn">Couldn&apos;t read your account: {accountError}</Notice>}
        </div>
      )}

      <section className={styles.balanceCard}>
        <div className={styles.balanceLabel}>
          <TokenIcon /> Equity in clearinghouse · AUSD
          {acct?.block != null && <span className={`${styles.blockTag} mono`}>#{acct.block}</span>}
        </div>
        <div className={`${styles.equity} mono`}>{equity !== null ? fmt(equity) : acct ? "-" : "…"}</div>
        {acct?.healthError && <p className={styles.note}>{acct.healthError}</p>}
        {positions.length > 0 && (
          <div className={`${styles.pnl} mono`} data-sign={pnl >= 0 ? "pos" : "neg"}>
            {pnl >= 0 ? "+" : ""}
            {fmt(pnl)} unrealized
          </div>
        )}

        <div className={styles.bar} aria-hidden="true">
          <span style={{ width: `${freePct}%` }} />
        </div>

        <dl className={styles.split}>
          <div>
            <dt>Free collateral</dt>
            <dd className="mono">{free !== null ? fmt(free) : "-"}</dd>
          </div>
          <div>
            <dt>Initial margin</dt>
            <dd className="mono">{im !== null ? fmt(im) : "-"}</dd>
          </div>
          <div>
            <dt>Open positions</dt>
            <dd className="mono">{positions.length}</dd>
          </div>
        </dl>

        <dl className={`${styles.split} ${styles.splitPlain}`}>
          <div>
            <dt>
              Wallet <TokenSymbol />
            </dt>
            <dd className="mono">{acct ? fmt(acct.walletAusd) : "…"}</dd>
          </div>
          <div>
            <dt>Gas · {NETWORK.nativeSymbol}</dt>
            <dd className="mono" data-low={acct && acct.native < 0.005 ? "" : undefined}>
              {acct ? fmtNative(acct.native) : "…"}
            </dd>
          </div>
          <div>
            <dt>Deposited</dt>
            <dd className="mono">{acct ? fmt(acct.collateral) : "…"}</dd>
          </div>
        </dl>
      </section>

      <section className={styles.faucet}>
        <div className={styles.cardTitle}>Test funds</div>
        <button
          className={styles.faucetBtn}
          disabled={busy !== null || faucetState.status === "requesting" || keeper.status === "offline"}
          onClick={() => run("faucet")}
        >
          {faucetState.status === "requesting" ? "Requesting test funds…" : "Request test gas + 10,000 AUSD"}
        </button>
        <p className={styles.note}>
          From the keeper faucet ({NETWORK.keeperUrl}). It runs automatically after sign-in when your wallet is
          empty.
        </p>
        {faucetState.status === "funded" && (
          <Notice tone="ok">
            {faucetState.message}{" "}
            {faucetState.gasTxHash && (
              <>
                Gas <TxLink hash={faucetState.gasTxHash} />{" "}
              </>
            )}
            {faucetState.ausdTxHash && (
              <>
                AUSD <TxLink hash={faucetState.ausdTxHash} />
              </>
            )}
          </Notice>
        )}
        {faucetState.status === "failed" && <Notice tone="warn">{faucetState.message}</Notice>}
        {keeper.status === "offline" && <Notice tone="warn">{keeper.error ?? "Keeper unreachable."}</Notice>}

        <div className={styles.actionRow}>
          <button
            className={styles.actionBtn}
            disabled={busy !== null || !wallet.ready || !acct || acct.native <= 0}
            onClick={() => run("mint")}
            title="MockAUSD.mint is a public test faucet; needs gas"
          >
            {busy === "mint" ? "Minting…" : "Mint 1,000 AUSD"}
          </button>
          <button
            className={styles.actionBtn}
            disabled={
              busy !== null || !wallet.ready || !acct || !!acct.auction?.active || !(acct.freeCollateral && acct.freeCollateral > 0)
            }
            onClick={() => run("withdraw")}
            title={acct?.auction?.active ? "Frozen while your account is in a liquidation auction" : undefined}
          >
            {busy === "withdraw" ? "Withdrawing…" : acct?.auction?.active ? "Frozen (in auction)" : "Withdraw free collateral"}
          </button>
        </div>
        {actionMsg && <Notice tone={actionMsg.tone}>{actionMsg.text}</Notice>}
      </section>

      <div className={styles.tray}>
        <TxTray />
      </div>

      <section className={styles.sessionKey}>
        <div>
          <p className={styles.keyTitle}>
            {session.method === "wallet" ? "Your wallet, through Privy" : isPasskey ? "Privy embedded wallet" : "Demo burner wallet"}
          </p>
          <p className={styles.note}>
            {session.method === "wallet"
              ? "Your own wallet signs every transaction, and asks you to confirm each one."
              : isPasskey
                ? `Your ${session.method === "passkey" ? "passkey" : `${METHOD_LABEL[session.method]} sign-in`} unlocks a Privy embedded wallet. Its confirmation popups are turned off, so trades are sent as soon as you place them. There are no session keys or scoped permissions.`
              : wallet.persisted
                ? "A throwaway key generated in this browser and stored unencrypted in localStorage. Testnet only: never send real funds to it."
                : "A throwaway key generated in this browser and kept in memory only (storage is blocked), so it's lost on reload. Testnet only."}
          </p>
        </div>
      </section>

      {privyEnabled && isPasskey ? (
        <PrivySignOutButton className={styles.signOut} />
      ) : (
        <button className={styles.signOut} onClick={signOut}>
          Sign out
        </button>
      )}
    </div>
  );
}
