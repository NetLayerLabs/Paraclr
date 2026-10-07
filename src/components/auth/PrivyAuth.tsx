"use client";

// Components in this file call Privy hooks, so they must only be rendered
// when useAuthContext().privyEnabled is true (i.e. under PrivyProvider).

import { useCallback, useEffect, useRef, useState } from "react";
import {
  useCreateWallet,
  useLoginWithPasskey,
  useLogout,
  usePrivy,
  useSignupWithPasskey,
  useWallets,
  type User,
} from "@privy-io/react-auth";
import { setChainWallet, signIn, signOut, useParaclr } from "@/lib/store";
import { shortAddress } from "@/lib/auth/demo";
import { privySigner, setSigner } from "@/lib/chain/signer";
import { BiometricButton, type BiometricPhase } from "./BiometricButton";
import styles from "./LoginScreen.module.css";

export function PrivyPasskeyLogin() {
  const { ready } = usePrivy();
  const { createWallet } = useCreateWallet();
  const [phase, setPhase] = useState<BiometricPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [offerSignup, setOfferSignup] = useState(false);
  const done = useRef(false);

  const complete = useCallback(
    async ({ user }: { user: User }) => {
      if (done.current) return;
      let address = user.wallet?.address;
      if (!address) {
        try {
          address = (await createWallet()).address;
        } catch {
          setPhase("error");
          setError("Signed in, but the embedded wallet could not be created.");
          return;
        }
      }
      done.current = true;
      setPhase("success");
      // Let the success tick play before the shell swaps screens.
      window.setTimeout(
        () => signIn({ address, method: "passkey", displayName: `Passkey ${shortAddress(address, 4, 4)}` }),
        450,
      );
    },
    [createWallet],
  );

  const onError = useCallback(() => {
    setPhase("error");
    setError("Passkey not recognised on this device.");
    setOfferSignup(true);
  }, []);

  // Sign-up failures are a different problem (e.g. passkey sign-up turned off for the
  // Privy app, or the browser prompt was dismissed), so say so instead of "not recognised".
  const onSignupError = useCallback(() => {
    setPhase("error");
    setError("Couldn't create a passkey. Passkey sign-up may be unavailable right now; try again or use the demo.");
    setOfferSignup(true);
  }, []);

  const { loginWithPasskey } = useLoginWithPasskey({ onComplete: complete, onError });
  const { signupWithPasskey } = useSignupWithPasskey({ onComplete: complete, onError: onSignupError });

  const run = async (fn: () => Promise<void>, fail: () => void = onError) => {
    setError(null);
    setPhase("scanning");
    try {
      await fn();
    } catch {
      fail();
    }
  };

  return (
    <>
      <BiometricButton
        phase={phase}
        disabled={!ready || phase === "scanning" || phase === "success"}
        label={ready ? "Sign in with FaceID" : "Loading passkeys…"}
        onClick={() => run(() => loginWithPasskey())}
      />
      {error && <p className={styles.error}>{error}</p>}
      {/* Always offered: on localhost the browser may suggest passkeys from other apps,
          which this Privy app doesn't know, so first-time users need a direct path. */}
      <button
        className={styles.linkBtn}
        disabled={!ready || phase === "scanning" || phase === "success"}
        onClick={() => run(signupWithPasskey, onSignupError)}
      >
        {offerSignup ? "New here? Create a passkey" : "First time? Create a passkey"}
      </button>
    </>
  );
}

export function PrivySignOutButton({ className }: { className?: string }) {
  const { logout } = useLogout();
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={className}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await logout();
        } finally {
          signOut();
        }
      }}
    >
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}

/**
 * Chain modes: registers the passkey user's Privy embedded wallet (its
 * EIP-1193 provider → viem wallet client) as the transaction signer. Privy is
 * configured with wallet UIs off, so transactions don't pop a confirmation.
 */
export function PrivyWalletBridge() {
  const { wallets, ready } = useWallets();
  const live = useParaclr((s) => s.chain.status === "ready");
  const address = useParaclr((s) => s.session?.address ?? null);
  const method = useParaclr((s) => s.session?.method ?? null);

  useEffect(() => {
    if (!live || !address || method !== "passkey") return;
    const wallet = wallets.find((w) => w.address.toLowerCase() === address.toLowerCase());
    if (!wallet) {
      setChainWallet({
        kind: "privy",
        address,
        ready: false,
        error: ready ? "Privy embedded wallet not connected yet." : null,
      });
      return;
    }
    setSigner(privySigner(wallet));
    setChainWallet({ kind: "privy", address: wallet.address, ready: true, error: null, persisted: true });
  }, [wallets, ready, live, address, method]);

  return null;
}
