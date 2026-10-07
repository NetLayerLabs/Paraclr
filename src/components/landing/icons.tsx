// Line icons for the brand pages: 24-unit grid, 1.6 stroke, round joins.
// Generic glyphs only: no third-party logos (GitHub is a neutral code glyph).
import type { ReactNode } from "react";

type IconProps = { className?: string };

function Svg({ className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const ArrowRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 12h14M13 6.5l5.5 5.5-5.5 5.5" />
  </Svg>
);

export const ArrowUpRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 17 17 7M8.5 7H17v8.5" />
  </Svg>
);

export const ArrowDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4.5v14M6.5 13l5.5 5.5 5.5-5.5" />
  </Svg>
);

/** Neutral "source code" glyph for GitHub links. */
export const CodeIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m8 7-5 5 5 5M16 7l5 5-5 5M13.5 4.5l-3 15" />
  </Svg>
);

export const Check = (p: IconProps) => (
  <Svg {...p}>
    <path d="m5 12.5 4.2 4.2L19 7" />
  </Svg>
);

export const Cross = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" />
  </Svg>
);

export const Minus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 12h12" />
  </Svg>
);

export const Chevron = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6 9.5 6 6 6-6" />
  </Svg>
);

export const Menu = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 8h16M4 16h16" />
  </Svg>
);

/* ---- Problem ------------------------------------------------------------ */

/** Fixed penalty: a padlock. */
export const Lock = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5" y="10.5" width="14" height="10" rx="2.5" />
    <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5M12 14.5v2.5" />
  </Svg>
);

/** Gas bidding: a flame. */
export const Flame = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 21c-3.9 0-6.5-2.6-6.5-6.1 0-3.4 2.4-5.2 3.6-8.4.3 1.9 1.2 3 2.4 3.6.1-2.8 1.3-5 3.3-7.1-.2 3.1 3.7 5.5 3.7 10.2C18.5 18.6 15.9 21 12 21Z" />
    <path d="M12 21c-1.6 0-2.7-1.1-2.7-2.6 0-1.6 1.5-2.6 2.7-4.4 1.2 1.8 2.7 2.8 2.7 4.4 0 1.5-1.1 2.6-2.7 2.6Z" />
  </Svg>
);

/** No price discovery: an eye, struck through. */
export const EyeOff = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 12S6.5 6 12 6s8.5 6 8.5 6-3 6-8.5 6-8.5-6-8.5-6Z" />
    <circle cx="12" cy="12" r="2.6" />
    <path d="m4.5 19.5 15-15" />
  </Svg>
);

/* ---- Auction / backstop ------------------------------------------------- */

export const Layers = (p: IconProps) => (
  <Svg {...p}>
    <path d="m12 3.5 8.5 4.5-8.5 4.5L3.5 8 12 3.5Z" />
    <path d="m3.5 12 8.5 4.5 8.5-4.5M3.5 16l8.5 4.5 8.5-4.5" />
  </Svg>
);

export const Percent = (p: IconProps) => (
  <Svg {...p}>
    <path d="M18.5 5.5 5.5 18.5" />
    <circle cx="7.5" cy="7.5" r="2.3" />
    <circle cx="16.5" cy="16.5" r="2.3" />
  </Svg>
);

export const Shield = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5 19 6v5.6c0 4.4-2.9 7.6-7 8.9-4.1-1.3-7-4.5-7-8.9V6l7-2.5Z" />
    <path d="m9 12 2.2 2.2L15.5 10" />
  </Svg>
);

export const Clock = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Svg>
);

/* ---- Mainnet beta ------------------------------------------------------- */

export const Coin = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M14.8 9.2c-.5-.9-1.6-1.5-2.8-1.5-1.6 0-2.8.9-2.8 2.1 0 2.9 5.8 1.4 5.8 4.3 0 1.2-1.3 2.2-3 2.2-1.3 0-2.4-.6-2.9-1.6M12 6v1.7M12 16.3V18" />
  </Svg>
);

export const Pulse = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 12h4l2.2-5.5 4.2 11 2.4-5.5H21" />
  </Svg>
);

export const Gauge = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.2 17.5a8.5 8.5 0 1 1 15.6 0" />
    <path d="m12 13.5 3.8-4.3M12 13.5h.01" />
  </Svg>
);

export const Lanes = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 7.5h17M3.5 12h17M3.5 16.5h17" />
    <circle cx="9" cy="7.5" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="15" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="7" cy="16.5" r="1.4" fill="currentColor" stroke="none" />
  </Svg>
);

export const Scale = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4v16M7 20h10M5 7h14" />
    <path d="m5 7-2.5 6a2.8 2.8 0 0 0 5 0L5 7ZM19 7l-2.5 6a2.8 2.8 0 0 0 5 0L19 7Z" />
  </Svg>
);

export const Key = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="15" r="4" />
    <path d="m11 12 8.5-8.5M16 7l2.5 2.5M18 5l2 2" />
  </Svg>
);
