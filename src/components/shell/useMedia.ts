"use client";

// Media-query hook for the few places where layout changes *what* renders
// (swipe vs. button, position cards vs. table). Everything else is plain CSS.

import { useSyncExternalStore } from "react";

/** Tablet and up: header nav, no bottom tab bar. */
export const MQ_WIDE = "(min-width: 640px)";
/** Room for the positions table (cards below this). */
export const MQ_TABLE = "(min-width: 720px)";
/** Desktop terminal grid. */
export const MQ_DESKTOP = "(min-width: 1024px)";
/** A mouse/trackpad on a non-phone viewport: show a submit button instead of swipe-to-trade. */
export const MQ_FINE_POINTER = "(min-width: 640px) and (hover: hover) and (pointer: fine)";

const subscribers = new Map<string, (cb: () => void) => () => void>();

function subscriberFor(query: string) {
  let sub = subscribers.get(query);
  if (!sub) {
    sub = (cb: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", cb);
      return () => mql.removeEventListener("change", cb);
    };
    subscribers.set(query, sub);
  }
  return sub;
}

export function useMedia(query: string, serverDefault = false): boolean {
  return useSyncExternalStore(
    subscriberFor(query),
    () => window.matchMedia(query).matches,
    () => serverDefault,
  );
}
