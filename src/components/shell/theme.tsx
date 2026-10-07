"use client";

// Theme for the trading app: a tiny external store over <html data-theme>,
// the header toggle, and the pre-paint script element. See themeScript.ts.

import { useLayoutEffect, useSyncExternalStore } from "react";
import { THEME_INIT_SCRIPT, THEME_STORAGE_KEY, type Theme } from "./themeScript";

const LIGHT_QUERY = "(prefers-color-scheme: light)";

function storedTheme(): Theme | null {
  try {
    const v = window.localStorage.getItem(THEME_STORAGE_KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

function systemTheme(): Theme {
  try {
    return window.matchMedia(LIGHT_QUERY).matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

let current: Theme | null = null;
const listeners = new Set<() => void>();

function apply(theme: Theme) {
  current = theme;
  document.documentElement.setAttribute("data-theme", theme);
  listeners.forEach((l) => l());
}

function getTheme(): Theme {
  if (current === null) current = storedTheme() ?? systemTheme();
  return current;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  // Follow the OS while the viewer hasn't picked a theme themselves.
  let mql: MediaQueryList | null = null;
  try {
    mql = window.matchMedia(LIGHT_QUERY);
  } catch {
    mql = null;
  }
  const onSystem = () => {
    if (!storedTheme()) apply(systemTheme());
  };
  mql?.addEventListener("change", onSystem);
  return () => {
    listeners.delete(cb);
    mql?.removeEventListener("change", onSystem);
  };
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme, () => "dark");
}

export function setTheme(theme: Theme) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* storage blocked: the choice lasts for this page view */
  }
  apply(theme);
}

/**
 * Keeps <html data-theme> set while the app is mounted: covers client-side
 * navigation into /app (where the inline script doesn't run) and the dev
 * Strict Mode remount, and removes it when leaving /app so no other route
 * inherits the app's theme.
 */
export function ThemeSync() {
  useLayoutEffect(() => {
    apply(storedTheme() ?? systemTheme());
    return () => {
      current = null;
      document.documentElement.removeAttribute("data-theme");
    };
  }, []);
  return null;
}

/**
 * The pre-paint script. Executable only in the server HTML; on the client the
 * element is inert (text/plain), so React never renders a live <script>.
 */
export function ThemeScript() {
  return (
    <script
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }}
    />
  );
}

export function ThemeToggle({ className }: { className?: string }) {
  const theme = useTheme();
  const next: Theme = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className={className}
      onClick={() => setTheme(next)}
      aria-label={`Switch to the ${next} theme`}
      title={`Switch to the ${next} theme`}
      data-theme-toggle={theme}
    >
      {theme === "dark" ? (
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
          <circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path
            d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
          <path
            d="M20.2 14.6A8.3 8.3 0 0 1 9.4 3.8a8.3 8.3 0 1 0 10.8 10.8z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
}
