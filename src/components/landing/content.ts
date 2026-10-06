// Shared landing constants (safe for client components: no server imports).

export const GITHUB_URL = "https://github.com/mrnetwork0001/paraclr";
export const GITHUB_TREE = `${GITHUB_URL}/tree/main`;
export const GITHUB_BLOB = `${GITHUB_URL}/blob/main`;

// TODO: replace with the project's X / Twitter profile URL once it exists.
export const X_URL = "#";

export const MONAD_EXPLORER = "https://testnet.monadexplorer.com";

/** In page order. */
export const NAV_LINKS = [
  { href: "#auction", label: "Auctions" },
  { href: "#backstop", label: "Backstop" },
  { href: "#xray", label: "X-ray" },
  { href: "#solvency", label: "Solvency" },
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
