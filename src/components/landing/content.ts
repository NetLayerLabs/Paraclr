// Shared landing constants (safe for client components: no server imports).

export const GITHUB_URL = "https://github.com/NetLayerLabs/Paraclr";
export const GITHUB_TREE = `${GITHUB_URL}/tree/main`;
export const GITHUB_BLOB = `${GITHUB_URL}/blob/main`;

// TODO: replace with the project's X / Twitter profile URL once it exists.
export const X_URL = "https://x.com/Paraclr";

export const MONAD_EXPLORER = "https://testnet.monadexplorer.com";

/** In page order. */
export const NAV_LINKS = [
  { href: "#auction", label: "How it works" },
  { href: "#xray", label: "X-ray" },
  { href: "#solvency", label: "Solvency" },
  { href: "#beta", label: "Mainnet beta" },
  { href: "#results", label: "Results" },
  { href: "#faq", label: "FAQ" },
] as const;

/** Auction parameters (contract defaults, owner-configurable). See docs/FAIR_LIQUIDATION_PLAN.md. */
export const AUCTION = {
  stepBps: 25,
  maxBps: 500,
  backstopMinBps: 75,
  maintenanceBps: 250,
} as const;

/**
 * The Monad testnet deployment's auction step (deployments/10143.json `params.auctionStepBps`), set
 * through the timelock on 2026-10-08: at the default 25 bps Monad's ~0.35 s blocks reach the cap in
 * ~7 s, quicker than a keeper on a shared public RPC reacts.
 */
export const TESTNET_AUCTION_STEP_BPS = 5;

/** Monad testnet block time used for "about N s" figures (docs/RUNBOOK.md, auction step change of 2026-10-08). */
export const MONAD_BLOCK_S = 0.35;

/**
 * The auction step the page should quote: the testnet deployment's while only testnet production is live,
 * otherwise the contract default. Same rule as the hero and the share image.
 */
export function auctionStepBps(live: boolean, testnetLive: boolean): number {
  return testnetLive && !live ? TESTNET_AUCTION_STEP_BPS : AUCTION.stepBps;
}

/** "about 5 s" for a number of blocks at MONAD_BLOCK_S. */
export function aboutSeconds(blocks: number): string {
  const t = blocks * MONAD_BLOCK_S;
  return `about ${t < 1.5 ? t.toFixed(1).replace(/\.0$/, "") : Math.round(t)} s`;
}
