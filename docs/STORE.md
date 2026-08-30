# Store listing reference

Listing copy, store-platform findings, and the image pipeline for Tabglutton on
addons.mozilla.org (AMO) and the Chrome Web Store. Reference material, not a tracker: what
is left to do on any given day belongs in an issue, and what each store currently serves is
answered by `bun run status`, which reads AMO, the Chrome listing, and the npm registry
directly. **Nothing in this file states a version, a count, or a store's current state.**
Those expire silently between readings — this opening paragraph spent eight days telling
everyone who read it that both stores served a version neither one had.

▸ **A release goes to the stores first and to npm second, and a `BRIDGE_PROTO` bump is what
makes that order load-bearing.** There is deliberately no downgrade path in the handshake —
an attacker who can imitate the marker can also claim to be old — so a sidecar published
ahead of the extension refuses the handshake for **every** installed user, and
`bunx tabglutton-gullet` is what the options page, `gullet/README.md`, and the r/mcp launch
post all tell people to run. Ship the extension to both stores and let it roll out; only
then publish `tabglutton-gullet` at the matching version. `release.yml` does the npm half
automatically on the release tag once a repository variable is set — §6 is that setup, and
the order to do it in.

The two versions are deliberately kept equal, so "keep them on the same version" is a rule a
user can actually follow. Encoding the wire protocol in the npm major was considered and
dropped: the package was already `0.1.0` at protocol 2, and a version that tracks neither
the product nor the protocol helps nobody.

---

## 1. Standing constraints

These bind every release, not just the first one.

- **Keep the extension ID `tabglutton@addons.local`.** Changing it creates a second AMO
  entry, orphans every existing install, and resets stored settings. Users never see it.
- **AMO submissions must include source.** `build.ts` sets `minify: true`, so the reviewed
  code is machine-generated, and AMO requires the original plus reproducible build
  instructions whenever that is true. `bun run package` emits
  `web-ext-artifacts/tabglutton-source-<version>.zip` via `git archive`. The source step is
  **after** the button labelled "Submit Version", not alongside the package — see §3, or
  skip the ordering entirely with `bun run sign:listed`, which passes the zip on the
  command line (§7).
- **The submission flow defaults to the wrong channel, and states it rather than asking.**
  The upload page prints the current choice as prose ("On your own.") with a small `Change`
  link, and the file picker sits directly beneath it. The actual radios live on a separate
  page, and the default is sticky from the last submission — which for this add-on is every
  `sign:dev` build ever signed, all unlisted. `0.3.0` was lost to this. Always start a store
  submission from the URL that arrives preselected:

  ```
  https://addons.mozilla.org/en-US/developers/addon/tabglutton/versions/submit/distribution?channel=listed
  ```

  `bun run sign:listed` (§7) names the channel on every invocation and inherits nothing,
  which is the other way out of this.

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

This is the web flow; `bun run sign:listed` does the same submission in one command and is
the shorter path (§7). Keep this section anyway — it is what the console does, and it is
where the step order and the validation warnings are recorded.

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

`manifest.json` already declares it — **nested inside `browser_specific_settings.gecko`**,
not at the top level, which is where you will look for it first and not find it:

```json
"browser_specific_settings": {
  "gecko": {
    "id": "tabglutton@addons.local",
    "strict_min_version": "140.0",
    "data_collection_permissions": { "required": ["none"] }
  }
}
```

The nesting is correct — it is a Gecko-only key, and `build.ts` deletes the whole
`browser_specific_settings` object for Chrome, so the Chrome package has no counterpart to
it and does not need one (§4 covers how Chrome takes the same declaration). This is
accurate and should be left alone. AMO's definition scopes "collection" to data
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

