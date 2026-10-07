// Shared beta / legal copy. Client-safe (no server imports), so the app's risk
// acknowledgement modal, its beta banner and the landing page all say the same
// thing. Link to the full pages with TERMS_PATH / RISK_PATH; deep-link a risk
// with `${RISK_PATH}#${RISK_ANCHORS.oracle}` etc.

export const TERMS_PATH = "/terms";
export const RISK_PATH = "/risk";

/** The label the production plan requires everywhere the mainnet beta is mentioned. */
export const BETA_LABEL = "Unaudited beta · capped · use only what you can afford to lose";

export const AUDIT_STATUS = "Not audited: internal review and Slither only";

export const LEGAL_DRAFT_NOTICE = "DRAFT — not legal advice; requires legal review before launch";

/** Stable section ids on /risk. */
export const RISK_ANCHORS = {
  smartContract: "smart-contract",
  oracle: "oracle",
  execution: "delayed-orders",
  liquidation: "liquidation",
  funding: "funding",
  caps: "caps-and-pause",
  keeper: "keeper-liveness",
  backstop: "backstop",
  stablecoin: "stablecoin",
  admin: "admin-keys",
  chain: "chain-and-wallet",
  demo: "demo-results",
  regulatory: "regulatory",
  recovery: "no-recovery",
} as const;

/**
 * Short points for a "before your first deposit" acknowledgement. Each one links
 * to its section on /risk. Keep them plain and true for the mainnet beta.
 */
export const RISK_ACK_POINTS: ReadonlyArray<{ text: string; anchor: string }> = [
  {
    text: "The contracts are not audited (internal review and Slither only). A bug can lose some or all of your deposit.",
    anchor: RISK_ANCHORS.smartContract,
  },
  {
    text: "Leverage can liquidate your position. You can lose all the AUSD you deposit.",
    anchor: RISK_ANCHORS.liquidation,
  },
  {
    text: "Prices come from Pyth. A wrong, stale or delayed price can hurt your position, and orders fill at a price you can't see when you submit them.",
    anchor: RISK_ANCHORS.oracle,
  },
  {
    text: "Deposits, positions and open interest are capped, and the guardian can pause deposits and new positions.",
    anchor: RISK_ANCHORS.caps,
  },
  {
    text: "Collateral is AUSD, a stablecoin issued by Agora. If it loses its peg or is frozen, your balance loses value.",
    anchor: RISK_ANCHORS.stablecoin,
  },
  {
    text: "Nobody guarantees to recover lost funds. Transactions can't be reversed.",
    anchor: RISK_ANCHORS.recovery,
  },
  {
    text: "You are responsible for checking that using Paraclr is legal where you live.",
    anchor: RISK_ANCHORS.regulatory,
  },
];
