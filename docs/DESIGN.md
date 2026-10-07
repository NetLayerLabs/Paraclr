# Paraclr design system

The brand system behind the landing page (`/`) and the legal pages (`/terms`, `/risk`), and the spec the trading
app (`/app`) should be restyled to. If the code and this file disagree, fix one of them.

| What | Where |
| --- | --- |
| Tokens + primitives (buttons, chips, cards, type) | `src/components/landing/brand/Brand.module.css` |
| Section bend (the lane motif) | `src/components/landing/brand/Bend.tsx`, `Bend.module.css` |
| Logo (mark + wordmark) | `src/components/landing/brand/Logo.tsx`, `src/app/icon.svg`, `src/app/favicon.ico` |
| Display font | `src/components/landing/brand/fonts.ts` (next/font, CSS variable only) |
| Palette for code that can't read CSS (OG cards) | `src/components/landing/brand/tokens.ts` |
| OG / Twitter card | `src/components/landing/ogImage.tsx` (Sora TTFs in `brand/fonts/`, OFL) |

Everything is scoped under the CSS-module class `.root` (light) with `.dark` / `.light` overrides. Nothing reaches
`/app`, which still runs on `src/app/globals.css`. Sora loads only on routes that import `brand/fonts.ts`, so `/app`
never downloads it.

---

## 1. Principles

1. **Light page, black chapters.** White sections carry the story; full-black sections carry evidence (X-ray,
   solvency, FAQ, the stack). They're joined by large quarter-circle **bends** with 8 lane stripes.
2. **One accent.** Monad purple (`#6E54FF`) marks the one thing to look at: the hero word, the primary button,
   the "Paraclr" column, a threshold. Green and red appear only when they mean long/short, healthy/broken,
   good/bad numbers.
3. **Heavy display, quiet body.** Headlines are Sora 800 with tight tracking; a sentence often ends in a grey
   second clause (`<em>`). Body text is Geist at comfortable sizes; numbers are Geist Mono.
4. **Product as illustration.** Visuals are HTML/CSS product cards, not stock art. Anything schematic carries an
   `Illustration` / `Schematic` tag. Anything measured names its source file and network.
5. **Honest labels are part of the design.** Status chips, "local anvil — not Monad", "Not audited", "set at
   launch" are styled components, not footnotes. See §9.

---

## 2. Colour

### Light (default, `.root` / `.light`)

| Token | Value | Use |
| --- | --- | --- |
| `--pc-bg` | `#FFFFFF` | page |
| `--pc-bg-subtle` | `#F6F6F9` | table heads, inline code, tracks |
| `--pc-surface` / `--pc-surface-2` | `#FFFFFF` / `#F9F9FB` | cards / trust row |
| `--pc-line` / `--pc-line-strong` | `#E9E8F0` / `#D9D7E3` | hairlines, card borders / dashed, hover |
| `--pc-ink` | `#0B0A12` | headings, primary text (19.7:1) |
| `--pc-ink-2` | `#45434F` | body copy (9.7:1) |
| `--pc-ink-3` | `#6B6979` | captions, labels (5.4:1; 5.0:1 on subtle) |
| `--pc-display-2` | `#8B8996` | grey display clause — **≥ 24 px bold only** (3.4:1) |
| `--pc-accent` | `#6E54FF` | fills, primary button, hero word (4.8:1 both ways with white) |
| `--pc-accent-strong` | `#5A3FF2` | hover / pressed |
| `--pc-accent-text` | `#5A3FF2` | accent-coloured text, links, eyebrows (6.1:1) |
| `--pc-accent-soft` / `--pc-accent-line` | `#F1EEFF` / `#D9D1FF` | accent chip, callouts |
| `--pc-pos(-text/-soft/-line)` | `#0E9F6E` / `#067A52` / `#E8F7F0` / `#BCE9D4` | good, long, healthy (text 5.4:1) |
| `--pc-neg(-text/-soft/-line)` | `#E5484D` / `#C2282E` / `#FDEDED` / `#F6CACC` | bad, short, cross-lane (text 5.8:1) |
| `--pc-warn(-text/-soft/-line)` | `#F59E0B` / `#A15C07` / `#FEF6E7` / `#F6DCAA` | pending, anvil, draft (text 5.2:1) |

