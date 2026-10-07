"use client";

import { NOTICE_ATTR, NOTICE_KEY } from "./notice";

/** The × on a testnet notice (see notice.tsx). Remembered in this browser. */
export function NoticeClose({ className }: { className?: string }) {
  return (
    <button
      type="button"
      className={className}
      aria-label="Close this notice"
      title="Close this notice"
      onClick={() => {
        try {
          window.localStorage.setItem(NOTICE_KEY, "closed");
        } catch {
          /* blocked storage: closed for this page view only */
        }
        document.documentElement.setAttribute(NOTICE_ATTR, "testnet");
      }}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    </button>
  );
}
