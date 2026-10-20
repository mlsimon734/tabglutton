# Roadmap: Digest

_Rewritten 2026-10-19 against `main` at 0136adb (0.5.1). The first version, written
2026-09-05 at eccff8d, is in git history; its decisions stand unless this file reverses them.
The measured histories that come out of this land in `ENGINEERING.md` as they are made._

## Thesis

The user opens dozens of links from feeds (x.com, reddit, LessWrong, YouTube) out of interest,
reads the few that matter, and is left with the rest open and unresolved. The tool's job is to
take that remainder off the user's hands without losing anything.

Three ideas carry the plan:

- **An item with a fate, not a tab.** Nothing leaves the browser without a recorded fate —
  `kept`, `filed`, `dropped`, `digested` — and every fate stays recallable.
- **A sitting, not a session.** The batch that matters is the tabs opened from one visit to
  one feed. "The 70% left over" is a sitting minus what got read.
- **Make a wrong close cheap.** The remainder is not a classification problem; the user
  already knows it will not be read. It is loss aversion. So the leverage is not in getting
  keep-or-close right, it is in making being wrong about a close cheap: a verdict with a
  quote and the URL, a durable record, and undo. That is what makes closing forty tabs at
  once feel like filing.

The fate built on these is **digest**: an agent reads the remainder, the shortlist stays open
at the top of its window, and the rest close behind a verdict per item. The extension proposes
and applies fates; the agent only reads and reports. Tabglutton is the browser-side half of
that loop — inventory at backlog scale, waking, reading, verdicts approved in the browser,
undo, verified filing — for whichever agent the user already runs.

## Where it stands (0.5.1)

