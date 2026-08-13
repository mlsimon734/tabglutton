# Store listing reference

Listing copy, store-platform findings, and the image pipeline for Tabglutton on
addons.mozilla.org (AMO) and the Chrome Web Store. Reference material, not a tracker: what
is left to do on any given day belongs in an issue, not in checkboxes here that go stale
between readings. AMO is live at `0.3.1`; Chrome has not been submitted.

▸ **Gullet's npm publish is gated on the extension being live, not the other way round.**
`bunx tabglutton-gullet` is what the options page, `gullet/README.md`, and the r/mcp launch
post all tell people to run — and the package has never been published, so every one of
those instructions 404s today. The protocol half of that gate is now clear: AMO serves
`0.3.1`, which is wire protocol 2, so a published sidecar would no longer refuse the
handshake for Firefox users. Chrome is still unsubmitted, so anyone who finds the extension
there later would meet the same mismatch in reverse.

The two versions are deliberately kept equal — extension `0.3.1` ships with Gullet `0.3.1`
— so "keep them on the same version" is a rule a user can actually follow. Encoding the
wire protocol in the npm major was considered and dropped: the package was already `0.1.0`
at protocol 2, and a version that tracks neither the product nor the protocol helps nobody.

---

## 1. Standing constraints

These bind every release, not just the first one.

- **Keep the extension ID `tabglutton@addons.local`.** Changing it creates a second AMO
  entry, orphans every existing install, and resets stored settings. Users never see it.
- **AMO submissions must include source.** `build.ts` sets `minify: true`, so the reviewed
  code is machine-generated, and AMO requires the original plus reproducible build
  instructions whenever that is true. `bun run package` emits
  `web-ext-artifacts/tabglutton-source-<version>.zip` via `git archive`. The source step is
  **after** the button labelled "Submit Version", not alongside the package — see §3.
- **The submission flow defaults to the wrong channel, and states it rather than asking.**
  The upload page prints the current choice as prose ("On your own.") with a small `Change`
  link, and the file picker sits directly beneath it. The actual radios live on a separate
  page, and the default is sticky from the last submission — which for this add-on is every
  `sign:dev` build ever signed, all unlisted. `0.3.0` was lost to this. Always start a store
  submission from the URL that arrives preselected:

  ```
  https://addons.mozilla.org/en-US/developers/addon/tabglutton/versions/submit/distribution?channel=listed
  ```

- **Versions must be unique and strictly increasing on AMO**, and Firefox compares
  `0.1.3 < 0.1.3.1` — so the four-part `sign:dev` builds already consumed a range the
  release version has to clear. This is why the first listed version was `0.2.0` rather than
  `0.1.3`. Mechanics are in `AGENTS.md` § Versioning.
- **Uniqueness spans both channels, and a version's channel is fixed forever.** Measured:
  after `0.3.0` went out unlisted, uploading the identical package to the listed channel
  answers "Version 0.3.0 already exists." There is no promote action, deleting a version
  does not free its number, and the listed release therefore had to become `0.3.1`. A
  number spent on the wrong channel is spent.
- **Privacy policy** is `https://github.com/mlsimon734/tabglutton/blob/main/PRIVACY.md`.
  Chrome requires a URL and accepts a GitHub-hosted one; AMO takes the same text inline.

---

## 2. Shared listing copy

### Name

```
Tabglutton
```

Chrome permits 75 characters and search leans on the name, but a descriptor suffix reads as
keyword-stuffing and the store's own guidelines discourage it. Keep it clean on both.

### Short description

**Chrome Web Store** (132 char limit — this is 118):

```
Close duplicate tabs, and file the keepers into Obsidian as clean markdown. Optional local MCP bridge for coding agents.
```

**AMO summary** (250 char limit — this is 212):

```
Close duplicate tabs by canonical URL, and file the keepers into your Obsidian vault as clean markdown before closing them. Includes an optional local MCP server so a coding agent can triage your tabs. No telemetry, no account.
```

### Full description

Paste as-is into both stores. The one Firefox-only line is marked; drop it for Chrome.