### Dark (`.dark`)

| Token | Value | Use |
| --- | --- | --- |
| `--pc-bg` | `#08070D` | black chapters, footer |
| `--pc-bg-subtle` | `#0E0D15` | code strips |
| `--pc-surface` / `--pc-surface-2` | `#111019` / `#16141F` | cards |
| `--pc-line` / `--pc-line-strong` | `rgba(255,255,255,.08)` / `.15` | |
| `--pc-ink` / `--pc-ink-2` / `--pc-ink-3` | `#F5F4FA` / `#B6B3C6` / `#8E8AA2` | 18.4 / 9.8 / 6.0 :1 |
| `--pc-display-2` | `#77748A` | grey display clause, large only (4.4:1) |
| `--pc-accent` | `#6E54FF` | fills only on dark (4.2:1 as text — don't) |
| `--pc-accent-text` | `#A898FF` | accent text on dark (8.2:1) |
| `--pc-pos` / `--pc-neg-text` / `--pc-warn-text` | `#3DDC97` / `#FF7D94` / `#FFC46B` | 11.4 / 8.2 / 12.8 :1 |

Lane stripes and data marks on dark use `#8F7CFF` / `#A898FF`; cross-lane edges `#FF5C7A`.

---

## 3. Type

| Role | Face | Why |
| --- | --- | --- |
| Display | **Sora** (variable, used at 800/700) via `next/font/google`, `--font-pc-display` | Geometric and heavy like the reference's Montserrat Black, but squarer counters and tighter apertures read *engineered*, not friendly. Compact width keeps 44 px headlines on one line at 360 px. Crisp numerals for stat tiles. One variable file. |
| Body | **Geist** (already loaded by the app) | Clean, neutral, shared with `/app`, so the landing and the terminal feel like one product with no extra download. |
| Mono | **Geist Mono** | Numbers, code, addresses, chips, eyebrows. Always `font-variant-numeric: tabular-nums` for figures. |

Scale (fluid, `clamp()` between 360 px and 1440 px):

| Token / class | Size | Weight | Line height | Tracking |
| --- | --- | --- | --- | --- |
| Hero H1 line 1 | 44 → 82 px | Sora 800 | 0.98 | −0.05em |
| Hero H1 line 2 (grey) | 24 → 34 px | Sora 800 | 1.12 | −0.045em |
| `.h2` section title | 32 → 54 px | Sora 800 | 1.04 | −0.045em |
| Block title (inside a section) | 22 → 30 px | Sora 800 | 1.1 | −0.04em |
| `.h3` card title | 19 px | Sora 700 | 1.28 | −0.025em |
| Big stat | 34 → 68 px | Sora 800 | 0.9–1 | −0.045em |
| `.lede` | 16.5 → 18.5 px | Geist 400 | 1.65 | 0 |
| `.body` | 15.5 px | Geist 400 | 1.62 | 0 |
| Small / caption | 13–14 px | Geist 400 | 1.55 | 0 |
| `.eyebrow` | 12 px | Geist Mono 500 | 1 | 0.14em, uppercase |
| Chip | 11.5 px | Geist Mono 500 | 1.2 | 0.01em |

Headline pattern: `<h2 class="h2">Statement. <em>Grey second clause.</em></h2>`. Add `.breakEm` to put the clause on
its own line on wide screens. Use `text-wrap: balance` on headlines, `pretty` on paragraphs.

---

## 4. Space, layout, radii, shadow

- **Container:** 1200 px content + `--pc-gutter` = `clamp(16px, 4.4vw, 40px)` each side.
- **Section rhythm:** `--pc-section-y` = `clamp(72px, 9vw, 128px)`. Blocks inside a section: 48–80 px. Card
  grids: 16–20 px gaps. Base unit 4 px.
- **Breakpoints (literal in modules):** 1100 (hero stacks), 1024, 960 (nav collapses), 900, 640 (phone), 480.
- **Radii:** `--pc-r-xs 6` (code, tags) · `--pc-r-sm 10` · `--pc-r-md 14` (inner tiles) · `--pc-r-lg 20` (cards) ·
  `--pc-r-xl 28` (bands, comparison table) · `--pc-r-pill 999` (buttons, chips). Mark tile: 26.5% of its size.
- **Shadows (light):** `--pc-shadow-1` resting card (barely there) · `--pc-shadow-2` floating chip / table ·
  `--pc-shadow-3` tilted product cards. On dark, cards get no drop shadow, only `--pc-card-highlight`
  (a 1 px inner top highlight).

---

## 5. Motion

| Token | Value | Use |
| --- | --- | --- |
| `--pc-ease` | `cubic-bezier(.2,.7,.2,1)` | everything |
| `--pc-dur-1` | 140 ms | colour on hover |
| `--pc-dur-2` | 240 ms | buttons, chevrons, lifts |
| `--pc-dur-3` | 600 ms | entrances |

What moves: the hero caret blinks (1.1 s, steps); hero cards rise in once; the auction board runs one 8 s loop
(discount 0 → 25 → 50 → 75 bps, then resolutions); floating chips bob ±5 px; the "Built on" marquee scrolls (64 s,
pauses on hover/focus); primary buttons lift 1 px with the arrow nudging 3 px.

`prefers-reduced-motion: reduce` turns all of it off: the board shows its settled state (block +3, statuses
resolved), the caret is solid, the marquee becomes a hand-scrollable row with no duplicate. Nothing conveys
information only through motion.

---

## 6. Components

**Buttons** (`.btn` + one of): `.btnPrimary` (purple pill, white text, soft purple glow) for the one main action
per view; `.btnOutline` (1.5 px purple border, purple text) for the secondary; `.btnInverse` (white pill) as the
primary on black; `.btnQuiet` (hairline border) as the secondary on black or for low-stakes links. Sizes: `.btnSm`
38 px, default 48 px, `.btnLg` 56 px. Icons 17 px; trailing arrows get `.btnIconMove`. Phones: CTAs go full width.

**Chips** (`.chip`, mono, pill): neutral, `.chipAccent`, `.chipPos`, `.chipWarn`, `.chipNeg`. Optional leading
`.dot` (7 px; `.dotPos`, `.dotWarn`, `.dotNeg`). Chips state facts: network, status, role. Not decoration.

**Trust row** (hero): one bordered `--pc-r-lg` box, 4 cells divided by hairlines, each a dot + bold label + grey
sub-line, each a link to its evidence. 2×2 on phones. Every badge must be true for the current build; status follows
`deployments/143.json`.

**Cards** (`.card` + `.cardPad`): 1 px line, `--pc-r-lg`, `--pc-shadow-1`. Feature cards: `.iconTile` (44 px,
12 px radius, subtle fill, 21 px line icon) → `.h3` → `.body`. Optional mono tag top-right. Icons live in
`landing/icons.tsx` (24-grid, 1.6 stroke, round joins, generic glyphs only — no third-party logos).

**Product mock-ups**: `.chrome` (three quiet grey dots) in a title bar, real-looking but labelled content, mono for
data. Tag schematic ones with `.tagIllustration`. Hero: light card behind (rotateY 13°, rotateZ −3°), dark card in
front (rotateY −13°, rotateZ 2.5°), `perspective: 1800px`, `--pc-shadow-3`. Flatten the tilt below 640 px.

**Tables**: header row on `--pc-bg-subtle`, mono 11 px uppercase labels with 0.1em tracking, 1 px row lines, mono
figures. Wide data tables scroll inside `.scrollX` (never the page). The comparison table highlights the Paraclr
column with a 4.5% purple wash and a filled purple check; the other column gets a grey dash. Phones: rows become
stacked cards with `data-label` captions.

**Accordion** (FAQ): native `<details>/<summary>`; mono index `01…`, question in Geist 600 16–18 px, chevron that
rotates 180°; open index turns accent. Hairlines between items.

**Announcement bar**: 42 px black strip above the nav with the deployment status (dot + one sentence + link). It is
how the page says "demo only, no real value" before anything else.

**Nav**: sticky, white at 86% with blur; hairline + soft shadow once scrolled. Mark + wordmark left, 6 links,
GitHub circle, `Launch app` small primary. Below 960 px: menu button → full-width sheet.

**Footer**: black; brand column (mark, one-line description) + Product / Protocol / Resources columns; fine print
with the beta/audit status, "drafts pending legal review", non-affiliation. Placeholders (X) render as "soon", not
as dead links.

### Section bends (signature motif)

`<Bend into="dark" | "light" corner="left" | "right" />` sits between a light and a dark section. The light block's
corner turns through a quarter circle of radius `--pc-bend-r` = `clamp(72px, 15vw, 220px)`; on the dark side, 8 lanes
(1 px, `#8F7CFF`, opacity 0.70 → 0.18 outward, pitch 4.6% of r) run along the section edge, follow the curve
concentrically and leave the viewport. A mask fades them in from the far side.

Construction: lane *k* is a box with a single rounded corner of radius `r + k·d` that shares the fill's centre, so the
stripes are exactly concentric at any width, in pure CSS. The light neighbour overlaps the bend's flat half (content
inside the container never reaches the curve), so a bend never reads as a gap; the dark neighbour pads itself clear of
the lanes. Alternate corners down the page (right, left, right…). Use bends only at light↔dark changes, never two in a
row, never inside a section.

