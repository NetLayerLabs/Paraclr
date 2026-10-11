"use client";

// Components in this file call Privy hooks, so they must only be rendered
// when useAuthContext().privyEnabled is true (i.e. under PrivyProvider).

import { useCallback, useEffect, useRef, useState } from "react";
import {
  useCreateWallet,
  useLogin,
  useLoginWithPasskey,
  useLogout,
  usePrivy,
  useSignupWithPasskey,
  useWallets,
  type PrivyErrorCode,
  type User,
} from "@privy-io/react-auth";
import { setChainWallet, signIn, signOut, useParaclr } from "@/lib/store";
import { PRIVY_APP_ID } from "@/lib/auth/config";
import { isPrivyMethod, METHOD_LABEL, type SignInMethod } from "@/lib/types";
import { shortAddress } from "@/lib/auth/demo";
import { privySigner, setSigner } from "@/lib/chain/signer";
import { BiometricButton, type BiometricPhase } from "./BiometricButton";
import styles from "./LoginScreen.module.css";

/** The user's Privy embedded wallet: Privy's primary wallet when it is the embedded one, else the first. */
function embeddedAddress(user: User): string | undefined {
  if (user.wallet?.walletClientType === "privy") return user.wallet.address;
  const w = user.linkedAccounts.find((a) => a.type === "wallet" && a.walletClientType === "privy");
  return w?.type === "wallet" ? w.address : undefined;
}

/**
 * Finishes any Privy login: the wallet is the user's own for a wallet login, otherwise the
 * embedded wallet (created here if Privy hasn't made one yet). Returns an error message or null.
 */
function useCompleteLogin() {
  const { createWallet } = useCreateWallet();
  const { user: liveUser } = usePrivy();
  const latest = useRef<User | null>(null);
  useEffect(() => {
    if (liveUser) latest.current = liveUser;
  }, [liveUser]);
  const done = useRef(false);
  return useCallback(
    async (user: User, method: Exclude<SignInMethod, "demo">): Promise<string | null> => {
      if (done.current) return null;
      let address = method === "wallet" ? user.wallet?.address : embeddedAddress(user);
      if (!address && method !== "wallet") {
        // Privy creates the embedded wallet itself right after a first sign-in (createOnLogin):
        // wait for it instead of racing it with a second wallet, which left new accounts with two
        // addresses and the app showing either one.
        for (let i = 0; i < 40 && !address; i++) {
          await new Promise((r) => setTimeout(r, 200));
          address = embeddedAddress(latest.current ?? user);
        }
        if (!address) {
          try {
            address = (await createWallet()).address;
          } catch {
            address = embeddedAddress(latest.current ?? user);
            if (!address) return "Signed in, but the embedded wallet could not be created.";
          }
        }
      }
      if (!address) return "Signed in, but no wallet is connected.";
      done.current = true;
      rememberMethod(method);
      const signedIn = address;
      const account =
        method === "email"
          ? user.email?.address
          : method === "google"
            ? user.google?.email
            : method === "twitter"
              ? user.twitter?.username && `@${user.twitter.username}`
              : method === "discord"
                ? user.discord?.username
                : method === "github"
                  ? user.github?.username
                  : null;
      const name = account || `${METHOD_LABEL[method]} ${shortAddress(signedIn, 4, 4)}`;
      // Let the success tick play before the shell swaps screens.
      window.setTimeout(() => signIn({ address: signedIn, method, displayName: name }), 450);
      return null;
    },
    [createWallet],
  );
}

// The app's session lives in memory, Privy's survives a reload. The method of the last sign-in
// is kept so a reload can restore the same session (the address is re-read from Privy's user).
const METHOD_KEY = "paraclr.privy.method";

function rememberMethod(method: Exclude<SignInMethod, "demo">) {
  try {
    window.localStorage.setItem(METHOD_KEY, method);
  } catch {
    /* storage blocked: a reload infers the method from the Privy user */
  }
}