Toolchain: Bun 1.4.0 (https://bun.sh) is the only dependency. Tested on macOS; any Unix
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

Live since 2026-08-17 at item `dlploljcggbdcjcaiigmoagonmehglhi`. Publishing required a
developer account carrying a one-time **$5 USD** registration fee; AMO is free.

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

### Three things gate the Publish button, and none of them live on the item page

Chrome reports all three only when you press Publish, as a list of blockers rather than as
field errors, so a listing that looks complete is not submittable:

1. **Certify data usage** on the item's **Privacy practices** tab — the three checkboxes
   under "Data usage disclosure" below. Filling in the justifications is not the same act
   as certifying, and the tab shows no error until Publish.
2. **A publisher contact email** — left rail, **PUBLISHER → Settings**. Not the item, and
   **not `ACCOUNT → Profile`**, which is the trap: the rail has two groups, _Profile_ sits
   under the second one, and it holds only the registration fee, the developer account,
   the notifications checkbox, and publisher creation. No email field, and nothing below
   the fold. Chrome's blocker text names the right page outright — "Enter the publisher's
   contact email on the Settings page" — so read it literally.

   It is publisher-wide rather than per-item, and Google displays it under each
   extension's contact information, so pick one you are content to publish; the Google
   account already signed in is the obvious choice. Do **not** reach for _Create a new
   publisher_ on the Profile page to conjure the field — a publisher is a separate,
   one-per-account object ("0 out of 1 allowed") and an item publishes fine without one.

3. **Verification of that email** — same Settings page. Google sends a **verification
   link**, not a code; the address reads "unverified" and Publish stays blocked until the
   link is followed. Adding and verifying are two separate steps in one place.

### A fourth gate: a new permission needs a justification, which un-certifies the third

Measured on 0.4.0, whose `optional_permissions: ["downloads"]` was new since `0.3.1`.
Optional does not exempt it. The API answers only `HTTP 400: Your submission does not meet
the requirements`, and the dashboard greys out _Submit for review_ with no field marked —
the reason is behind the **"Why can't I submit?"** link, as with the blockers above.

**Filling the justification then resets the data-usage certification**, so clearing this
blocker immediately fails on gate 1 and reads like the fix not taking. Tick the three boxes
again before saving. `tabGroups` ([#34](https://github.com/mlsimon734/tabglutton/issues/34))
is the next permission due to walk into this.

### Single purpose statement

```
Tabglutton's single purpose is managing the user's open browser tabs: finding and closing
duplicates, and saving selected tabs to the user's own notes application before closing
them. Every feature operates on the user's tab list. The optional local bridge exposes
those same tab operations to a coding agent running on the user's own machine; it adds no
capability the extension does not already have through its own UI.
```

### Permission justifications

Paste one per field. **The console asks about what the uploaded package declares, so check
the zip rather than working from this list or from `main`.** Both host entries are
`optional_host_permissions` on Chrome (see the host-permission rules in `AGENTS.md`) and
both still want a justification; `downloads` is in neither list for `0.3.1`.

```sh
unzip -p web-ext-artifacts/tabglutton-chrome-<version>.zip manifest.json \
  | python3 -c 'import json,sys; m=json.load(sys.stdin); print({k: m.get(k) for k in ("permissions","optional_permissions","host_permissions","optional_host_permissions")})'
```

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

**Host permission `http://127.0.0.1/*`**

```
Reaches the optional local bridge: a small MCP server the user installs and runs on their
own machine, so a coding agent they are already using can list and triage their tabs. The
connection is a loopback WebSocket to 127.0.0.1 and nothing else; no external host is ever
contacted, and no tab data leaves the machine.

It is off by default and optional in every sense: the permission is requested only when the
user turns the bridge on in the extension's settings, and both ends authenticate with a
token the user generates. With the bridge disabled the extension opens no sockets at all.
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

**`downloads`** — _not in `0.3.1`; the console will not ask for it yet_

`0.3.1` predates the file destination ([#36](https://github.com/mlsimon734/tabglutton/pull/36)),
which added `downloads` as an **optional** permission on `main`. Keep this text for the
release that ships it, and skip the field until then.

```
Saves a clipped page as a markdown file in the browser's download folder, for users who
have chosen the file destination instead of an Obsidian vault. Requested only when the user
picks that destination, and written only during an explicit clip; existing downloads are
never read or opened.
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

Leaving the categories empty is not itself the certification: the three checkboxes are a
separate act, and skipping them is blocker 1 above.

**Why the all-zeros answer is right, and not just convenient.** Chrome scopes collection to
_obtaining data from the user's device and transmitting it off the device_, and the
extension has no off-device destination. Re-check rather than assume, before any future
submission:

```sh
grep -rn "fetch(\|new WebSocket\|XMLHttpRequest\|sendBeacon\|EventSource" src/ | grep -v '\.test\.'
grep -rho "storage\.\(local\|sync\|session\|managed\)" src/ | sort | uniq -c
```

At `0.3.1` that is two call sites, both hardcoded to `127.0.0.1` (`bridge-client.ts:575`
and `:990`), and `storage.local` ×11 plus one `storage.session` — no `storage.sync`, which
would ride Google's servers and _would_ be transmission. No analytics, telemetry, or crash
reporting exists in any form.

Two categories still want a reasoned no, because they are the ones a reviewer probes:

- **Web history** — tab titles and URLs are genuinely read, and the undo log retains them
  so Undo works. It is `storage.local`, never synced, removed on uninstall. Read is not
  collected.
- **Website content** — Defuddle extracts inside the page; the result goes to the Obsidian
  vault, the download folder, or the loopback bridge. All three are on the user's machine.

`downloads`, once it ships, changes none of this: the download folder is the device.

**The one edge worth having an answer ready for.** With the bridge enabled, page content
reaches a local MCP server, and the agent behind it may transmit that text to a model API —
genuinely off-device. That is the agent's transmission, not the extension's, and
`PRIVACY.md` already states it (§The agent bridge, last paragraph). Answer from there
rather than improvising.

This matches what Mozilla was told: `data_collection_permissions: { "required": ["none"] }`
sits under `browser_specific_settings.gecko`, so `build.ts` drops it for Chrome along with
the rest of that key — the Chrome package carries no equivalent manifest field by design,
and the console form is where Chrome takes the same declaration.

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

---

## 6. Gullet's npm publish

`tabglutton-gullet` is published by the `publish-npm` job in
`.github/workflows/release.yml`, which runs after the GitHub release is cut for a `v*` tag.
It authenticates by **trusted publishing**: the job asks GitHub for a short-lived OIDC token
and npm exchanges it for a one-shot publish credential. There is no npm token in this
repository — no `NODE_AUTH_TOKEN`, no `secrets.*` in that job, nothing to leak or rotate.
The long-lived credential that a compromised action steals is the one that does not exist
here, which is also why every action in both workflows is pinned to a commit SHA rather than
a tag a third party can move.

Bun builds the artifact (`bun run build:gullet`) and npm only ships it. Neither bun nor pnpm
implements the OIDC exchange, so the split is structural rather than a preference; npm
`>= 11.5.1` is the floor and the job installs it explicitly rather than trusting the runner's
bundled version.

**A repository variable is the gate.** The job is skipped unless `PUBLISH_GULLET_TO_NPM`
is set to `true` — repo **Settings → Secrets and variables → Actions → Variables**. GitHub
compares expression strings case-insensitively, so `True` counts as well; every other value,
and an unset variable, leaves the job skipped. The flip happens once and every later release
tag then publishes on its own, so this is a switch to check when a tag produces no package —
not a step in a release. `bun run status` says whether npm actually has the version.

### How the first publish was done

A record, not a checklist — it has happened. Worth keeping because it is the order to
repeat if the package ever has to be re-established, and because step 3 is where a typo
costs a release.

1. **Ship the extension to AMO and the Chrome Web Store, and let it roll out.** Non-negotiable, for
   the reason at the top of this file: `BRIDGE_PROTO` 3 has no downgrade path, so a sidecar
   that lands first refuses the handshake for every installed user. §7 is how both of those
   submissions are driven — `bun run sign:listed` and `bun run publish:chrome --publish`.

2. **Publish the first version by hand**, from a local `npm login`:

   ```sh
   cd gullet && npm publish --access public   # prepack runs `bun run build`
   ```

   npm's trusted-publisher form lives on a package's own settings page, and that page does
   not exist for a name that has never been published. _Reasoned from npm's docs, not
   tested_ — they say where the form lives and are silent on unpublished names. If npm turns
   out to accept a publisher for a name it has never seen, skip to step 3 and let the
   workflow do the first publish too.

3. **Configure the trusted publisher** at `npmjs.com/package/tabglutton-gullet/access` →
   **Trusted Publisher** → **GitHub Actions**:

   | Field                | Value         |
   | -------------------- | ------------- |
   | Organization or user | `mlsimon734`  |
   | Repository           | `tabglutton`  |
   | Workflow filename    | `release.yml` |
   | Environment name     | _(blank)_     |
   | Allowed actions      | `npm publish` |

   Every field is case-sensitive, the workflow filename is the bare filename with its
   extension and not a path, and **npm validates none of it on save** — a typo surfaces only
   as `ENEEDAUTH` at publish time. The filename being part of the package's identity is why
   `release.yml` must not be renamed without editing the npm side to match.

4. **Restrict token publishing.** Package **Settings → Publishing access → "Require
   two-factor authentication and disallow tokens"**. npm recommends this once a trusted
   publisher exists; it does not affect OIDC publishes.

5. **Flip `PUBLISH_GULLET_TO_NPM` to `true`.** From here the sidecar ships with the tag.

### Notes

- The job re-checks `gullet/package.json` against the tag and fails rather than publishing a
  sidecar whose version disagrees with the extension it pairs with. It takes that tag from
  the `release` job's output, so the two halves of a release cannot build from different
  refs.
- **Retrying is real.** `ENEEDAUTH` from a mistyped trusted-publisher field is fixed on
  npmjs.com and retried by re-running the workflow with the same tag — the release job
  updates an existing GitHub release instead of failing on it, so the re-run reaches
  `publish-npm` rather than stopping short of it.
- **Provenance attestations are generated automatically** for an OIDC publish from a public
  repository, so `--provenance` is neither needed nor passed.
- Trusted publishing works only from GitHub-hosted runners; self-hosted is unsupported.
- Not done, and the next hardening if this ever wants a per-release human gate: bind the job
  to a GitHub **environment** with required reviewers and name that environment in the npm
  form. That trades flip-once for approve-every-time, which is why it is not the shape here.

---

## 7. Scripted publishing

Both stores are reachable from the terminal. Nothing here replaces the listing itself —
copy, screenshots, categories, and the privacy certifications in §4 are console work, done
once and edited by hand afterwards. What is scripted is the repeated part: taking the
package that `bun run package` just built and getting it into the store, then **asking the
store whether it actually arrived** rather than believing the call that said so.

This section is the mechanism only. **When** to run any of it belongs to §6, which owns the
release order — both stores first, the sidecar's npm publish after they have rolled out —
and that constraint is not restated here so that there is only one copy of it to keep true.

| Command                            | What it does                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| `bun run cws:auth`                 | one-time: mint a Chrome Web Store refresh token from an OAuth client         |
| `bun run publish:chrome`           | package the Chrome build and upload it as a **draft** — nothing is submitted |
| `bun run publish:chrome --publish` | upload, then submit for review                                               |
| `bun run publish:chrome --status`  | print what the store currently holds                                         |
| `bun run sign`                     | AMO **unlisted** — self-distribution signing, does not touch the listing     |
| `bun run sign:listed`              | AMO **listed** — the public submission, source zip included                  |
| `bun run sign:dev`                 | AMO unlisted with the four-part build counter (`AGENTS.md` § Versioning)     |

`bun scripts/publish-chrome.ts --help` has the full flag list, including `--publish-only`,
`--cancel`, and `--zip=PATH`.

### Use the V2 API. V1 dies on 15 October 2026

`scripts/publish-chrome.ts` targets **V2**, at `https://chromewebstore.googleapis.com/v2/`.
The V1 API at `https://www.googleapis.com/chromewebstore/v1.1/` is deprecated and supported
only until **15 October 2026**, so every recipe and blog post older than that is a rewrite
waiting to happen — and `chrome-webstore-upload-cli`, the obvious dependency, is one of
them. There is no reason to take a dependency here: the whole surface is an OAuth refresh
and two HTTPS calls.

One shape change is worth stating outright because it is what breaks a ported V1 recipe.
V2 addresses items as **`publishers/{publisherId}/items/{itemId}`**; V1 needed only the item
id. Without `CWS_PUBLISHER_ID` every call 404s, and the publisher id is not discoverable
through the API — read it off the Developer Dashboard, **PUBLISHER → Settings**, the same
page §4 sends you to for the contact email.

The endpoints used:

| Call                          | Method and path                                      |
| ----------------------------- | ---------------------------------------------------- |
| upload a package              | `POST /upload/v2/{item}:upload`, raw zip as the body |
| read the item's state         | `GET /v2/{item}:fetchStatus`                         |
| submit for review / publish   | `POST /v2/{item}:publish`                            |
| withdraw a pending submission | `POST /v2/{item}:cancelSubmission`                   |

Note the two `:upload` paths. The package goes to the one **under `/upload`** — the media
endpoint. The identically named path without that prefix is the metadata-only variant and
takes no package at all.

V2 also offers staged rollouts — `STAGED_PUBLISH` with a percentage, widened afterwards
through `:setPublishedDeployPercentage`. Deliberately not wrapped. There is no Chrome
population here to stagger a release across, and it is the one path that could not be
exercised before shipping it, so it would be untested code around an untested API.

### One-time setup, and it is all human work

Only a person can do this part; the script cannot bootstrap itself.

1. **A Google Cloud project.** <https://console.cloud.google.com> → create or pick one.
2. **Enable the Chrome Web Store API** in that project (APIs & Services → Library → search
   for it → Enable). A client that skips this authorizes fine and then fails every call.
3. **OAuth consent screen** → **External**. Fill in the required app fields, skip the
   scopes screen, and **add your own Google account as a test user** — an app left in
   Testing only issues tokens to listed test users.
4. **Credentials → Create credentials → OAuth client ID → application type "Desktop app".**
   Not "Web application", which is what the official reference tells you to pick because it
   walks you through the OAuth Playground. `scripts/cws-auth.ts` binds a loopback listener
   on an ephemeral port instead, and a Desktop app client is the only type that accepts a
   loopback redirect it was never told about in advance. (The reason there is a listener at
   all: Google retired the copy-the-code-off-the-page flow, `urn:ietf:wg:oauth:2.0:oob`, in
   2022.)
5. Put the client id and secret in `.env` as `CWS_CLIENT_ID` / `CWS_CLIENT_SECRET`, add
   `CWS_PUBLISHER_ID` from the dashboard, then run:

   ```
   bun run cws:auth
   ```

   It opens the consent screen, catches the redirect, exchanges the code, and prints a
   refresh token. It deliberately does **not** write `.env` itself — paste the value in as
   `CWS_REFRESH_TOKEN`. Scope is `https://www.googleapis.com/auth/chromewebstore`.

`.env` is gitignored and is the only place any of this lives.

### Two gotchas that are not the script's fault

- **The Google account must have 2-Step Verification enabled.** Google requires it to
  publish or update an extension at all. Without it the OAuth dance succeeds and the
  publish call is the thing that fails.
- **A refresh token dies after six months unused**, and also when the account's password
  changes. Releases here are further apart than that, so expect to re-run `cws:auth`
  roughly as often as you release. `publish-chrome.ts` recognizes `invalid_grant` and says
  so rather than reporting an opaque 400.

### What the verification actually proves, and what it does not

The point of querying `fetchStatus` after a publish is the failure this exists to catch: a
call that answers `200` with a plausible `state`, and did not take. So the verdict is
always what a **second, separate** read says, never the publish response — the same rule
§3 states for AMO ("confirm the channel actually took by querying the API"). The script
polls `fetchStatus` for up to 60s and exits non-zero unless the version it just uploaded
appears in the item's published or submitted revision. A timeout is reported as
_unconfirmed_, not as _failed_, because those are different facts and only one of them is
a reason to re-run.

An **upload** is weaker, and the script says so rather than dressing it up. A package that
has been uploaded but not submitted is not a revision the store will describe: it is
neither published nor submitted, so `fetchStatus` has nothing to name it by. What can be
confirmed is that the upload succeeded (`uploadState`, or `lastAsyncUploadState` when the
store took the package asynchronously) and that the version the store echoed back is the
version in this tree — a mismatch there means the wrong zip, and is a hard failure. A
draft upload reporting success is a claim about the upload, not about the store's draft.

### The AMO half, and why the listed path looked absent

`bun run sign` is `--channel=unlisted`. That is **self-distribution signing** — it mints a
signed XPI and never touches the public listing, which is why there appeared to be no
scripted path to AMO. `bun run sign:listed` is the listed one:

```
web-ext sign --channel=listed --upload-source-code=web-ext-artifacts/tabglutton-source-<version>.zip
```

The source upload is not optional. `build.ts` minifies, so the reviewed code is
machine-generated and AMO bounces a listed submission without the original (§1). Passing it
on the command line also collapses the ordering trap in §3, where the source step hides
_after_ the button labelled "Submit Version".

`sign:listed` refuses to run on a dirty tree. The source zip is `git archive HEAD`, so
uncommitted work would ship source that does not build the package being signed — a
mismatch that surfaces in a review queue days later, if at all. Commit first.

Neither AMO script picks the channel from anything sticky, which is the other half of the
§1 trap: the web flow inherits the last channel used, and every `sign:dev` build ever made
was unlisted.