### Logo

- **Mark**: a rounded tile (radius 8.5/32) in `#6E54FF` with 8 white lanes (stroke 1.3/32) that enter from the left,
  take a quarter turn around one solid corner and leave through the top. Geometry in `Logo.tsx` (`LANE_RADII`,
  `lanePath`), same as the bends. It reads as the corner of a running track: 8 lanes, nobody leaves their own.
- **Wordmark**: "Paraclr" in Sora 800, tracking −0.045em, `--pc-ink` (white on dark), mark at ~1.45× cap height,
  gap 11 px at 22 px type.
- **Tones**: `brand` (purple tile, default on light and dark), `ink` (black tile, one-colour on light), `paper`
  (white tile, ink lanes, on purple or photos).
- **Clear space**: half the mark's width on all sides. **Minimum**: 20 px on screen. At ≤ 16 px (favicon.ico 16 px
  entry only) use the optical variant with 4 thicker lanes; everywhere else the mark has exactly 8.
- **Don't**: recolour the lanes, add a gradient or glow inside the tile, change the lane count, rotate or mirror it,
  set the wordmark in another face, put the purple tile on a purple background.

---

## 7. Do / don't

| Do | Don't |
| --- | --- |
| One purple thing per view; grey second clauses for rhythm | Purple gradients on text, multiple accents, teal/cyan |
| Green/red only for meaning (long/short, ok/broken, 0 vs 16) | Green "success" decoration, red for emphasis |
| Mono for every number, address, hash, bps | Proportional digits in tables or tickers |
| Tag illustrations; name the file and network for measured data | Unlabelled mock data that looks measured |
| Status chips that follow the deployment files | "Audited", "safe", "guaranteed", "no MEV", "instant" |
| Text wordmarks for partners, with a usage chip | Third-party logos |
| Hairlines + whitespace to separate | Heavy borders, boxes inside boxes inside boxes |
| Bends between light and dark chapters | Bends inside sections, glows, background blobs |

