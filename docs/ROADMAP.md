# Roadmap: Digest

_Written 2026-09-05 against `main` at eccff8d. Decisions recorded at the end; the
measured histories that come out of this land in `ENGINEERING.md` as they are made._

## Thesis

Tabglutton today is a set of verbs over a live tab query — Dedup, Devour, Close — and six
MCP tools for an agent the user drives by hand. The job it is for is bigger: the user opens
dozens of links from feeds (x.com, reddit, LessWrong, YouTube) out of interest, reads the
few that matter, and is left with the rest open and unresolved. The tool's job is to take
that remainder off his hands without losing anything.

Three ideas carry the plan:

- **An item with a fate, not a tab.** Nothing leaves the browser without a recorded fate —
  `kept`, `filed`, `dropped`, `digested` — and every fate stays recallable.
- **A sitting, not a session.** The batch that matters is the tabs opened from one visit to
  one feed. "The 70% left over" is a sitting minus what got read.
- **Make a wrong close cheap.** The remainder is not a classification problem; the user
  already knows he will not read it. It is loss aversion. So the leverage is not in getting
  keep-or-close right, it is in making being wrong about a close cheap: a verdict with a
  quote and the URL, a durable record, and undo. That is what makes closing forty tabs at
  once feel like filing.

The new fate is **digest**: an agent reads the remainder, the shortlist stays open in its own
tab group, and the rest close behind a verdict per item. The verdicts live in the browser —
the cockpit renders them from the ledger, the popup announces them — and mirror into the
vault as a note when the user wants that. The extension proposes and applies fates; the
agent only reads and reports.

## Where the plan on file stopped short

