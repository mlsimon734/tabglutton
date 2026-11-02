# Roadmap: Digest

_Revised 2026-11-02 against `main` at 261b719 (0.5.2, unreleased), after two titles-only runs
over the maintainer's live backlog. The 2026-10-19 version is in git history; its decisions
stand unless this file reverses them, and the reversals are listed under Decisions. The
measured histories that come out of this land in `ENGINEERING.md` as they are made._

## Thesis

The user forages. Feeds (x.com, reddit, YouTube, Hacker News, blogs, news sites) are where new
information comes from, and recommendation engines are better at serving it than any agent.
Nothing here replaces them. The cost comes after: links get opened out of interest, a few get
read, and the rest stay open because closing them feels like losing them. 800 open tabs are
the result. By then a tab that is still open can't be found either.

The tool's job is to take that remainder off the user's hands, routed to where each piece
belongs, without the user giving up the judgment that is theirs. Four ideas carry the plan:

- **A tab is kept for signal, not by default.** A tab earns a place by **utility**, meaning a
  clear link to a project, area, or pursuit the user already has, or by **novelty**, meaning it
  might open a lane the user would want to pursue. Utility is checkable, so the agent files it
  and says why. Novelty is the user's own curiosity, so the agent asks.
- **One decision per honest group.** A decision covers as many tabs as share a topic, an
  action, and a destination, and no more. Large enough that triage is much faster than going
  tab by tab; never so broad that unlike things ride along.
- **Attention where judgment is needed.** Most tabs are settled by facts the browser and the
  machine already hold. Model time, page reads, and the user's questions go to the rest, in
  that order.
- **Make a wrong close cheap.** Unchanged from the first version: a reason per item, a durable
  record, and Undo. That is what lets closing forty tabs at once feel like filing.

The fate built on these is still **digest**, widened from a verdict per tab to a route per tab.
The extension inventories, wakes, reads, applies fates, and keeps the undo log; the agent the
user already runs reads and proposes. Tabglutton is the browser-side half of that loop.

## Where it stands (0.5.2, unreleased)