| Release | Shipped                                                                                                                                                                                                                                                                                                                       |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.5.0   | `/digest` as a skill inside the Gullet package. `digest_report` and a Digest panel in the full view (worth your time, file, close, could not read), Close as one undo batch, a "Digest ready" line in the popup, and Gullet's note in the vault. YouTube transcripts in reads (#86), so a talk is no longer "could not read". |
| 0.5.1   | The Desk layout. Page facts recorded browser-side, never taken from the report (#99). Untick a close row to leave its tab open. **Move to top** in place of Keep in a group. Shift-click range selection.                                                                                                                     |

Not built: the fate ledger (#80), sittings (#81), the mailbox (#82). #83's surface shipped in
a different shape: the panel is the Digest side of the full view (the cockpit, renamed), the
shortlist moves to the top rather than into a tab group, and Gullet writes the mirror rather
than the extension. Popup and full-view closes still live in a six-second toast.

**What the by-hand runs found** ([#79](https://github.com/mlsimon734/tabglutton/issues/79),
1.5 of 3 sittings, nothing closed): the agent's shortlist overlapped the user's own keeps 1 of
5, then 2 of 5 with the other three filed and none closed. The largest error was content the
user had already read or watched, which page text cannot tell from unread. "File" was
over-used, 7 against the user's 2. A sitting cost 3.5–5 minutes and about 7k tokens per tab.
Because nothing was closed, the question the plan rests on — is a one-line verdict enough to
let a tab go — was never asked.

## Landscape (2026-10)

Researched 2026-10-19 from vendor documentation, store listings, and press; nothing here was
tested live, and "undocumented" means unknown, not absent. **Grouping tabs, closing
duplicates, and asking about a handful of chosen tabs are becoming browser features. Nothing
found triages hundreds of tabs, discarded ones included, with a verdict per tab approved in a
UI, filing to local markdown, and a durable undo — and none of the vendor assistants runs on
Firefox or Zen.**

| Job                                     | Who does it now                                                                                                        | Consequence here                                     |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Topic grouping                          | Firefox Smart Window (beta) and Firefox's on-device suggestions, Safari 27 (announced), ChatGPT extension (press), Dia | Not built here; #100 closed for #112                 |
| Closing duplicates                      | Firefox Smart Window, OneTab                                                                                           | Table stakes; Dedup stays, no further investment     |
| Questions across chosen tabs            | Gemini in Chrome (current tab plus 10), Edge Copilot, ChatGPT extension                                                | Not this product's job                               |
| History recall                          | Gemini in Chrome, Edge Journeys, Dia                                                                                   | Not this product's job                               |
| External agents drive the browser       | Opera Neon's MCP connector; Playwright MCP, Chrome DevTools MCP, and Firefox tab MCPs                                  | Confirms the bridge; none has verdicts, filing, undo |
| Triage at backlog scale, approved, undo | Nobody found                                                                                                           | The product                                          |
| Agent triage of a saved library         | Readwise Reader and Karakeep (MCP servers); Raindrop's assistant                                                       | Libraries saved into, not the live tab backlog       |
| One-page clipping to Obsidian           | Obsidian Web Clipper (~1M users); multi-tab clipping requested since 2024, not shipped                                 | Devour's batch clip-and-close is still uncontested   |

**The ChatGPT extension is the one to watch.** Its documentation says chat "can use context
from your open tabs when a task needs it", that browser control follows the user's ChatGPT
Memories, and that it runs on Chrome, Edge, Brave, Opera, and Vivaldi only. It asks before
acting on each new website; "Allow for all sites" is marked Elevated Risk, so a 200-tab
backlog across many sites means many prompts or blanket access. Press reports that the
15 October update groups tabs. Closing tabs, undo, discarded tabs, and tab-count limits are
undocumented. Where it beats Tabglutton is memory of what the user cares about; that is the
agent's half, and the agent Tabglutton serves brings its own.

What this changes: grouping is not built here (order is — bet 3); memory and interests are not
competed on; and Opera Neon shipping an MCP tab surface is evidence the bridge is the right
shape, not a threat to it.

## The bets, re-ranked

Ranked by how much each lowers the cost of a wrong close, with one new filter from the
landscape: skip what browsers are giving away.

1. **Digest receipts** ([#79](https://github.com/mlsimon734/tabglutton/issues/79)'s
   instrument). The digest is measured in normal use instead of blind, labelled sittings. Per
   digest: rows moved or unticked (disagreement), time from opening the digest to Close
   (review cost), Undo, and closed pages reopened within 48 hours (regret; the undo log
   already holds every digest close's URL). The receipt shows on the digest itself. The
   continuation bar, over two fresh sittings closed for real: review time at least half that
   of a comparable Devour session, no close the user counts as a mistake, and no filing
   inflation. Missing it stops further Digest panel investment. What this gives up is an
   answer key the verdicts cannot sway; by `PRODUCT.md`'s success measure, a close that is
   never missed was a fine close. The "already read" error is read indirectly, as worth-it
   rows moved to Close.
2. **Every close in the undo log** (the narrow slice of
   [#80](https://github.com/mlsimon734/tabglutton/issues/80)). Popup and full-view closes go
   through the log the bridge uses, with retention raised past 500 entries, under the undo
   invariants. Worth doing whatever the experiment shows, and it lets receipts count regret
   for every close. The full ledger — a fate per URL, marks, title search — waits until
   receipts show how often a sitting meets a URL it has already judged. #80's done bar (80% of
   dispositions re-derived) assumes that rate, and nobody has measured it.
3. **Order by priority** ([#112](https://github.com/mlsimon734/tabglutton/issues/112),
   replacing #100). One action, two directions: **Focus** puts worth-it tabs first and close
   candidates last; **Clear** reverses it so a sweep starts with what is cheapest to close.
   Existing tab groups — the user's, the browser's, a site rule's — move as blocks ranked by
   their best tab, and all-low groups collapse. Priority comes from the digest verdict where
   there is one, else from clip memory, duplicates, and `lastAccessed`. One Undo through Move
   to top's record-and-restore. Gated on a Zen measurement of `tabs.move`, `tabGroups.move`,
   and collapse, since Zen ignores `tabs.create({ index })` and other workspaces' tabs hold
   indexes. The agent's topic names appear only as text in the digest report until they earn
   UI.
4. **Zotero through its local API**
   ([#113](https://github.com/mlsimon734/tabglutton/issues/113)). The Connector API was
   declined upstream; Zotero 10's local API writes passed a spike on arXiv, ACL, and PMLR
   (`ZOTERO_POC.md` §The local API route). Open: an optional `http://localhost:23119/*` host
   permission in the extension (recommended) or the write in Gullet.
5. **Sittings, then the mailbox** ([#81](https://github.com/mlsimon734/tabglutton/issues/81),
   [#82](https://github.com/mlsimon734/tabglutton/issues/82)). Provenance recorded at
   `tabs.onCreated` and keyed by `normalizeUrl` at the first committed `onUpdated`, never by
   tab id; time on a page joins it if receipts say the "already read" error matters, treated
   as exposure, not a finished read. The pull mailbox (`jobs_pull`, `job_report`) lets the
   full view queue a digest for a running agent; the hub never spawns on a wire request.
6. **Interests from the vault, feed-native reads, and the horizon.** The skill reads an
   interests note and the vault's maps of content at job time. Acquisition keeps its ladder
   (metadata, then `tabs_load`, then a cookie-less fetch from Gullet for public pages,
   `BRIDGE.md` §The discarded-tab problem, item 2, not built). The horizon bet stays **harvest
   the feed, not the tabs**: run the extractors on the feed page so interesting links become
   ledger items without becoming tabs. It waits for a ledger to receive its output.

## Sequence

Patch for anything the protocol survives, minor when a new capability class lands. Nothing
below bumps `BRIDGE_PROTO`.

| Release   | Contents                                                                                                                                                                            |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0.5.2** | Digest receipts; every close in the undo log. Two sittings digested and closed in normal use, read against the bar.                                                                 |
| **0.5.3** | Order by priority, after the Zen measurement. Zotero through the local API once the permission question is decided.                                                                 |
| **later** | The full fate ledger, sittings, and the mailbox — each only as far as the receipts say the digest earns it. The red-team below runs before anything unattended (the scheduled CLI). |

## Experiments before code

1. **Receipts in normal use** (bet 1): two sittings, closed for real, against the bar. It
   absorbs the old review-tax experiment, since review time against a Devour session is the
   same comparison.
2. **Zen ordering** (bet 3): `tabs.move` with an index, single and batch, `tabGroups.move`,
   `tabGroups.update({ collapsed })`, and whether Zen's folders appear as `tabGroups`, through
   the Marionette harness in `scratch-chrome/`.
3. **Provenance survival** (bet 5): does `openerTabId` survive on Zen after a cmd-click from an
   x.com feed, and after a restart? Does `tabs.onReplaced` fire on a Chrome discard?

The extraction matrix ran as a pilot in #79; its YouTube finding became #86.

## What kills it

- **The digest is not trusted.** One "not worth your time" on something that mattered and the
  user goes back to hoarding. Structural answer: the quote and URL per item, the undo log
  written before the close, undo for the batch. Receipts now measure it as reopens and Undos.
- **The ledger becomes a second backlog.** Three thousand digested items nobody reads is the
  tab problem with extra steps. Ship it with a hard cap and search only; if search is never
  used, cap harder and stop investing.
- **A page tells the agent what to do.** The digest agent reads untrusted web text;
  `BRIDGE.md` §Security model warns that page text can widen what an agent reads and persist
  instructions into a trusted vault. The skill restricts the agent to the Tabglutton tools,
  agent text renders inert in the panel and the note, and five pages seeded with explicit
  injections get red-teamed before anything runs unattended.
- **A general agent does this without any of it.** The first version of this file named the
  ledger as the moat. An unbuilt ledger is not a switching cost, and session managers already
  save and restore tabs durably. What a user loses today by switching is the integrated,
  verified cleanup — inventory at backlog scale, waking, verdicts approved in the browser,
  undo, verified filing — in Zen and Firefox, with an agent the user chooses. The ChatGPT
  extension is the nearest: re-check its documentation for closing, undo, scale, and Firefox
  at each release. If a vendor assistant does a 200-tab cleanup with undo on Firefox, the bets
  need rethinking.
- **Browsers ship the cleanup natively.** Safari 27 can close a whole automatic group, Dia
  offers stale-tab cleanup and close-all, and Smart Window's "journeys" are coming. Each is a
  partial overlap with Close and Move to top; watch them, and keep the product on what they
  lack: the read, the verdict, the filing, and the undo.

## Cut, deferred, reversed

| Item                             | Call     | Why                                                                                                                                 |
| -------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| #73 on-device model              | Closed   | Its own question 3 is fatal: a useful verdict needs page text. The eval idea survives in #79.                                       |
| In-extension API key             | Out      | A network permission, a key in extension storage, and the store claims break. The agent the user already runs is the engine.        |
| Hub-spawned agent jobs           | Out      | Protocol bump, Gullet as launcher, unattended closes, and a hub that is not always alive. The pull mailbox gets the same keystroke. |
| Close, then reopen the worth-its | Out      | Churn. The shortlist never closes.                                                                                                  |
| Keep in a group                  | Replaced | By Move to top in 0.5.1: the shortlist moves to the top of its own window, and nothing is grouped.                                  |
| Agent topic groups (#100)        | Replaced | By Order by priority (#112). Grouping is what browsers are giving away; order composes with any of them.                            |
| Blind, labelled sittings         | Replaced | By receipts in normal use (#79). The labelling was the cost; the user's judgment of a close is the only part that needs the user.   |
| Full fate ledger first           | Deferred | The narrow slice (every close in the undo log) ships first; the rest waits for receipts to show how often URLs recur.               |
| Connector API upstream           | Declined | zotero-connectors#637, 2026-09-28. The local API is the candidate route (#113).                                                     |
| Digest as a vault note first     | Reversed | The digest is read in the browser, where the sitting happened; the vault gets a mirror.                                             |
| #72 review surface               | Shrunk   | Buckets and exceptions, not a proposal per tab.                                                                                     |
| Skill outside the repo           | Reversed | `/digest` ships with Gullet so the agent half of the product exists on install.                                                     |

## Decisions

**2026-09-05.** Two independent reads went in with the same brief — opus-5 and a Codex run on
gpt-5.6-sol — and changed the draft: provenance keyed by URL rather than tab id and timed at
the URL commit; a pull mailbox instead of hub-spawned jobs, with the queue in extension storage
because the hub is not always alive; the shortlist kept open rather than closed and reopened;
one line rather than a paragraph for the remainder; prompt injection named as a risk. The
maintainer decided: digest as the fate for the 70%, "cheap wrong close" as the ranking rule,
the by-hand experiment before extension code, and the digest read **in the browser, in flow**,
with the vault as a mirror. The framing for the whole direction: a browsing and information
assistant of the kind the platform vendors are converging on, done with more control and
discipline — a local ledger, evidence per verdict, reversible closes, a swappable agent, no
account.

**2026-10-19.** A landscape scan (three sonnet-5.5 scouts over vendor docs, store listings, and
press, with the ChatGPT extension docs, Mozilla's Smart Window post, and Zotero's changelog
re-read first-hand) and an adversarial gpt-6.1-sol read of the draft recommendation. The sol
read changed it: the experiment before the ledger, because no run had closed anything; #80
split into the undo-log slice and the rest; the "already read" error tested before engagement
tracking is built; and two overclaims narrowed (time on a page is exposure, not completion;
session managers already restore tabs durably). The maintainer decided: release 0.5.1;
receipts in normal use instead of blind sittings; Order by priority in place of #100, after a
Zen measurement; and a Zotero local API spike, which passed.

## Sources (landscape, read 2026-10-19)

- OpenAI, [ChatGPT Chrome extension](https://learn.chatgpt.com/docs/chrome-extension) — help
  documentation, undated.
- 9to5Google,
  [ChatGPT gets deeper Google Chrome integration, including control over tabs](https://9to5google.com/2026/10/16/chatgpt-gets-deeper-google-chrome-integration-including-control-over-tabs/)
  — 2026-10-16.
- TechCrunch,
  [OpenAI is shutting down Atlas, but its AI browser ambitions are still growing](https://techcrunch.com/2026/07/09/openai-is-shutting-down-atlas-but-its-ai-browser-ambitions-are-still-growing/)
  — 2026-07-09.
- Mozilla, [Firefox Smart Window](https://blog.mozilla.org/en/firefox/firefox-smart-window/) —
  2026-08-18, updated 2026-09-16.
- Google, [Gemini in Chrome](https://support.google.com/chrome/answer/16283624) — Chrome Help.
- Google, [Gemini 3 auto browse in Chrome](https://blog.google/products-and-platforms/products/chrome/gemini-3-auto-browse/)
  — 2026-01-28.
- Microsoft,
  [Edge updates across desktop and mobile](https://blogs.windows.com/msedgedev/2026/05/13/new-updates-to-edge-across-desktop-and-mobile/)
  — Edge blog, 2026-05-13.
- 9to5Mac,
  [Everything new coming to Safari on macOS 27](https://9to5mac.com/2026/06/09/heres-everything-new-coming-to-safari-on-macos-27-golden-gate/)
  — 2026-06-09.
- The Browser Company, [Dia changelog](https://www.diabrowser.com/changelog).
- Opera,
  [Opera Neon adds an MCP connector to the browser](https://blogs.opera.com/news/2026/03/opera-neon-adds-mcp-connector-to-the-browser/)
  — 2026-03-31.
- Anthropic,
  [Get started with Claude in Chrome](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome)
  — help center.
- Obsidian,
  [Web Clipper issues on clipping multiple tabs](https://github.com/obsidianmd/obsidian-clipper/issues?q=multiple+tabs)
  — GitHub.
- Readwise, [Readwise MCP](https://docs.readwise.io/tools/mcp) — documentation, launched
  2026-03-20.
- Karakeep, [releases](https://github.com/karakeep-app/karakeep/releases) — GitHub.
- eyalzh, [browser-control-mcp](https://github.com/eyalzh/browser-control-mcp) — GitHub.
- sienori, [Tab Session Manager](https://github.com/sienori/Tab-Session-Manager) — GitHub.
- Zotero, [changelog](https://www.zotero.org/support/changelog) and
  [local API](https://www.zotero.org/support/dev/web_api/v3/local_api) documentation.