- The agenda issues ([#71](https://github.com/mlsimon734/tabglutton/issues/71),
  [#72](https://github.com/mlsimon734/tabglutton/issues/72)) proposed keep, close, devour,
  zotero, and a visible _no opinion_ bucket. That bucket is the 70%, and the only answer on
  file for it was that a model might guess later.
- The on-device spike ([#73](https://github.com/mlsimon734/tabglutton/issues/73), now
  closed) asked a model to guess from title and URL. Its own third question conceded the
  fatal part: a useful verdict needs page text, which means waking the tab, which it called
  "a completely different feature". That feature is the product.
- The curation workflow was deferred to a skill "deliberately not in this repo"
  (`BRIDGE.md` §Phasing, item 3). Nothing shipped it, so the agent half of the product
  existed only when the user wrote the prompt by hand.
- A close from the popup or the cockpit lives in a six-second toast
  (`popup/devour.ts`, `showUndoToast`); only bridge closes reach the undo log, and it keeps
  20 batches or 500 entries (`src/undo-log.ts`). Nothing records when a tab was opened or
  from where: `lastAccessed` is the last view, not the birth, and `openerTabId` is unused.

## The bets, ranked

Ranked by how much each lowers the cost of a wrong close. Each carries a measurable done bar
in its issue.

1. **Digest** ([#79](https://github.com/mlsimon734/tabglutton/issues/79) by hand,
   [#83](https://github.com/mlsimon734/tabglutton/issues/83) as a surface). An agent reads
   every tab in the bucket and sorts it into a shortlist and a remainder. The shortlist stays
   open, collected into a "Worth your time" tab group through the `tabGroups` permission the
   extension already holds. The remainder closes as one undo batch behind a verdict per item:
   a paragraph, a one-line quote, the interest matched, and the URL for a shortlisted item; a
   single line for everything else, because a paragraph per low-value item is a second
   backlog. The digest is read in the browser — popup announcement, a cockpit view grouped by
   sitting, one approve — and mirrored into the vault through the existing clip destination
   path when the "Also file digests to my vault" setting is on (default on, since that is
   what the deeper Hyphae synthesis reads). The mirror is confirmed like any clip and never
   gates the close.
2. **A fate ledger, and every close recorded**
   ([#80](https://github.com/mlsimon734/tabglutton/issues/80)). `src/clip-memory.ts`
   generalises from "clipped?" to a record per URL with a fate, its evidence, and for
   `digested` the verdict. Popup and cockpit closes go through the same undo log the bridge
   uses, with retention raised. Rules stay standing decisions; fates are per-item outcomes;
   `digest` is not a `RuleDisposition`.
3. **A job mailbox the agent pulls from**
   ([#82](https://github.com/mlsimon734/tabglutton/issues/82)). The cockpit queues an intent
   in extension storage; two additive, model-callable methods, `jobs_pull` and `job_report`,
   let a running Claude Code or Codex session pick it up and report structured verdicts back.
   The agent never closes; the extension applies fates on approval, or immediately under an
   explicit "apply digests without review" setting. No `BRIDGE_PROTO` bump. Unattended runs
   come later as a `tabglutton-gullet digest` CLI subcommand the user schedules, which runs
   the configured harness once over the queue. The hub never spawns on a wire request.
4. **Sittings** ([#81](https://github.com/mlsimon734/tabglutton/issues/81)). Provenance
   recorded at `tabs.onCreated` — first-seen, opener URL, sitting id — and keyed by
   `normalizeUrl` at the first committed `onUpdated`, never by tab id. A column of the
   ledger.
5. **Agenda, recast** ([#71](https://github.com/mlsimon734/tabglutton/issues/71) as
   specified, [#72](https://github.com/mlsimon734/tabglutton/issues/72) shrunk). Buckets
   with counts and an exceptions list, one approve, not a proposal per tab. Feed-born tabs
   no rule claims default to digest; the no-opinion bucket stays visible for tabs with
   neither provenance nor rule. The review-tax experiment ships with it.
6. **Interests from the vault, feed-native reads, and the horizon.** The digest skill reads
   an interests note and the vault's own maps of content at job time, cites the match per
   item, links related notes, and folds overrides into the next run. Defuddle 0.19.3 already
   ships extractors for x.com threads, reddit, Hacker News, Substack, Bluesky, and YouTube
   with a caption-track path; whether `tab_read` returns a transcript is unverified and is
   measured in #79. Acquisition has a ladder worth keeping in view — metadata, then the tab
   woken through `tabs_load`, then a cookie-less fetch from Gullet for public pages
   (described in `BRIDGE.md` §The discarded-tab problem, item 2, and not built). The horizon
   bet, a release or two out: **harvest the feed, not the tabs** — run the same extractors on
   the feed page so interesting links become ledger items without becoming tabs. A different
   product, a reader; it waits until the ledger exists to receive its output.

## Sequence

Patch for anything the protocol survives, minor when a new capability class lands. Nothing
below bumps `BRIDGE_PROTO`.

| Release   | Contents                                                                                                                                                                                                                                                                   |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0.4.2** | `/digest` shipped as a skill inside the Gullet package, driving the six tools that exist; three sittings digested by hand, blind; the extraction matrix; the README's privacy sentence gains its third place (#79, this PR).                                               |
| **0.5.0** | Fate ledger over clip memory, every close written to the undo log (#80). Sittings recorded at creation (#81). Agenda buckets in the cockpit with digest as the default for the 70% (#71, #72). #73 closed.                                                                 |
| **0.6.0** | `jobs_pull` and `job_report`; the cockpit queues, an agent pulls (#82). The digest surface: popup announcement, cockpit view, shortlist into a tab group, vault mirror by setting (#83). Interests and overrides in the skill's prompt. Then the scheduled CLI subcommand. |

## Experiments before code

1. **Digest three real sittings by hand** with the existing tools, blind: the user marks his
   own top five before seeing the agent's shortlist. Measure minutes, tokens, shortlist
   overlap, and, 48 hours later, whether any closed item is missed. If overlap is poor or
   things are missed, the digest bet is wrong and the ledger is the whole product.
2. **An extraction matrix**: about fifty tabs across x.com threads, reddit, LessWrong,
   YouTube, Substack, and Hacker News through `tab_read`. Record route, latency, words, and
   failure reason. A login wall must come back as `thin`, never as a verdict.
3. **Provenance survival**: does `openerTabId` survive on Zen after a cmd-click from an x.com
   feed, and after a restart? Does `tabs.onReplaced` fire on a Chrome discard?
4. **The review tax**, before 0.5.0 ships: alternate agenda-first and select-first sessions on
   comparable backlogs and count time, keystrokes, overrides, and undos. This is #72's own
   open question, answered with numbers.

## What kills it

- **The digest is not trusted.** One "not worth your time" on something that mattered and
  the user goes back to hoarding. Structural answer: the quote and URL per item, the ledger
  written before the close, undo for the batch. Experiment 1 measures it.
- **The ledger becomes a second backlog.** Three thousand digested items nobody reads is the
  tab problem with extra steps. Ship it with a hard cap and search only; if search is never
  used, cap harder and stop investing.
- **A page tells the agent what to do.** The digest agent reads untrusted web text;
  `BRIDGE.md` §Security model already warns that page text can widen what an agent reads and
  persist instructions into a trusted vault. The skill restricts the agent to the Tabglutton
  tools plus one output folder, the mirrored note is marked web-derived, and five pages
  seeded with explicit injections get red-teamed before 0.6.0 ships.
- **A general agent does this without any of it.** The moat is not the tool list. It is the
  ledger — no re-reading what was filed, honest age, what closed last month — and the
  verification discipline. If a bare agent with `tabs_list` and `tab_read` turns out to
  manage those three, the bets need rethinking.

## Cut, deferred, reversed

| Item                             | Call     | Why                                                                                                                                 |
| -------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| #73 on-device model              | Closed   | Its own question 3 is fatal. The eval idea survives in #79.                                                                         |
| In-extension API key             | Out      | A network permission, a key in extension storage, and the store claims break. The agent the user already runs is the engine.        |
| Hub-spawned agent jobs           | Out      | Protocol bump, Gullet as launcher, unattended closes, and a hub that is not always alive. The pull mailbox gets the same keystroke. |
| Close, then reopen the worth-its | Out      | Churn. The shortlist never closes; it moves into a tab group.                                                                       |
| Digest as a vault note first     | Reversed | The digest is read in the browser, where the sitting happened; the vault gets a mirror by setting.                                  |
| #72 review surface               | Shrunk   | Buckets and exceptions, not a proposal per tab. The thin slice ships with #71 so the review-tax question gets an answer.            |
| Skill outside the repo           | Reversed | `/digest` ships with Gullet so the agent half of the product exists on install.                                                     |

## Decisions (2026-09-05)

Two independent reads went in with the same brief — opus-5 and a Codex run on
gpt-5.6-sol — and changed the draft: provenance keyed by URL rather than tab id and timed
at the URL commit; a pull mailbox instead of hub-spawned jobs, with the queue in extension
storage because the hub is not always alive; the shortlist kept open rather than closed
and reopened; one line rather than a paragraph for the remainder; prompt injection named as
a risk; the privacy sentence's third place. One objection was not taken: that the mailbox
methods should not sit in `BRIDGE_METHODS` because it doubles as the model-callable tool
list — for a pull mailbox, being model-callable is the point.

The maintainer decided: digest as the fate for the 70% with "cheap wrong close" as the
ranking rule; the mailbox as the engine; the by-hand experiment before extension code;
#73 closed and #72 shrunk; the shortlist kept open in a tab group; and — the one
question he raised — the digest read **in the browser, in flow**, with the vault as a
mirror, not the primary surface. His framing for the whole direction: a browsing and
information assistant of the kind the platform vendors are converging on, done with more
control and discipline — a local ledger, evidence per verdict, reversible closes, a
swappable agent, no account.