| Release | Shipped                                                                                                                                                                                                                                                                                                                       |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.5.0   | `/digest` as a skill inside the Gullet package. `digest_report` and a Digest panel in the full view (worth your time, file, close, could not read), Close as one undo batch, a "Digest ready" line in the popup, and Gullet's note in the vault. YouTube transcripts in reads (#86), so a talk is no longer "could not read". |
| 0.5.1   | The Desk layout. Page facts recorded browser-side, never taken from the report (#99). Untick a close row to leave its tab open. **Move to top** in place of Keep in a group. Shift-click range selection.                                                                                                                     |
| 0.5.2   | Digest receipts (#116): closes, reopens within 48 hours, Undo, and the user's moves, shown on the digest and in "Copy diagnostics". Zotero through its local API (#119). Dedup pairs Zen's synced copies by index (#122).                                                                                                     |

Not built: the fate ledger (#80), sittings (#81), the mailbox (#82). Order by priority
([#112](https://github.com/mlsimon734/tabglutton/issues/112)) is a draft in #121 and is paused
by this revision (see Decisions).

## What the November runs found

Two runs on 2026-11-01 and 2026-11-02, titles and URLs only, nothing closed. The backlog was
805 tabs in one Zen workspace across 285 domains: x.com 137, github.com 125, arxiv.org 81,
reddit 32, YouTube 30; 95% discarded; 19 pinned.

**Round one: topic groups, one action per group.** An agent sorted all 805 tabs into 61
groups, and 93% of tabs landed in groups of five or more. The maintainer judged the topics
accurate but the actions too eager: one action per topic hid tabs that wanted different fates.
Two defects. The listing handed to the agent dropped `pinned`, so pinned tabs got proposals.
And a "Duplicates" group would have closed pages with no copy left open: in a rough check, 7
of its 24 tabs had no twin outside the group.

**Round two: a fate per tab, backed by checks.** Three of round one's groups (64 tabs) got one
fate each, with a reason citing evidence: installed apps and Homebrew packages, the agent's
skill install record, the two vaults, `gh` repo metadata, pinning. About 25 fates rested on a
check, 16 on a rule, 23 on the title. The maintainer contested **none of the 32 closes**. Of
the 20 "note" fates, 6 should have closed and 1 should have been a try. The errors fall into
four kinds, each needing a different signal:

| Miss                                                    | Signal that would have caught it                                                   |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Interesting-looking tools the user doesn't care about   | The user's interests and current projects. Only the user knows; ask, then remember |
| A launch-tweet project that didn't catch on             | How alive the repo is: last commit, commit rate, star growth                       |
| Two tabs about one thing, or a demo of another open tab | The link between them: same author or repo, one page linking the other, the opener |
| "Already looked at it enough"                           | Use already spent on it: visits, time since opened                                 |

The direction matches #79's by-hand runs, where "File" was chosen 7 times against the
maintainer's 2. The agent keeps too much, and closes well.

## The triage model

**Fates.** Each has the user's own test:

| Fate     | Test                                                            | Where it goes                                                                                                        |
| -------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Keep     | Pinned, or in use right now                                     | Stays open; never offered as a decision                                                                              |
| Track    | Is there a deadline, or is it in progress?                      | Stays open, plus a tracker entry (applications, forms, deals)                                                        |
| Readwise | Will I read or watch it start to finish and highlight it?       | Readwise Reader's queue, then closed                                                                                 |
| Note     | Might I need this again, for something I already do?            | One line in a running topic note in the vault, then closed. "To try" is a checkbox on that line, not a separate list |
| Close    | Done with it, already using it, or sure to hear about it again? | Closed, recorded in the undo log. X posts default here; the user bookmarks on X loosely to close fast                |

A note is a link and one line in a list the user may never read through. Its job is to make a
link findable outside the browser history. Readwise is a reading queue. A tab that passes both
tests goes to Readwise, and its highlights reach the vault through Readwise's own sync.

**Signal decides between keep-side and close.** A tab with **utility** (a checkable link to an
existing project or interest, and a reason to think it is or could be useful) is filed without
asking. A tab with only **novelty** is the user's call, and the agent asks. Everything else
closes. "It looked interesting" is not utility.

**The attention ladder.** Each tab climbs only as far as it needs to; what it gets is
uncertainty times stakes.

1. **Facts, no model.** Pinned; duplicates paired with the copy they keep (Dedup's rule, never
   a group of duplicates); merged or closed PRs and issues; tools already installed; URLs
   already in the vault; dead repos; X posts. Round two suggests this settles a large share.
2. **Titles plus cheap metadata, a cheap model.** What round two did.
3. **Read the page.** Only for tabs that touch a stated interest and are still uncertain. #79
   measured about 7k tokens a tab; reading 805 would be about 5.6M.
4. **Ask the user.** Questions are batched by cluster of related tabs, never one per tab. The
   answers update the interests note, so the same question is not asked twice.

**The interests note.** Projects, areas, and active pursuits, plus what the user has said no to
("not writing Rust now"). It lives in the user's vault (Hyphae, the agent-organised one), is
read by every run, and grows from the user's answers and from receipts. This is bet 6 of the
10-19 version, moved to first.

**Chains.** Half the backlog is aggregators (x.com, reddit, Hacker News) and half is what they
link to. A tweet opened a GitHub repo; the tweet may still be open. A chain is one item: the
destination is judged, and the aggregator tab goes with it. The opener is the cleanest link
(`openerTabId`, recorded at `tabs.onCreated`, which is sittings bet #81's provenance); page
links and shared authors are the fallback for tabs opened before Tabglutton recorded anything.

**A grace period.** A tab used in the last day is not backlog. It is left out of a run unless
asked for, and comes up the next day if nothing was done with it, so mildly interesting tabs
don't pile up without ever being closed early. Both engines report `lastAccessed` (all 805 tabs
on Zen did, every value distinct); neither reports when a tab was opened, so "opened two
minutes ago" needs Tabglutton to record creation time itself, the same hook as chains.

**Two lenses for review, one decision unit.** The panel shows the backlog by **site** (how many
x.com, GitHub, reddit tabs) and by **topic**. Both are ways in. The decision unit is still the
honest group: topic, action, and destination shared.

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

Ranked by how much each cuts the user's review cost without moving judgment away from them.
The cheap-wrong-close rule still holds; the runs show closes are already good, so the leverage
moved to the keep side and to the number of decisions.

1. **Signal: the interests note and the ask.** The skill reads the interests note at job time,
   files utility with its reason, asks about novelty in batches, and writes the answers back.
   No extension code; it lives in `/digest` and the vault. It goes first because every other
   bet is judged by how well the keep side is called.
2. **The fact rung of the ladder.** Pinned, paired duplicates, PR and issue state, installed
   tools, already in the vault, repo liveness. Most of it is agent-side (the skill and `gh`);
   the extension's part is making sure `tabs_list` carries what is already known (`pinned`,
   `clipped`) and that no consumer drops it.
3. **Routes out.** Note lines appended by Gullet, written to disk the way the digest mirror is
   (the agent proposes, Gullet writes, the panel shows the line); Readwise through the agent's
   own Readwise tools (Readwise ships an MCP server), not a key in the extension; track as a
   task note in the vault. Each route is one more place a close is verified before it happens.
4. **Chains and the grace period.** Record opener and creation time at `tabs.onCreated`, keyed
   by `normalizeUrl` at the first committed URL (#81's design). Gated on the provenance
   experiment below. Without it, chains fall back to page links, which cost a read.
5. **Review by site and by topic in the Digest panel.** The decision unit is the honest group;
   rows inside it can still be unticked or moved, as now. Receipts (0.5.2) count those moves.
6. **Every close in the undo log** (the narrow slice of #80). Unchanged from 10-19: worth doing
   whatever else happens, and it lets receipts count regret for every close.

## Sequence

Patch for anything the protocol survives, minor when a new capability class lands. Nothing
below bumps `BRIDGE_PROTO`.

| Release   | Contents                                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0.5.2** | As merged: receipts, Zotero local API, Zen dedup.                                                                                                             |
| **0.5.3** | The interests note and the ask in `/digest`; the fact rung; note lines through Gullet. A third run on fresh groups, closed for real, read against the bar.    |
| **later** | Chains and the grace period, after the provenance experiment. Review by site and topic in the panel. The fate ledger and mailbox only as far as receipts say. |

**The continuation bar** for a closed run: the user contests no close; at most one keep-side
fate in ten is moved to close; questions cover fewer than one tab in ten; and review takes at
most half the time of a comparable Devour session. Missing it stops panel investment, as in the
10-19 bar.

## Experiments before code

1. **Round three** (bets 1–3): fresh groups, the ladder and the interests note applied, closed
   for real with receipts on. Read against the bar.
2. **Provenance survival** (bet 4): does `openerTabId` survive on Zen after a cmd-click from an
   x.com feed, and after a restart? Does `tabs.onReplaced` fire on a Chrome discard? Does
   Zen's session restore keep `lastAccessed`, or reset it (`ENGINEERING.md` §Zen window sync
   saw equal values across restored copies)?
3. **Chrome `lastAccessed`.** Believed to need Chrome 121; the build's floor is 120. Unverified.

The Zen ordering measurement (`tabs.move`, `tabGroups.move`, collapse) moves with #121 and is
not on this path.

## What kills it

- **The digest is not trusted.** One "not worth your time" on something that mattered and the
  user goes back to hoarding. Structural answer: a reason per item, the undo log written before
  the close, undo for the batch. Receipts measure it as reopens and Undos.
- **Asking becomes the new backlog.** If every novelty tab is a question, the user is reviewing
  805 tabs again in a different form. Questions are batched by cluster and capped per run, and
  an answer is remembered. If the question rate does not fall run over run, the interests note
  is not working.
- **The notes become a second backlog.** Three thousand filed links nobody reads is the tab
  problem with extra steps. A note line is cheap only while the notes stay findable: one note
  per topic, appended, never one note per tab.
- **A page tells the agent what to do.** The agent reads untrusted web text, and now writes
  into the vault and the interests note. Agent text renders inert in the panel and the notes;
  the interests note is written only from the user's answers, never from page text; five pages
  seeded with injections get red-teamed before anything runs unattended.
- **A general agent does this without any of it.** What a user loses by switching is the
  integrated, verified cleanup (inventory at backlog scale, waking, verdicts approved in the
  browser, undo, verified filing) in Zen and Firefox, with an agent the user chooses. Re-check
  the ChatGPT extension's documentation for closing, undo, scale, and Firefox at each release.
- **Browsers ship the cleanup natively.** Safari 27 closes a whole automatic group, Dia offers
  stale-tab cleanup, Smart Window's "journeys" are coming. Keep the product on what they lack:
  routing to the user's own places, by the user's own interests, with undo.

## Cut, deferred, reversed

| Item                             | Call     | Why                                                                                                                                   |
| -------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| #73 on-device model              | Closed   | Its own question 3 is fatal: a useful verdict needs page text. The eval idea survives in #79.                                         |
| In-extension API key             | Out      | A network permission, a key in extension storage, and the store claims break. The agent the user already runs is the engine.          |
| Hub-spawned agent jobs           | Out      | Protocol bump, Gullet as launcher, unattended closes, and a hub that is not always alive. The pull mailbox gets the same keystroke.   |
| Close, then reopen the worth-its | Out      | Churn. The shortlist never closes.                                                                                                    |
| Keep in a group                  | Replaced | By Move to top in 0.5.1.                                                                                                              |
| Agent topic groups (#100)        | Revised  | Topics come back as a lens for review and a unit of decision, not as tab-strip groups. Browser grouping stays out of scope.           |
| Order by priority (#112, #121)   | Paused   | Ordering a window by verdict assumed a per-tab verdict is the unit. It may return as the order inside a group; not on the 0.5.3 path. |
| Interests are the agent's half   | Reversed | A generic memory is the agent's half. Interests built from the user's own answers and closes are something only this loop collects.   |
| Blind, labelled sittings         | Replaced | By receipts in normal use (#79).                                                                                                      |
| Full fate ledger first           | Deferred | The narrow slice (every close in the undo log) ships first; the rest waits for receipts to show how often URLs recur.                 |
| A separate try list              | Out      | "To try" is a checkbox on the topic note's line. One place per topic.                                                                 |
| Connector API upstream           | Declined | zotero-connectors#637, 2026-09-28. Shipped through the local API instead (#119).                                                      |
| Digest as a vault note first     | Reversed | The digest is read in the browser, where the sitting happened; the vault gets a mirror.                                               |
| #72 review surface               | Shrunk   | Buckets and exceptions, not a proposal per tab.                                                                                       |
| Skill outside the repo           | Reversed | `/digest` ships with Gullet so the agent half of the product exists on install.                                                       |

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

**2026-11-02.** Two titles-only runs over the maintainer's 805-tab backlog (round one by an
opus-5.5 subagent over every tab; round two over three of its groups with per-tab evidence),
reviewed by the maintainer group by group. The maintainer decided: keep for signal, with
utility filed and novelty asked; the five fates, with "to try" folded into the topic note and
X posts closing by default; attention spent by need, facts first; chains and a one-day grace
period as the next provenance work; review by site as well as by topic; topic groups back as
the decision unit, not as tab-strip groups; interests built from the user's answers, moved
from last to first; #121 paused. #116 merged as the measuring instrument for all of it.

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