/** How this Privy user signed in last: the remembered method, else inferred from the linked accounts. */
function lastMethod(user: User): Exclude<SignInMethod, "demo"> {
  let saved: string | null = null;
  try {
    saved = window.localStorage.getItem(METHOD_KEY);
  } catch {
    saved = null;
  }
  if (saved && saved !== "demo" && isPrivyMethod(saved as SignInMethod)) return saved as Exclude<SignInMethod, "demo">;
  const types = new Set(user.linkedAccounts.map((a) => a.type));
  if (types.has("passkey")) return "passkey";
  if (types.has("email")) return "email";
  if (types.has("google_oauth")) return "google";
  if (types.has("twitter_oauth")) return "twitter";
  if (types.has("discord_oauth")) return "discord";
  if (types.has("github_oauth")) return "github";
  return "wallet";
}

/**
 * Restores the app session after a reload while Privy still holds one: without it the sign-in
 * page came back, and Privy's login() ignores calls from a user it considers logged in, so the
 * sign-in buttons appeared to do nothing until site data was cleared.
 */
export function PrivySessionRestore() {
  const { ready, authenticated, user } = usePrivy();
  const session = useParaclr((s) => s.session);
  const complete = useCompleteLogin();
  useEffect(() => {
    if (!ready || !authenticated || !user || session) return;
    void complete(user, lastMethod(user));
  }, [ready, authenticated, user, session, complete]);
  return null;
}

/** What went wrong, from Privy's error code: cancelling and an unknown passkey need different advice. */
function passkeyError(error: PrivyErrorCode, signup: boolean): string {
  // Compared as strings: not every code here is a member of this package's enum.
  const code = String(error);
  if (code === "passkey_not_allowed" || code === "exited_auth_flow") {
    return "The passkey prompt was closed or timed out. Try again.";
  }
  if (code === "passkey_not_registered") {
    return "That passkey isn't registered with Paraclr. If your browser offered several passkeys, pick the one you made here, or create a new one.";
  }
  return signup
    ? "Couldn't create a passkey. Passkey sign-up may be unavailable right now; try again, or use email or a wallet."
    : "Couldn't sign in with that passkey. Try again, or use email or a wallet.";
}

export function PrivyPasskeyLogin() {
  const { ready } = usePrivy();
  const complete = useCompleteLogin();
  const [phase, setPhase] = useState<BiometricPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [offerSignup, setOfferSignup] = useState(false);

  const onComplete = useCallback(
    async ({ user }: { user: User }) => {
      const err = await complete(user, "passkey");
      setPhase(err ? "error" : "success");
      setError(err);
    },
    [complete],
  );

  const onError = useCallback((code: PrivyErrorCode) => {
    setPhase("error");
    setError(passkeyError(code, false));
    setOfferSignup(true);
  }, []);

  // Sign-up failures are a different problem (e.g. passkey sign-up turned off for the
  // Privy app, or the browser prompt was dismissed), so say so instead of "not registered".
  const onSignupError = useCallback((code: PrivyErrorCode) => {
    setPhase("error");
    setError(passkeyError(code, true));
    setOfferSignup(true);
  }, []);

  const { loginWithPasskey } = useLoginWithPasskey({ onComplete, onError });
  const { signupWithPasskey } = useSignupWithPasskey({ onComplete, onError: onSignupError });

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    setPhase("scanning");
    try {
      await fn();
    } catch {
      // Privy normally reports the reason through onError, which replaces this message.
      setPhase("error");
      setError((e) => e ?? "Couldn't sign in with that passkey. Try again, or use email or a wallet.");
    }
  };

  return (
    <>
      <BiometricButton
        phase={phase}
        disabled={!ready || phase === "scanning" || phase === "success"}
        label={ready ? "Sign in with a passkey" : "Loading passkeys…"}
        onClick={() => run(() => loginWithPasskey())}
      />
      {error && <p className={styles.error}>{error}</p>}
      {/* Always offered: on localhost the browser may suggest passkeys from other apps,
          which this Privy app doesn't know, so first-time users need a direct path. */}
      <button
        className={styles.linkBtn}
        disabled={!ready || phase === "scanning" || phase === "success"}
        onClick={() => run(signupWithPasskey)}
      >
        {offerSignup ? "New here? Create a passkey" : "First time? Create a passkey"}
      </button>
    </>
  );
}

