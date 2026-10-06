"use client";

import { createContext, useContext } from "react";

export interface AuthContextValue {
  /** True only when <AuthProvider> mounted a real PrivyProvider above us. */
  privyEnabled: boolean;
}

// Default is "no Privy": if AuthProvider isn't mounted, every auth UI falls
// back to demo mode instead of calling Privy hooks outside their provider.
export const AuthContext = createContext<AuthContextValue>({ privyEnabled: false });

export function useAuthContext(): AuthContextValue {
  return useContext(AuthContext);
}
