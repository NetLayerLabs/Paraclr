import type { RepoFacts } from "./benchResults.server";
import { fmtInt } from "./format";
import b from "./brand/Brand.module.css";
import s from "./BuiltOn.module.css";

type Tone = "accent" | "pos" | "warn" | "neutral";

interface Item {
  name: string;
  body: string;
  chip: string;
  tone: Tone;
}

/** Text wordmarks only (no third-party logos). Chips say what each one is used for, and where. */
function items(repo: RepoFacts, live: boolean, testnet: boolean, testnetLive: boolean): Item[] {
  return [
    {
      name: "Monad",
      body: "The chain Paraclr is built for. 8 lanes of disjoint storage give its optimistic parallel executor no reason to re-execute one lane's work because of another's.",
      chip: live
        ? "Mainnet beta · chain 143"
        : testnetLive
          ? "Live on testnet · mainnet pending"
          : testnet
            ? "Testnet demo · mainnet pending"
            : "Mainnet beta pending",
      tone: live || testnetLive ? "pos" : "warn",
    },
    {
      name: "Pyth",
      body: testnetLive
        ? "Pull-oracle prices for the production contracts, verified on chain: staleness, confidence and a positive price. Used on Monad testnet now, during a Pyth data trial. The measured demo runs use a simulated feed."
        : "Pull-oracle prices for the production contracts, verified on chain: staleness, confidence and a positive price. The demo uses a simulated feed.",
      chip: live ? "Used for prices" : testnetLive ? "Prices · testnet, data trial" : "Prices · beta contracts",
      tone: "accent",
    },
    {
      name: "Agora AUSD",
      body: testnetLive
        ? "The single quote and margin asset. Agora's testnet AUSD on Monad testnet (test funds, no value), real AUSD on the mainnet beta; the measured demo runs use MockAUSD, a 6-decimal stand-in."
        : "The single quote and margin asset. Real AUSD on the mainnet beta; the demo uses MockAUSD, a 6-decimal stand-in with no value.",
      chip: testnetLive ? "Collateral · testnet AUSD now" : "Collateral (mainnet beta)",
      tone: "accent",
    },
    {
      name: "Privy",
      body: "Passkey (WebAuthn) login and an embedded wallet in the app, through the public SDK.",
      chip: "Login + wallet",
      tone: "neutral",
    },
    {
      name: "Safe",
      body: "The owner multisig behind the timelock, if Safe is available on Monad mainnet; otherwise a hardware-wallet key.",
      chip: "Owner multisig · planned",
      tone: "warn",
    },
    {
      name: "OpenZeppelin",
      body: "TimelockController owns the production contracts, so every parameter change waits out its delay. ERC-20 and math utilities.",
      chip: "Timelock + token utils",
      tone: "neutral",
    },
    {
      name: "Foundry",
      body: [
        repo.foundryTests ? `${fmtInt(repo.foundryTests)} tests including fuzzing` : "Tests including fuzzing",
        repo.invariantTests ? `${fmtInt(repo.invariantTests)} invariant tests` : null,
        "storage-access checks. anvil runs the local demo chain.",
      ]
        .filter(Boolean)
        .join(", "),
      chip: "Tests · demo chain",
      tone: "neutral",
    },
    {
      name: "viem",
      body: "Chain reads and user transactions in the app; the keeper's signing, receipts and the storage traces behind the X-ray.",
      chip: "App + keeper client",
      tone: "neutral",
    },
    {
      name: "Slither",
      body: "Static analysis on the production contracts, part of the launch gate.",
      chip: "Static analysis · not an audit",
      tone: "warn",
    },
    {
      name: "Next.js",
      body: "This site and the trading app: App Router with CSS Modules. No charting or UI kit.",
      chip: "Site + app",
      tone: "neutral",
    },
  ];
}

const TONE: Record<Tone, string> = {
  accent: b.chipAccent,
  pos: b.chipPos,
  warn: b.chipWarn,
  neutral: "",
};

function Card({ item }: { item: Item }) {
  return (
    <li className={s.card}>
      <span className={s.name}>{item.name}</span>
      <p className={s.body}>{item.body}</p>
      <span className={`${b.chip} ${TONE[item.tone]} ${s.chip}`}>{item.chip}</span>
    </li>
  );
}

export function BuiltOn({
  repo,
  live,
  testnet,
  testnetLive = false,
}: {
  repo: RepoFacts;
  live: boolean;
  testnet: boolean;
  testnetLive?: boolean;
}) {
  const list = items(repo, live, testnet, testnetLive);
  return (
    <section className={`${b.dark} ${b.surface} ${b.section} ${s.section}`} aria-labelledby="built-title">
      <div className={b.container}>
        <div className={`${b.sectionHead} ${b.sectionHeadCenter}`}>
          <p className={b.eyebrow}>Built on</p>
          <h2 id="built-title" className={b.h2}>
            Public infrastructure, <em>used as published.</em>
          </h2>
          <p className={b.lede}>
            Paraclr is contracts, a keeper and an app on top of these tools. Each card says what it&rsquo;s used for,
            and whether that&rsquo;s the beta, the demo or both.
          </p>
        </div>
      </div>

      <div className={s.marquee}>
        <ul className={s.track} aria-label="Infrastructure Paraclr uses">
          {list.map((item) => (
            <Card key={item.name} item={item} />
          ))}
        </ul>
        <ul className={`${s.track} ${s.clone}`} aria-hidden="true">
          {list.map((item) => (
            <Card key={item.name} item={item} />
          ))}
        </ul>
      </div>

      <p className={`${b.container} ${s.disclaimer}`}>
        Built for the Monad Metropolis hackathon. Not affiliated with or endorsed by Monad, Agora, Pyth, Privy, Safe or
        OpenZeppelin.
      </p>
    </section>
  );
}