const PRIVY_LOGIN_METHOD: Record<string, Exclude<SignInMethod, "demo">> = {
  email: "email",
  google: "google",
  twitter: "twitter",
  discord: "discord",
  github: "github",
  siwe: "wallet",
  passkey: "passkey",
};

type Social = "google" | "twitter" | "discord" | "github";
const SOCIALS: Social[] = ["google", "twitter", "discord", "github"];
let socialsLoad: Promise<Social[]> | null = null;

/**
 * The social logins switched on in the Privy dashboard. Privy's modal lists every configured
 * method even when the dashboard has it off, and those then fail with "not allowed", so only
 * enabled ones are offered. Reads the same app config the Privy SDK loads; none on failure.
 */
function enabledSocials(): Promise<Social[]> {
  socialsLoad ??= fetch(`https://auth.privy.io/api/v1/apps/${PRIVY_APP_ID}`, { headers: { "privy-app-id": PRIVY_APP_ID } })
    .then((r) => (r.ok ? (r.json() as Promise<Record<string, unknown>>) : {}))
    .then((cfg) => SOCIALS.filter((s) => (cfg as Record<string, unknown>)[`${s}_oauth`] === true))
    .catch(() => []);
  return socialsLoad;
}

/** Email (one-time code), a social account or the user's own wallet, through Privy's modal. */
export function PrivyOtherLogin({ disabled = false }: { disabled?: boolean }) {
  const { ready, authenticated, user } = usePrivy();
  const complete = useCompleteLogin();
  const [error, setError] = useState<string | null>(null);
  const [socials, setSocials] = useState<Social[]>([]);
  useEffect(() => {
    let live = true;
    void enabledSocials().then((s) => live && setSocials(s));
    return () => {
      live = false;
    };
  }, []);
  const { login } = useLogin({
    onComplete: async ({ user, loginMethod, wasAlreadyAuthenticated }) => {
      // Privy also calls this on page load for a session it restored, without a login method:
      // keep the method of the original sign-in.
      const method = wasAlreadyAuthenticated ? lastMethod(user) : (PRIVY_LOGIN_METHOD[String(loginMethod)] ?? lastMethod(user));
      setError(await complete(user, method));
    },
    onError: (code) => {
      if (code !== "exited_auth_flow") setError("Sign-in didn't complete. Try again.");
    },
  });
  return (
    <>
      <button
        type="button"
        className={styles.demoBtn}
        disabled={!ready || disabled}
        onClick={async () => {
          setError(null);
          // Already signed in with Privy (login() would do nothing): finish that session instead.
          if (authenticated && user) {
            setError(await complete(user, lastMethod(user)));
            return;
          }
          login({ loginMethods: ["email", ...socials, "wallet"] });
        }}
      >
        {socials.length > 0 ? "Continue with email, social or wallet" : "Continue with email or wallet"}
      </button>
      {error && <p className={styles.error}>{error}</p>}
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
 * Chain modes: registers the Privy user's wallet (its EIP-1193 provider → viem
 * wallet client) as the transaction signer: the embedded wallet for passkey and
 * email users, their own wallet for a wallet login (which asks to confirm every
 * transaction). Embedded-wallet confirmation UIs follow SHOW_WALLET_UIS.
 */
export function PrivyWalletBridge() {
  const { wallets, ready } = useWallets();
  const live = useParaclr((s) => s.chain.status === "ready");
  const address = useParaclr((s) => s.session?.address ?? null);
  const method = useParaclr((s) => s.session?.method ?? null);

  useEffect(() => {
    if (!live || !address || !isPrivyMethod(method)) return;
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