---

## 8. Accessibility

AA contrast for all text (table in §2; `--pc-display-2` and purple-on-dark are large-text/fill only). Visible focus:
2 px `--pc-focus` outline, 3 px offset, pill-shaped on buttons. Skip link first in tab order. Landmarks: `header`,
`nav` (labelled), `main#main`, `footer`; every section `aria-labelledby` its heading. Decorative SVG/bends are
`aria-hidden`; data graphics have `role="img"` + a sentence label. Native `<details>` for disclosure. No horizontal page
scroll from 360 to 1920 px. Reduced motion respected (§5).

---

## 9. Honesty rules (UI copy)

- Live-mainnet language only when `deployments/143.json` has `"production": true` (`loadProductionStatus().live`).
- Anvil numbers always carry the `local anvil — not Monad` warn chip; Monad testnet numbers the green testnet chip.
- Demo-bot activity is labelled "(demo bots)".
- The X-ray is "dependencies, not measured re-executions".
- Never "audited", "safe", "guaranteed", "no MEV". Use "Not audited: internal review and Slither only" (`AUDIT_STATUS`)
  and `BETA_LABEL` from `landing/disclosures.ts`.
- A value missing from the deployment file renders as a dashed "set at launch" pill, never a guess.

---

## 10. Applying this to the trading app (`/app`)