```
You open thirty tabs a day out of mild interest. Some are honest duplicates — the same
thread reached from two links, the same repo opened twice. Most are things you have
already mentally finished but don't want to lose. They belong in a notes vault, not in the
tab strip. So they sit there, and by Friday there are four hundred of them.

Tabglutton does three things about that.


DEDUP

The toolbar badge counts duplicate tabs. Open the popup to see them grouped by canonical
URL, then close them all in one action.

URLs are canonicalized before comparison: lowercased host, "www." and trailing slash
stripped, tracking parameters (utm_*, fbclid, gclid, si, …) dropped, remaining parameters
sorted, and optionally the #fragment removed. So two links to the same page match even
when they don't look alike.

The tab you touched most recently is the one kept. A toast offers Undo for six seconds and
restores closed tabs to their original positions.


DEVOUR — INTO OBSIDIAN

Select the tabs worth keeping and press Devour. Each one is read through Defuddle — the
same extractor behind Obsidian's own Web Clipper — formatted as markdown with frontmatter
(title, source URL, author, site, published date), filed into your vault under Clippings/,
and closed.

The full-screen Devour cockpit is the workspace for it: tabs grouped by host, an inspector
showing exactly where each note will land, and keyboard triage throughout. j/k to move,
space to select, d to devour, x to close, / to filter.


AGENT BRIDGE (OPTIONAL)

This is the part that isn't like other tab extensions.

Tabglutton ships a local MCP server. Turn the bridge on in settings, point Claude Code or
Codex at it, and your agent can work your actual open tabs — list them, wake the ones the
browser unloaded, read them, clip the good ones into Obsidian, close the noise. "Go
through my 400 tabs, tell me what's worth keeping, and clear the rest" becomes something
you can simply ask for.

It is deliberately hard to make dangerous. The bridge is off until you enable it. It binds
to loopback only, authenticates with a token you generate that never crosses the wire, and
checks the extension's origin. Waking tabs is a second, separate opt-in. Nothing is ever
closed that Undo could not put back.


PRIVACY

No analytics, no telemetry, no remote server, no account. Page content is extracted in
your browser and goes to exactly two places, both on your own machine: your Obsidian
vault, and — only if you turn the bridge on — a local MCP server. The developer receives
nothing.

The full source is public: https://github.com/mlsimon734/tabglutton


[FIREFOX/AMO ONLY — drop this section for Chrome]
ZEN BROWSER

Zen gives extensions no workspace API, so "active workspace" scope is a heuristic
(tab.hidden === false). If it misreads, the popup tells you and you can switch to
current-window scope in settings.
```

---

## 3. AMO (addons.mozilla.org)

