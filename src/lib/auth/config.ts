// Privy is enabled only when NEXT_PUBLIC_PRIVY_APP_ID is set at build time.
// Without it the app runs entirely in demo mode — nothing is ever blocked.

export const PRIVY_APP_ID: string = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";
export const PRIVY_CLIENT_ID: string | undefined = process.env.NEXT_PUBLIC_PRIVY_CLIENT_ID || undefined;

export const PRIVY_ENABLED = PRIVY_APP_ID.trim().length > 0;