The app is a dense terminal, so it uses the same system in a **dark-first, compact** variant.

1. **Tokens.** Port the `.dark` set into `src/app/globals.css` as the app's `:root`, keeping the existing variable
   names as aliases so components migrate gradually:

   | App today | New value | Brand token |
   | --- | --- | --- |
   | `--bg #07060c` | `#08070D` | `--pc-bg` |
   | `--bg-elev #110f1a` | `#111019` | `--pc-surface` |
   | `--bg-elev-2 #1a1726` | `#16141F` | `--pc-surface-2` |
   | `--border #2a2638` | `rgba(255,255,255,.08)` (`.15` strong) | `--pc-line` |
   | `--text #ecebf3` / `--text-dim #8d89a3` | `#F5F4FA` / `#8E8AA2` (+ `#B6B3C6` for body) | `--pc-ink*` |
   | `--accent #836ef9` | `#6E54FF` fills, `#A898FF` text | `--pc-accent`, `--pc-accent-text` |
   | `--long/--ausd #3ddc97`, `--short #ff5c7a`, `--warn #ffb547` | unchanged | `--pc-pos`, `--pc-neg`, `--pc-warn` |

   Offer a light option by scoping the light set under `[data-theme="light"]` on `<html>`; never mix themes inside a
   panel.
2. **Density.** Terminal panels: radius 10 px (`--radius-panel`), 12–16 px padding, 13–14 px body, 11 px mono labels,
   32–36 px controls (`.btnSm` height 38 is the largest in-panel button). Keep 48–56 px buttons for the order ticket's
   submit and for phones.
3. **Type.** Geist for UI, Geist Mono for every price, size, PnL, bps, address and block number (tabular). Sora only
   for screen titles and one hero number per screen (e.g. account equity), at 700–800. Load it in the app the same way
   (`displayFont.variable` on the app shell) — it is a CSS variable, no global effect.
4. **Colour semantics.** Long/positive/healthy = `--pc-pos`, short/negative/liquidatable = `--pc-neg`,
   pending/auction/anvil = `--pc-warn`, Paraclr's own state (taken by backstop, selected lane, primary action) =
   accent. Never use green or red as decoration. PnL text uses the `-text` variants on light.
5. **Components.** Reuse the chip, dot, card, icon tile, table and accordion specs above. The solvency badge is a
   `.chipPos` (or `.chipNeg` when broken) with a dot. The auction board and X-ray matrices on the landing are the
   reference look for the app's Clearing tab (lanes `L0…L7` in mono, 9 px rounded tracks, block clock pill).
6. **Motif, sparingly.** The 8-lane stripe appears in the app only as structure: lane rows, lane tabs, the empty state
   of the auction board. No bends inside the terminal; at most one bend on full-page app marketing screens (sign-in).
7. **Labels.** Keep every network/status/simulated label the app already shows; restyle them as chips, don't drop them.