| Field              | Value                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------ |
| Add-on name        | Tabglutton                                                                                 |
| Summary            | §2 AMO summary                                                                             |
| Description        | §2 full description, including the Zen section                                             |
| Category (Firefox) | **Tabs**                                                                                   |
| Category (Android) | **Tabs** — the manifest declares `gecko_android` min 142                                   |
| Support site       | `https://github.com/mlsimon734/tabglutton`                                                 |
| Support email      | your preference                                                                            |
| Privacy policy     | paste `PRIVACY.md` text inline                                                             |
| License            | MIT                                                                                        |
| Channel            | **Listed** (the existing add-on's unlisted history is unaffected)                          |
| Tags               | pick from AMO's fixed vocabulary; `tabs`, `productivity`, `bookmarks` are the closest fits |

### The version-upload flow, in the order it actually happens

Measured on the `0.3.1` submission. The step order is not what it looks like from the first
page, and the source upload is not where the wording implies.

1. **Distribution.** Start at `…/versions/submit/distribution?channel=listed` so the right
   radio is preselected. Reaching the upload page any other way inherits the last channel
   used, which is unlisted. Confirm the page reads "On this site." before going on.
2. **Upload package** — `tabglutton-firefox-<version>.zip`. Validation runs immediately.
   Expect "no errors and 3 warnings": two are the generic submission checklist, the third is
   `Unsafe assignment to innerHTML`, which is `onboarding.ts`'s `rulesList.innerHTML = ""`
   plus bundled Defuddle's `textarea`/`template` decode helpers. Neither takes untrusted
   input; no tab title or clipped content is ever assigned to `innerHTML`.
3. **Compatibility** — Firefox and Firefox for Android arrive pre-checked. Leave both.
4. **Describe Version** — release notes (public, shown on the listing) and notes to
   reviewer (§3 below). There is **no source field on this page**, which is misleading,
   because the page's own text talks about source code submission here.
5. **"Submit Version"** — despite the name, this is not the last step.
6. **Source code** — _now_ it asks whether the extension uses minifiers or bundlers. Answer
   **yes** and upload `tabglutton-source-<version>.zip`, then **Continue**. This is the
   final step; the next page says "Version Submitted".

Automated validation published `0.3.1` without manual review. Confirm the channel actually
took by querying the API rather than trusting the success page — `filter=all_with_unlisted`
on `/api/v5/addons/addon/<id>/versions/` returns each version's `channel` and `status`.

### Data collection disclosure

`manifest.json` already declares:

```json
"data_collection_permissions": { "required": ["none"] }
```

This is accurate and should be left alone. AMO's definition scopes "collection" to data
transmitted to the developer or a third party; sending a clipping to the user's own local
Obsidian vault or their own local MCP server is neither. Answer **"Does not collect"** on
every category in the form so it matches the manifest.

### Notes to reviewer

Paste verbatim:

```
BUILD

This add-on is written in TypeScript and compiled + minified by Bun, so the packaged code
is machine-generated. The full source is attached, and is also public at
https://github.com/mlsimon734/tabglutton

Toolchain: Bun 1.3.14 (https://bun.sh) is the only dependency. Tested on macOS; any Unix
works.

  unzip tabglutton-source-<version>.zip
  bun install
  bun run build:firefox

This produces dist-firefox/, which is the contents of the uploaded package. External
sourcemaps are emitted next to each bundle.

NOTES

- manifest.json in the source is the Firefox manifest and is used unchanged. build.ts
  patches a copy in memory for the Chrome target only; that path is not exercised by the
  command above.
- No remote code is loaded, fetched, or evaluated at runtime. Everything that executes is
  in the package.
- Third-party code bundled into the clip content script: Defuddle (MIT), the article
  extractor also used by Obsidian's official Web Clipper. Bundled fonts: Vollkorn and
  Geist, both SIL OFL. All three licenses ship in the package under THIRD_PARTY_LICENSES/.
- The gullet/ directory in the source is an optional sidecar (a local MCP server, run by
  the user's own agent tooling). It is excluded from the extension build via
  tsconfig.json and never reaches dist-firefox/.

PERMISSIONS

- host_permissions "*://*/*" is needed to inject the article extractor
  (src/clip-current.ts) into a page the user has chosen to clip. There are no declared
  content_scripts; injection happens only via scripting.executeScript, only against a
  specific tab, and only in response to an explicit user action or an explicit agent tool
  call. The extension does not read pages the user has not selected.
- clipboardWrite is used to hand a long note body to Obsidian, because an obsidian:// URL
  cannot carry a full article. It writes only during an explicit clip.
- downloads writes the clipped note as a markdown file when the user has chosen the file
  destination instead of an Obsidian vault, so the extension is usable without Obsidian.
  It writes only during an explicit clip, only into the browser's own download folder, and
  never reads or opens an existing download.
- alarms drives the reconnect timer for the optional agent bridge, and is inert while the
  bridge is disabled (the default).

AGENT BRIDGE

Off by default; no socket is opened while it is off. When enabled it connects to
ws://127.0.0.1:<port> only. Both ends authenticate against a user-generated shared token
using a nonce challenge, so the token never crosses the wire, and the server validates the
extension origin. Rationale and wire protocol: docs/BRIDGE.md in the source.

Note that manifest.json declares content_security_policy.extension_pages explicitly. This
is load-bearing: Firefox's default MV3 CSP includes upgrade-insecure-requests, which
rewrites ws://127.0.0.1 to wss:// and breaks the loopback connection.
```

---

## 4. Chrome Web Store

Not yet submitted. Publishing requires a developer account, which carries a one-time **$5
USD** registration fee; AMO is free.

| Field              | Value                                                           |
| ------------------ | --------------------------------------------------------------- |
| Item name          | Tabglutton                                                      |
| Short description  | §2 Chrome short description                                     |
| Detailed descr.    | §2 full description, minus the Zen section                      |
| Category           | Productivity → **Workflow & Planning**                          |
| Language           | English (United States)                                         |
| Homepage URL       | `https://github.com/mlsimon734/tabglutton`                      |
| Support URL        | `https://github.com/mlsimon734/tabglutton/issues`               |
| Privacy policy URL | `https://github.com/mlsimon734/tabglutton/blob/main/PRIVACY.md` |
| Visibility         | Public                                                          |

### Single purpose statement

```
Tabglutton's single purpose is managing the user's open browser tabs: finding and closing
duplicates, and saving selected tabs to the user's own notes application before closing
them. Every feature operates on the user's tab list. The optional local bridge exposes
those same tab operations to a coding agent running on the user's own machine; it adds no
capability the extension does not already have through its own UI.
```

### Permission justifications

Paste one per field.

**`tabs`**

```
The extension's core function is finding duplicate tabs and presenting the tab list for
triage. Both require reading the title and URL of the user's open tabs. It is also how the
undo log records enough about a closed tab to reopen it.
```

**Host permission `*://*/*`**

```
Needed to inject the article extractor into whichever page the user chooses to clip into
their notes vault. Users clip arbitrary pages, so the set of hosts cannot be declared in
advance.

This is a capability, not a behaviour: the extension declares no content_scripts and runs
nothing on page load. Injection happens only through scripting.executeScript, against one
specific tab, in direct response to the user pressing Devour or explicitly asking their
own local agent to read that tab. Pages the user has not selected are never read.
```

**`scripting`**

```
Used with scripting.executeScript to run the article extractor inside the specific tab the
user selected for clipping.
```

**`activeTab`**

```
Lets the user clip the tab they are looking at directly from the popup.
```

**`storage`**

```
Persists user settings (Obsidian vault name, URL normalization preferences, scope) and the
undo log that makes tab closures reversible. Local only; never synced.
```

**`clipboardWrite`**

```
Obsidian receives a clipped note's body via the system clipboard, because an obsidian://
URL cannot carry a full article. Written only during an explicit clip action.
```

**`alarms`**

```
Drives the reconnect timer for the optional local agent bridge. Inert while the bridge is
disabled, which is the default.
```

**`downloads`**

```
Saves a clipped page as a markdown file in the browser's download folder, for users who
have chosen the file destination instead of an Obsidian vault. Written only during an
explicit clip; existing downloads are never read or opened.
```

**Remote code**

```
No, I am not using remote code.
```

All executed code ships in the package.

### Data usage disclosure

Tick **nothing** in the collected-data categories, then affirm all three certifications:

- Not being sold to third parties, outside of the approved use cases — ✅
- Not being used or transferred for purposes unrelated to the item's single purpose — ✅
- Not being used or transferred to determine creditworthiness or for lending — ✅

### Known review risks, and the answers

| Risk                                                                       | Response                                                                                                                                         |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Broad host permission triggers extra scrutiny                              | The justification above is the case: no declared content scripts, injection only on explicit user action. Expect one clarification round.        |
| "Single purpose" challenged because the bridge looks like a second product | Answer with the single-purpose statement: the bridge exposes existing tab operations, it does not add a feature.                                 |
| Opening a local WebSocket flagged as suspicious                            | Loopback only, off by default, token-authenticated, source public. Point at `docs/BRIDGE.md`.                                                    |
| First-submission review latency                                            | Budget up to a couple of weeks for a first item with broad host permissions. AMO is usually days. Do not schedule launch posts before both land. |

---

## 5. Screenshots

### Specs

| Store  | Required                                                                        |
| ------ | ------------------------------------------------------------------------------- |
| Chrome | **exactly 1280×800** or 640×400, PNG or JPEG, at least 1, up to 5               |
| Chrome | small promo tile 440×280 PNG — ✅ `promo-tile-440x280.png`                      |
| Chrome | icon 128×128 PNG — read from the package, `icons/icon-chomp-128.png`            |
| AMO    | screenshots PNG/JPEG, not animated, under 4 MB; 1280×800 is a good default      |
| AMO    | icon square PNG/JPEG, ≥ 128×128 — ✅ `amo-icon-512.png`, a Developer Hub upload |

The two existing captures in `docs/media/` are 2880×1800 retina grabs. Same 1.6 aspect
ratio as 1280×800, so they downscale cleanly — see `docs/media/store/` for the resized
pair.

### The icon is the extension's own mark, not a second one

`icons/icon-chomp.svg` used to be a different drawing from the one the product shows: a
fanned stack of three pages, where every surface in the extension renders the tab-with-a-
cookie-bite silhouette from `icons/logo-mark.svg`. Nobody notices while building, because
the toolbar icon and the popup header are never in frame together — it took seeing the AMO
listing beside the popup to catch that the store was advertising a mark the product does
not use.

The icon is now that same silhouette. It cannot import it — an icon is rasterized standalone
with no stylesheet — so the geometry is duplicated, which is also true of the promo tile,
which inlines it to stay a single `file://`-renderable page. Three copies, pinned to each
other by `tests/logo-mark.test.ts` rather than by a comment asking for discipline.

Two deliberate differences in the icon: `logo-mark.svg` is monochrome `currentColor` because
each surface tints it per theme, and an icon has no theme, so it commits to the light-theme
pairing (accent `#7a4a2c` ground, bone `#f4efe6` figure) — the pairing that holds on both
light and dark browser chrome. And the 0.18-opacity white edge stroke is dropped, since it
exists to separate the mark from a page behind it.

**The icon is drawn twice, because 16px cannot hold the full drawing.** Scaled down, the
chips became sub-pixel specks that only lowered the contrast of the fill keeping the
silhouette readable. `icons/icon-chomp-small.svg` drops them and takes the room back as a
larger glyph (44 units tall against 40); the silhouette and bite are byte-identical to the
canonical mark, and the test pins the missing chips as deliberate so restoring them means
arguing with a test.

The bite keeps all seven mask circles at small size even though they step visibly at 16px. A
three-circle version was tried and reads as a nick rather than a bite — the stepping costs
less than losing the one thing that makes the mark a _chomped_ tab.

Sizes 16 and 32 come from the small drawing, 48 and 128 from the full one. Regenerate with
`bun scripts/rasterize-icons.ts`, which exists for that mapping — rasterizing all four from
one source is the obvious thing to do by hand and silently discards the per-size work.
Firefox declares both in `manifest.json` (`action.default_icon` and `icons` each carry 16/32
→ small, 48+ → full); Chrome needs no `build.ts` change, since it already points at the
PNGs.

### AMO listing images are not in the package — and the icon never was

**0.2.0 went live with a placeholder icon and no screenshots.** Both are listing fields,
not package contents, and nothing about the upload prompted for them, so an otherwise
complete submission looked finished while the product page was blank. Fixing it needs no
new version and no re-review: it is Developer Hub → **Edit Product Page → Images**.

`bun scripts/amo-listing-images.ts` does the whole set through AMO's own API instead —
maintainer-only, since it authenticates as the add-on's owner with the same
`WEB_EXT_API_KEY` / `WEB_EXT_API_SECRET` from `.env` that `sign:dev` uses (an AMO API key is
one credential per account, not one per purpose). `--verify` reports the live state without
changing anything, `--icon-only` / `--previews-only` narrow the run, and `--replace` is the
escape hatch for a listing that was edited by hand. It reconciles against the listing rather
than tracking progress locally, so re-running it after any interruption uploads only what is
missing — which is the normal path, not the exceptional one, for the throttle reasons below.

The icon is the surprising half. AMO does **not** read the `icons` key of `manifest.json`
at all — verified against `addons-server`, not inferred. `Addon.icon_type` is written in
exactly one place, `AddonFormMedia` in `src/olympia/devhub/forms.py`, whose
`ICON_TYPES` is `[('', 'default'), ('image/jpeg', 'jpeg'), ('image/png', 'png')]`; no
manifest-parsing path touches it, and an empty `icon_type` makes `get_icon_url` return
`img/addon-icons/default-<size>.png`, the generic puzzle piece. So this is not the
SVG-versus-PNG question it looks like — a PNG in the manifest would have produced the same
placeholder. (SVG would be refused on its own terms too: the upload validator answers
"Icons must be either PNG or JPG.")

Constraints, from `src/olympia/constants/base.py` and `devhub/views.py`:

- Icon: PNG or JPEG, not animated, under 4 MB. AMO derives 32/64/128 from it
  (`ADDON_ICON_SIZES`) and keeps the original, so upload larger than 128 — hence
  `amo-icon-512.png`, rendered from `icons/icon-chomp.svg` with
  `rsvg-convert -w 512 -h 512`, the same source `build.ts` rasterizes for Chrome.
- Screenshots: PNG or JPEG, not animated, under 4 MB each. The stricter rules — ≥ 1000×750
  and an exact **4:3** ratio — sit behind the `content-optimization` waffle switch, which
  production has off (the store's own guidance recommends 1280×800, which is 16:10). If an
  upload is ever rejected with "Image dimensions must be in the ratio 4:3", that switch is
  the reason and the whole set needs re-cutting, not one image.
- AMO thumbnails previews at 533×400 (4:3) and caps the full image at 2400×1800, so the
  16:10 shots letterbox in the carousel strip and render whole when opened.

All seven images already exist in `docs/media/store/`; the popup pair goes here and only
here, per the sizing decision below. Upload order, since AMO leads with the first:

1. `cockpit-light-1280x800.png` — the lead
2. `popup-light.png` — the surface a user actually touches
3. `cockpit-inspector-light-1280x800.png` — where the note lands
4. `obsidian-note-1280x800.png` — the outcome
5. `cockpit-dark-1280x800.png`
6. `popup-dark.png`
7. `cockpit-inspector-dark-1280x800.png`

Light first and dark grouped at the end, rather than alternating: the carousel is read
left to right and a theme flip mid-sequence reads as a different product.

**AMO throttles writes on two clocks, so a full image run does not fit in one sitting.** A
burst limit refuses after about three writes and clears in under a minute; an hourly cap
sits behind it and answers "available in 3475 seconds". Nine writes — one icon and eight
screenshots — therefore span two sittings by design, and neither limit is a failure. Wait
out the first and re-run for the second; a run reconciles against the listing and uploads
only what is missing. Note also that AMO resizes the icon in a background task, so the
`icon_url` hash on the detail endpoint still reports the _previous_ icon for a few seconds
after a successful upload — re-read it before concluding the upload was a no-op.

### Shot list

All five slots are filled. The set lives in `docs/media/store/`.

1. ✅ **Devour cockpit, light** — tabs grouped by host, duplicates flagged. Lead image.
2. ✅ **Devour cockpit, dark** — same view, proves the theme.
3. ✅ **Popup with duplicates found** — `popup-{light,dark}.png`, **AMO only**; 1200×1200
   cannot meet Chrome's exact 1280×800, see the sizing note below. 600×600 logical at 2×,
   which is the height Chrome actually caps a popup at. Shows the Dedup pill reading 5 and
   the three `kepano/defuddle` rows (one `utm`-tagged) that produce it.
4. ✅ **Cockpit inspector on one tab** — `cockpit-inspector-{light,dark}-1280x800.png`.
   Inspector focused on an arXiv paper, showing `test / Clippings / ….md` and the
   frontmatter preview. This is what makes "files into Obsidian" concrete.
5. ✅ **Obsidian, immediately after a Devour** — `obsidian-note-1280x800.png`. The
   `kepano/defuddle` clipping open in the `test` vault, dark, with the Properties block
   populated (title, source, author, created, description, `clippings` tag). Sells the
   outcome rather than the mechanism. Native app, so it was captured by hand; the
   full-resolution original is kept as `obsidian-note-original.jpg` because unlike the
   other four it cannot be regenerated from a script. Downscale recipe:
   `sips -s format png -Z 1280 in.jpg --out a.png && sips -s format png -c 800 1280 a.png
--out out.png` — the `-s format png` is load-bearing, since `sips` otherwise writes
   JPEG bytes under a `.png` name and only warns.

   **Two things to decide before this ships.** The note's filename is the most prominent
   text in the frame, and it reads `kepanodefuddle Get the main content of any page as
Markdown.` — the slash stripped with no separator. That is correct behaviour and matches
   Obsidian Web Clipper exactly (see `sanitizeFileName` in `src/clip-format.ts`), but it is
   the least flattering filename the product produces and it is the first thing a viewer's
   eye lands on. Second, the file tree beside it carries test detritus — `Web browser 1/2/3`,
   `Service worker 1`, a bare `y`, three copies of the same Dario Amodei note. Cleaning the
   `test` vault's `Clippings/` and `inbox/` and re-shooting on a subject whose title has no
   `/` in it would fix both; shipping as-is is defensible but concedes the first impression.

**Popup sizing — decided: the popup ships on AMO, not on Chrome.** The popup is 600px wide,
so `popup-{light,dark}.png` is 1200×1200 and cannot satisfy Chrome's _exact_ 1280×800. AMO
has no fixed size, so it goes there unchanged.

The Chrome five therefore become cockpit light, cockpit dark, inspector light, inspector
dark, and the Obsidian note — every one a native 1280×800 capture, verified with `sips`
rather than trusted from the filename. Be clear about what that spends: the popup's slot
goes to a second theme variant of a view already shown, and on merit the popup is the
better image — it is the surface a user touches daily, and it is now absent from the
Chrome listing entirely. It is traded away because the alternative is worse _right now_:
compositing onto a `--bone` 1280×800 canvas would make it the only padded image among four
full-bleed ones, and the "raw vs composited for the whole set" decision that would force
was never actually written down — the sentence that used to sit here pointed at a section
below that does not exist, and the promo tile follows instead. Do not go looking for it.

Worth doing after launch, not before: replace `cockpit-inspector-dark` with a real popup
shot — a hand-captured 1280×800 browser window with the popup anchored under the toolbar
icon, the way `obsidian-note` was taken. Chrome's toolbar popup is browser UI and not
reachable from CDP, so it cannot be scripted, and store listings are editable at any time.
That is a better five than this one; it is not worth blocking 0.2.0.

### Promo tile

`docs/media/promo-tile.html` → `bun scripts/shoot-promo-tile.ts` → `promo-tile-440x280.png`.
Committed source rather than a one-off export, so the tile can be re-rendered when the
palette or wordmark moves. It uses the **dark** theme: the store's own chrome is white, so a
bone tile dissolves into it, and dark is a real Tabglutton surface rather than an invented
one. Built to the store's rules — canvas filled edge to edge, no transparency, no shrunk-down
UI screenshot, no call to action, no Chrome/Google branding.

Two traps the script exists to hold, both documented in its header: `@font-face` with a
relative URL fetches nothing from a `file://` page (every such document is its own opaque
origin, so the tile silently renders in Times), and Chrome 151's `--headless` writes the
screenshot in about a second and then sits for two to three minutes before exiting — so the
script polls the PNG for a stable size and kills Chrome rather than awaiting it. Warm run is
~2.5s and byte-identical between runs.

**Capture method.** `scratch-chrome/shoot-store.ts` (dark) and `shoot-light.ts` (light)
drive CDP's own screenshot path — exact pixels, no window chrome, no Screen Recording
permission, repeatable after any UI change. Re-run them after the 0.2.0 version bump if
anything visible changed.

One trap worth keeping: sites serve colour-scheme-conditional favicons. GitHub ships
`favicon-dark.svg`, a **white** glyph, whenever the page rendered under dark mode. Shooting
the extension in light theme while the content tabs had loaded dark puts white icons on
white paper and they vanish. `shoot-light.ts` flips every content tab to light and reloads
first, so the light variants are fetched; it asserts zero tabs still report a dark-variant
favicon before capturing.

Optional but high-value for the launch posts, not the stores: a ~20s screen recording of
the cockpit emptying a real backlog (filter → select → Devour → notes landing in Obsidian
→ Undo). The README already has a slot reserved for it at `docs/media/demo.gif`.
