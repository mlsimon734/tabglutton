# Design

Visual system for Tabglutton. Captured from `popup/tokens.css` (the single source of
truth, imported by popup, Devour cockpit, and options). Edit tokens there, not per-surface.

## Theme

Warm editorial workshop — paper and ink. A heavy reader's tool that feels like a desk, not
a dashboard. Light and dark are both first-class via `prefers-color-scheme`; `color-scheme:
light dark` is set so form controls and scrollbars follow. The cockpit adds a very low
radial paper-grain wash; everything else sits on flat paper.

## Color

OKLCH not used today; palette is authored in hex/rgba. Warmth is carried by the accent and
ink, with a near-white paper substrate (intentional here — it is the "desk", and identity
is carried by type + accent, not a saturated body).

Light:

- `--bone` #f4efe6 (app backdrop) · `--paper` #fbf8f3 (surface) · `--paper-raised` #ffffff
- Ink ramp: `--ink` #1b1614 · `--ink-soft` #3a322d · `--muted` #6f6155 · `--muted-soft` #7c6f62
- Hairlines: `--hairline` rgba(27,22,20,.10) · `--hairline-strong` rgba(27,22,20,.18)
- Hover: `--hover` rgba(27,22,20,.04) · `--hover-strong` rgba(27,22,20,.07)
- Accent (terracotta): `--accent` #7a4a2c · `--accent-ink` #fbf8f3 · `--accent-soft` 12% ·
  `--accent-ring` 32%
- Semantic: `--danger` #9b3a2b (+soft/ring) · `--success` #4f6a3a (+soft)

Dark:

- `--bone` #16110e · `--paper` #1d1814 · `--paper-raised` #241e19
- Ink ramp: #f0e6d6 / #d6c9b6 / #9a8a7a / #8a7c6b
- Accent warms to #d89456; danger #d67560; success #a3b389.

Usage: accent is for primary actions, current selection, and state indicators only — never
decoration. Semantic colors mean one thing each. Avoid gray on colored backgrounds.

> `--muted-soft` was darkened (light #8f8478 → #7c6f62; dark #756859 → #8a7c6b) so
> placeholder / deferred / keycap-legend text clears AA. Real favicons now carry a 1px
> `--img-ring` (pure black light / pure white dark) so they read crisp on paper.

## Typography

Pairing on a contrast axis (serif display + sans UI), one weight range each.

- Display: **Vollkorn** (variable, `wght` 400–900 only — no optical-size axis). Used for
  the wordmark, section titles, empty-state and inspector headings, and the letter
  fallback for missing favicons. A warm, sturdy text serif; it replaced Fraunces, which
  had become the house serif of AI-generated UI and read as such.
- UI: **Geist** (variable). Body, labels, buttons, tab rows, settings.
- Mono: system mono stack (`ui-monospace`, JetBrains Mono…). Counts, keycaps, URLs,
  frontmatter, file paths.
- Body features: `ss01 ss03 cv11 tnum` on; `tabular-nums` explicitly on any updating number.
  **Display type must reset `font-feature-settings: normal`** — those are Geist's sets, and
  Vollkorn has its own `ss01`/`ss03` meaning something else, so inheriting them silently
  substitutes glyphs in the wordmark.
- Scale (fixed px, product-appropriate): micro 10 · tiny 11 · small 12 · body 13 · lead 15
  · display 20 · hero 28.
- Tracking is tokenised, because it was the main tell that nobody owned the type. Six
  uppercase micro-labels across three surfaces each picked their own value (0.06 / 0.10 /
  0.14 / 0.16 / 0.18em); they now all use `--track-label` (0.1em). Display sizes tighten as
  they grow via `--track-lead` / `--track-display` / `--track-hero`, which is the job the
  dropped `opsz` axis used to do.
- Page headers show the Tabglutton wordmark without a redundant surface label. The document title
  still identifies Settings or Devour where browser chrome needs that context.

## Layout

- **Popup**: fixed 600×560, vertical flex — header (title row, search, selection row) /
  scrolling tab list / footer action bar.
- **Cockpit**: full-viewport grid `auto auto 1fr auto auto`. Main is **queue-only by
  default**; `body.inspecting` (set in `devour.ts`) opens the second column to
  `minmax(0,1.4fr) minmax(340px,0.75fr)`. The inspector exists only when it has something
  to say — a focused tab, or the no-vault setup prompt. Its old resting state held nothing
  but a restatement of the footer's keyboard legend and reserved ~40% of the window to do
  it. The queue is capped at `max-width: 1000px` when the inspector is closed (uncapped
  when open): without the cap the collapsed state stretched rows the full window and flung
  each group's count and Select button ~1400px from the host name they label.
  `--edge` grows past 1620px so the whole app centres on `--content-max` (1500px) rather
  than the rows growing. Collapses to one column below 980px; the keyboard legend hides
  there.
- **Options**: single 640px-max centered column of setting rows.
- Spacing scale: 4 / 8 / 12 / 16 / 20 / 24 / 32, plus `--pad` 14 and `--gap` 10.
- Radii: 3 / 6 / 9 / pill. Keep nesting concentric (outer = inner + padding). Cards top out
  at ~9px here; pill is for buttons/badges/search.

## Components

Shared button system: pill buttons with 1px hairline border; variants `.primary`
(accent fill), `.danger`, `.icon` (square, borderless until hover), `.quiet` (borderless,
muted). All have hover / active / disabled / focus-visible (3px accent ring) states.

- `.count-badge` — mono, tabular, pill, tinted by context.
- `.search` / `.header-search` — pill input with leading glyph and a `/` keycap hint.
- Tab row (`.tab`) — checkbox, favicon (with letter fallback), title+meta body, optional
  pin icon, hover-revealed actions; left accent bar on hover/focus, `.focused` for keyboard
  selection (cockpit).
- Inspector — sectioned preview (head, "Will save to" path, frontmatter `<pre>`, routing
  `<dl>`), uppercase micro section labels.
- Options — custom toggle `.switch`, `.radio-card` (selected = accent border + soft fill),
  text inputs (6px radius), inline status pill.
- Toast — dark pill, fixed bottom-center, with Undo; slide-up enter.

## Motion

- Tokens: `--easing` cubic-bezier(.2,.8,.2,1) (ease-out), `--easing-soft`; durations
  fast 120 / base 180 / slow 320.
- Patterns: surface fade-in on open; staggered group-in on first load (~20–24ms step);
  hover/selection background transitions; devour progress via a `::before` width fill;
  toast slide-up. No bounce, no decorative motion.
- `prefers-reduced-motion: reduce` zeroes animations/transitions globally in tokens.css.

## Iconography

Inline SVG, 1.4px stroke, round caps/joins, `currentColor`, 16-unit viewBox for UI glyphs
(settings, cockpit-expand, search). Brand marks: the in-UI wordmark mark `logo-mark.svg` is a
browser tab — a rounded trapezoid handle rising off the body, with a chocolate chip inside the
handle where the favicon would sit — with a scalloped cookie bite munched out of the top-right
corner and chocolate-chip flecks across the body (monochrome `currentColor` body with dark-brown
chip accents, fetched into the popup/cockpit/settings headers). The toolbar icon
`icon-chomp.svg` is still the terracotta page-stack + bite (PNGs rasterized from it for Chrome).
NOTE: the two concepts now diverge (tab vs page-stack) — unify by redrawing `icon-chomp.svg`
and regenerating its PNGs if full mark consistency is wanted. Keep one icon family per surface.
