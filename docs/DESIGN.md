# Design

Visual system for Tabglutton. Captured from `popup/tokens.css` (the single source of
truth, imported by popup, Devour cockpit, and options). Edit tokens there, not per-surface.

## Theme

Warm editorial workshop — paper and ink. A heavy reader's tool that feels like a desk, not
a dashboard. Light and dark are both first-class via `prefers-color-scheme`; `color-scheme:
light dark` is set so form controls and scrollbars follow. The cockpit adds a very low
radial paper-grain wash; everything else sits on flat paper.

The surfaces are built in two layers. **Content** — tab rows, the inspector, every options
control — is opaque paper. **Navigation** — the header and action bars, the toast — is
translucent glass floating over it. That split is the whole discipline: glass is a material
for the layer above the reading, never a skin for the reading itself, which is also what
keeps the contrast the palette has been tuned for.

In the **cockpit** that navigation layer is _detached_: rounded capsules inset from every
edge, with the queue running past them on all sides. That detachment is the point, and it
was a second pass — the first shipped full-bleed translucent bars welded to the viewport
edge, which is a vibrant toolbar, something macOS has had since Yosemite, and it read as
almost no change at all. The material is also **reactive**: the header carries none at rest,
because the queue's top padding means nothing is behind it then, and a bar tinted over
nothing is exactly the old look. It arrives once rows are actually underneath
(`body.chrome-lifted`, set from scroll position in `devour.ts`). That behaviour is the most
characteristic thing here and the one no screenshot can show.

The **popup** keeps full-bleed bars. At 600×560 detached capsules would cost gaps it has no
rows to spare, and the scroll-under moment is weak when only six rows are visible. The
asymmetry is deliberate, not drift.

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

Glass (navigation layer only):

- `--glass` — a **step deeper than the content it floats over** (warmer than `--bone` in
  light, lighter than `--paper` in dark), at ~72-75%. Tinted with `--paper` it was paper
  blurred over paper and the light theme was indistinguishable from no glass at all; a build
  with 28px blur and a 55% fill changed nothing, because the constraint was the missing value
  boundary, not the blur radius. · `--glass-blur` `saturate(180%) blur(20px)`
- `--glass-dense` / `--glass-blur-dense` — 90% fill, 30px blur, for **floating capsules**. A
  full-bleed bar reads as a surface at 75% and gets away with it; a small capsule with 13px
  row text crossing it at an arbitrary offset turns to mud. Colour still bleeds through,
  which is the part worth keeping.
- `--well` — the inset field on a glass bar (search). It steps _away_ from the bar, and which
  direction that is flips with the theme: `--paper` in light, `--bone` in dark. A
  substrate-agnostic `--hover-strong` darkening looked right and put the placeholder at
  3.3:1. Focus lifts to `--paper-raised`.
- Deepening the bar also cost the cockpit's keyboard legend its contrast — `--muted-soft`
  fell to 3.8:1 light / 4.0:1 dark against it, so the legend uses `--muted` (4.7 / 4.9).
- `--glass-rim` specular highlight on the edge facing content · `--glass-edge` the separating
  hairline · `--glass-shade` the soft lift beneath. `.u-glass` + `.u-glass-top` /
  `.u-glass-bottom` in tokens.css compose them, so popup and cockpit cannot drift on the one
  thing that has to look identical.
- `--toast-glass` / `--toast-rim` — the toast inverts with the theme (dark pill on light,
  light pill on dark).
- Both `prefers-reduced-transparency: reduce` and `@supports not (backdrop-filter)` fall back
  to an **opaque** `--paper` and set `--glass-blur: none`. Dropping only the blur would leave
  a 72%-alpha bar over a scrolling list, which is unreadable.
- The tint is deliberately warm. Neutral gray-blue glass is the system default and reads as a
  macOS impression; the terracotta wash showing through is what keeps it Tabglutton.

Usage: accent is for primary actions, current selection, and state indicators only — never
decoration. Semantic colors mean one thing each. Avoid gray on colored backgrounds.

