import type { RepoFacts } from "./benchResults.server";
import { fmtInt } from "./format";
import ui from "./Landing.module.css";
import styles from "./Closing.module.css";

const stack = (repo: RepoFacts) => [
  { name: "Monad", role: "Target chain: testnet, chain 10143. Every measured run names the chain it ran on." },
  {
    name: "Agora AUSD",
    role: "The single quote and margin asset by design. On testnet it's MockAUSD, a 6-decimal stand-in, not Agora's token.",
  },
  { name: "Privy", role: "Passkey (WebAuthn) login and an embedded wallet, through the public SDK." },
  { name: "viem", role: "Chain reads and user transactions in the app; the keeper's signing, receipts and storage traces." },
  {
    name: "Foundry",
    role: [
      "Solidity 0.8.24 (cancun)",
      repo.foundryTests ? `${fmtInt(repo.foundryTests)} tests including fuzzing` : "tests including fuzzing",
      repo.invariantTests ? `${fmtInt(repo.invariantTests)} invariant tests` : null,
      "storage-access checks, deploy scripts.",
    ]
      .filter(Boolean)
      .join(", "),
  },
  { name: "Next.js", role: "Next.js 16 App Router with CSS Modules. No charting or UI kit." },
];

export function BuiltWith({ repo }: { repo: RepoFacts }) {
  return (
    <section className={`${ui.section} ${ui.sectionTight}`} aria-labelledby="built-title">
      <div className={ui.container}>
        <div className={styles.builtHead}>
          <p className={ui.eyebrow}>Built with</p>
          <h2 id="built-title" className={styles.builtTitle}>
            Public tools, used as published.
          </h2>
        </div>
        <ul className={styles.stack}>
          {stack(repo).map((s) => (
            <li key={s.name} className={styles.stackItem}>
              <span className={styles.stackName}>{s.name}</span>
              <span className={styles.stackRole}>{s.role}</span>
            </li>
          ))}
        </ul>
        <p className={styles.disclaimer}>
          Built for the Monad Metropolis hackathon. Not affiliated with or endorsed by Monad, Agora, Privy or Chainlink.
        </p>
      </div>
    </section>
  );
}
