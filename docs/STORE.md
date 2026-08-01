# Store submission pack

Everything needed to list Tabglutton on addons.mozilla.org (AMO) and the Chrome Web Store.
Copy below is paste-ready; decisions that must be settled before uploading are up top.

---

## 1. Decide these first

### Version — release as `0.2.0`, not `0.1.3`

Nine unlisted dev builds have already been signed against this add-on, up to **`0.1.3.9`**
(local tags `v0.1.1` … `v0.1.3.9`). AMO requires an add-on's versions to be unique and
strictly increasing, and by Firefox's own version comparison `0.1.3 < 0.1.3.1`. Uploading
`0.1.3` as the first listed version is therefore a regression against builds AMO has
already seen.

Bump to `0.2.0` in `package.json` and `manifest.json` before packaging. It clears every dev
build, and "first public release" is a reasonable minor bump anyway.

### Extension ID — keep `tabglutton@addons.local`

The signed dev builds carry this ID and AMO has accepted it nine times, so it is proven.
Submit the listed version **under the existing AMO add-on**, choosing the listed channel at
upload — an add-on can carry both channels, and staying on one ID means your own dogfooding
profile upgrades in place and keeps its extension storage.

Changing the ID would create a second AMO entry, orphan every existing install, and reset
stored settings. Users never see the ID. Don't.

### Privacy policy URL

```
https://github.com/mlsimon734/tabglutton/blob/main/PRIVACY.md
```

Required as a URL by Chrome; AMO takes the text inline (paste the same content). Chrome
accepts a GitHub-hosted policy.

### Source code submission is mandatory on AMO

`build.ts` sets `minify: true`, so the reviewed code is machine-generated. AMO requires the
original source plus reproducible build instructions whenever that is true. `bun run
package` already emits `web-ext-artifacts/tabglutton-source-<version>.zip` via `git archive`
— upload that alongside the add-on, and paste the reviewer notes in §4.

### Chrome developer account

One-time **$5 USD** registration fee if this is your first Chrome Web Store item. AMO is
free.

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
- alarms drives the reconnect timer for the optional agent bridge, and is inert while the
  bridge is disabled (the default).

AGENT BRIDGE

Off by default; no socket is opened while it is off. When enabled it connects to
ws://127.0.0.1:<port> only. Both ends authenticate against a user-generated shared token
using a nonce challenge, so the token never crosses the wire, and the server validates the
extension origin. Rationale and wire protocol: BRIDGE.md in the source.

Note that manifest.json declares content_security_policy.extension_pages explicitly. This
is load-bearing: Firefox's default MV3 CSP includes upgrade-insecure-requests, which
rewrites ws://127.0.0.1 to wss:// and breaks the loopback connection.
```

---

## 4. Chrome Web Store

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
| Opening a local WebSocket flagged as suspicious                            | Loopback only, off by default, token-authenticated, source public. Point at `BRIDGE.md`.                                                         |
| First-submission review latency                                            | Budget up to a couple of weeks for a first item with broad host permissions. AMO is usually days. Do not schedule launch posts before both land. |

---

## 5. Screenshots

### Specs

| Store  | Required                                                          |
| ------ | ----------------------------------------------------------------- |
| Chrome | **exactly 1280×800** or 640×400, PNG or JPEG, at least 1, up to 5 |
| Chrome | small promo tile 440×280 PNG (needed for store placement)         |
| AMO    | PNG/JPEG, no fixed size; 1280×800 is a good default               |
| Both   | icon 128×128 PNG — `icons/icon-chomp-128.png` already exists      |

The two existing captures in `docs/media/` are 2880×1800 retina grabs. Same 1.6 aspect
ratio as 1280×800, so they downscale cleanly — see `docs/media/store/` for the resized
pair.

### Shot list

Two screenshots exist; the store slots take five and the missing three are the ones that
actually sell it.

1. ✅ **Devour cockpit, light** — tabs grouped by host, duplicates flagged. Lead image.
2. ✅ **Devour cockpit, dark** — same view, proves the theme.
3. ✅ **Popup with duplicates found** — `popup-{light,dark}.png`. 600×600 logical at 2×,
   which is the height Chrome actually caps a popup at. Shows the Dedup pill reading 5 and
   the three `kepano/defuddle` rows (one `utm`-tagged) that produce it.
4. ✅ **Cockpit inspector on one tab** — `cockpit-inspector-{light,dark}-1280x800.png`.
   Inspector focused on an arXiv paper, showing `test / Clippings / ….md` and the
   frontmatter preview. This is what makes "files into Obsidian" concrete.
5. ⬜ **Obsidian, immediately after a Devour** — the clipping open in the vault. Sells the
   outcome rather than the mechanism. Worth more than any UI shot. Native app, so it has to
   be captured by hand.

**Popup sizing is unresolved.** The popup is 600px wide, so `popup-*.png` is 1200×1200 and
does not match Chrome's exact 1280×800 requirement. Either composite it onto a 1280×800
`--bone` background, or drop it from the Chrome listing and use it on AMO only (AMO has no
fixed size). Compositing is also the point at which the raw-vs-composited decision below
has to be made for the whole set.

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

---

## 6. Submission checklist

```
[ ] Bump version to 0.2.0 in package.json and manifest.json
[ ] bun run check          # typecheck + format + lint + test
[ ] bun run package        # both zips + source zip
[ ] Capture the three missing screenshots; resize all to 1280x800
[ ] Build the 440x280 Chrome promo tile
[ ] Commit and push PRIVACY.md so the policy URL resolves on main

AMO
[ ] Upload tabglutton-firefox-0.2.0.zip to the EXISTING add-on, Listed channel
[ ] Attach tabglutton-source-0.2.0.zip
[ ] Paste reviewer notes (§3)
[ ] Confirm data collection = none on every category
[ ] Fill listing copy, category Tabs, screenshots

Chrome
[ ] Pay the $5 developer registration fee if not already registered
[ ] Upload tabglutton-chrome-0.2.0.zip
[ ] Paste all seven permission justifications + single purpose statement
[ ] Declare no remote code, no data collection, tick all three certifications
[ ] Fill listing copy, category Workflow & Planning, screenshots, promo tile

After both are live
[ ] Update README Install section: replace "Not in the add-on stores yet" with store links
[ ] Fill the real URLs into docs/LAUNCH.md and post per the schedule there
```