> `--muted-soft` was darkened (light #8f8478 → #7c6f62; dark #756859 → #8a7c6b) so
> placeholder / deferred / keycap-legend text clears AA. Real favicons now carry a 1px
> `--img-ring` (pure black light / pure white dark) so they read crisp on paper.

## Typography

One bundled face, and it exists for one string.

- Display: **Young Serif** (OFL, single weight 400). The wordmark, and nothing else — popup,
  cockpit, settings and onboarding headers. Hearty wedge serifs carrying the appetite the
  product is named for; it is the one warm, human element against a chrome that is otherwise
  system sans on glass. Subsetted to Latin + common punctuation, **10 KB**. Declare and use
  weight 400: asking for 500+ would synthesise a bold.
  It replaced Vollkorn, a _text_ serif doing display work, which had also spread into section
  titles, empty states, inspector headings and the favicon letter fallback — 10px serif
  capitals inside an 18px circle, where the serifs are pure noise and the wordmark's one
  distinctive voice gets spent on a placeholder. Those are all sans now.
- UI: **the platform's own** — SF on macOS, Segoe UI Variable on Windows, via `--font-ui`.
  Ships zero bytes and renders the app in the same type as the browser around it, which is
  the point when the chrome is glass. It replaced Geist, which cost 70 KB and had become the
  house sans of AI-generated UI the same way Fraunces had become its house serif.
- Mono: system mono stack (`ui-monospace`, JetBrains Mono…). Counts, keycaps, URLs,
  frontmatter, file paths.
- **No global `font-feature-settings`.** It used to switch on Geist's `ss01 ss03 cv11 tnum`,
  which forced every display element to reset it — Vollkorn's `ss01`/`ss03` mean something
  else and silently substituted glyphs in the wordmark. The global `tnum` went with it:
  `font-variant-numeric: tabular-nums` is declared at each of the ten sites that actually
  hold an updating number, which is the only place it belongs.
- Scale (fixed px, product-appropriate): micro 10 · tiny 11 · small 12 · body 13 · lead 15
  · display 20 · hero 28. Headings that used to be serif carry 600 in the sans; body stays
  450–500.
- Tracking is tokenised, because it was the main tell that nobody owned the type. Six
  uppercase micro-labels across three surfaces each picked their own value (0.06 / 0.10 /
  0.14 / 0.16 / 0.18em); they now all use `--track-label` (0.1em). Display sizes tighten as
  they grow via `--track-lead` / `--track-display` / `--track-hero`.
- Page headers show the Tabglutton wordmark without a redundant surface label. The document title
  still identifies Settings or Devour where browser chrome needs that context.

## Layout

Both list surfaces are built the same way: **the list runs the full height of the viewport and
the bars float over it.** The chrome sits in two fixed stacks (`#chrome-top` = header +
warning banner, `#chrome-bottom` = Devour-failures panel + action bar) carrying `.u-glass`;
the scroll region pads itself clear of them, so rows genuinely travel underneath. That passage
is the only thing the glass is describing — `backdrop-filter` samples what is behind an
element _in the same document_, and an extension popup cannot blur the page beneath it, so
without content passing under a bar the effect would be decoration. It also replaces what the
cockpit used to be: three stacked opaque slabs (header / list / footer) that read as separate
blocks rather than as one tool.

The stacks' heights are not knowable from CSS — the warning and failures panels appear and
disappear inside them — so `trackChromeHeights` (`popup/lib.ts`) publishes them as
`--chrome-top` / `--chrome-bottom` via a `ResizeObserver`. Both sheets carry resting
fallbacks. In the popup those properties live on `body`, not `.surface`: the toast is a
sibling of `.surface` and would otherwise resolve `--chrome-bottom` to nothing. The scroll
region also sets `scroll-padding-block` from the same values, because keyboard nav scrolls
rows in with `block: "nearest"` and would otherwise park the focused row under the bar it
just travelled beneath.

- **Popup**: fixed 600×560. Top stack (title row, search, selection row) / full-height
  scrolling list / bottom stack (failures, action bar).
- **Cockpit**: `.cockpit-main` is `position: absolute; inset: 0`. Main is **queue-only by
  default**; `body.inspecting` (set in `devour.ts`) opens the second column to
  `minmax(0,1.4fr) minmax(340px,0.75fr)`. The inspector exists only when it has something
  to say — a focused tab, or the no-vault setup prompt. Its old resting state held nothing
  but a restatement of the footer's keyboard legend and reserved ~40% of the window to do
  it. It is opaque and sits _between_ the bars rather than under them; it is a content
  surface (frontmatter preview, save path) where glass would spend contrast to say nothing.
  The queue is capped at `max-width: 1000px` when the inspector is closed (uncapped when
  open) and **centred** — without the cap, rows stretched the full window and flung each
  group's count and Select button ~1400px from the host name they label; without the
  centring, a centred search bar sat over a hard-left list with ~600px of void beside it.
  `--edge` grows past 1620px so the whole app centres on `--content-max` (1500px) rather
  than the rows growing. Below 980px it collapses to one column, the scroll moves out to
  `.cockpit-main` so queue and inspector travel as one document, and the keyboard legend
  hides. The chrome stays fixed there too.
- **Options**: single 640px-max centered column of setting rows. No glass — it has no
  navigation layer to put it in.
- Spacing scale: 4 / 8 / 12 / 16 / 20 / 24 / 32, plus `--pad` 14 and `--gap` 10.
- Radii: 3 / 6 / 9 / `--radius-float` 26 / pill. Keep nesting concentric (outer = inner +
  padding). Cards top out at ~9px; pill is for buttons/badges/search. `--radius-float` is for
  **floating chrome only** — a detached capsule needs a radius near concentric with the pill
  controls inside it, and 9px there reads as a card that happens to be translucent rather
  than as a floating control. It does not license bigger radii anywhere in the content layer.

## Components

Shared button system: pill buttons with 1px hairline border; variants `.primary`
(accent fill), `.danger`, `.icon` (square, borderless until hover), `.quiet` (borderless,
muted). All have hover / active / disabled / focus-visible (3px accent ring) states.

- `.count-badge` — mono, tabular, pill, tinted by context.
- `.search` / `.header-search` — pill input with leading glyph and a `/` keycap hint.
- Tab row (`.tab`) — checkbox, favicon (with letter fallback), title+meta body, optional
  markers, hover-revealed actions; left accent bar on hover/focus, `.focused` for keyboard
  selection (cockpit). The markers (`keep` pill, pin icon) share one `.tab-marks` cell: the
  row is a five-column grid and a sixth child wraps onto a second line.
- Section rules (`.section-head`) — **Duplicates** then **Everything else**, an uppercase
  micro-label with a count note and a select action, no hairline. They exist because
  duplicate sets are lifted to the top of the queue as their own groups, and the list has to
  say where that section stops; the headers below it are hosts, not more duplicate sets.
- Duplicate group — same `.group` shape, headed by the canonical URL its copies share
  (`.group-key`: mono, cased, not an uppercase label, because it is an address) and an
  accent `×n` count. The surviving copy leads the set and carries a `keep` pill — accent, as
  a state indicator, not decoration.
- Inspector — sectioned preview (head, "Will save to" path, frontmatter `<pre>`, routing
  `<dl>`), uppercase micro section labels.
- Options — custom toggle `.switch`, `.radio-card` (selected = accent border + soft fill),
  text inputs (6px radius), inline status pill.
- Agent bridge port selection reuses `.radio-card`: **Automatic** is the recommended default;
  **Fixed port** reveals the numeric field. Automatic status names the discovered endpoint
  (`Connected on 20317`) and never turns a skipped foreign candidate into a blocking error.
- Toast — glass pill, fixed bottom-center, with Undo; slide-up enter. It inverts with the
  theme and rides above `--chrome-bottom` rather than at a fixed offset, which the
  Devour-failures panel used to grow up behind. It was already floating over content, so
  glass costs it nothing structural.
- Chrome stacks — `.chrome` positions and insets; in the **popup** the stack owns the
  material (`.u-glass` + `.u-glass-top` / `.u-glass-bottom`), in the **cockpit** the capsules
  inside it do (`.u-glass-float` for the all-round rim, since a detached object shows all
  four edges). Either way the bars dropped the `background: var(--paper)` and hairline
  borders they used to draw themselves.
- Cockpit action bar — two floating capsules: `[Devour · Copy URLs · Dedup | Close]` and the
  keyboard legend. Close sits inside the first behind an `.action-divider` so a destructive
  control still reads as separate without being a third floating object; `order` places it
  after the actions visually while leaving it last in the DOM, where it belongs in the tab
  sequence. **`.action-bar` is `pointer-events: none` with its capsules `auto`** — it still
  spans the full width while only two capsules are visible, and would otherwise swallow every
  click on the rows behind that empty space. Detaching chrome means its box stops matching
  what you can see of it, and anything else added there needs the same treatment.
- `.queue` carries a `mask-image` fade at both ends. Detached chrome means content is visible
  above the header and below the actions, and a 12px band of a half-drawn row there reads as
  a rendering fault rather than as depth.

## Motion

- Tokens: `--easing` cubic-bezier(.2,.8,.2,1) (ease-out), `--easing-soft`; durations
  fast 120 / base 180 / slow 320.
- Patterns: surface fade-in on open; staggered group-in on first load (~20–24ms step);
  hover/selection background transitions; devour progress via a `::before` width fill;
  toast slide-up. No bounce, no decorative motion.
- A row must not change size on hover. The cockpit used to unclamp a truncated `.tab-title`
  to a full wrap on `:hover`, which grew the row and shoved every row below it out from under
  the cursor — in a list built for fast keyboard triage, the one place a layout must not
  move. The inspector already shows the whole title, and the row keeps its tooltip.
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
