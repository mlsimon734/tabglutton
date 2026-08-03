# Launch posts

Paste-ready prose for each venue, plus posting order and comment prep.

`{{AMO}}` and `{{CWS}}` are placeholders for the store listing URLs — fill them in once both
listings are live. Every post below assumes they exist; see `STORE.md`.

---

## Posting order

Ordered so the highest-ceiling post goes out last, once the earlier ones have shaken out
the questions you'll be asked and any embarrassing first-install bugs.

| Day | Venue                      | Why here                                                           |
| --- | -------------------------- | ------------------------------------------------------------------ |
| 1   | r/zen_browser              | Smallest, friendliest, your actual users. Low risk, real feedback. |
| 2   | r/ObsidianMD               | Largest receptive audience. Biggest single source of installs.     |
| 3   | r/mcp, then X              | Technical, precise, will actually clone and try the bridge.        |
| 5   | r/firefox                  | Skeptical. Go in with install numbers and answered objections.     |
| 7   | Show HN (weekday, ~9am ET) | One shot. Everything else has de-risked it by now.                 |

Two rules that matter more than the copy:

- **Disclose that you built it**, every time. Most of these subs require it, and the ones
  that don't will still punish you for omitting it.
- **Stay in the comments for the first three hours.** On every one of these venues, reply
  rate drives ranking more than the post text does.

Check each sub's current self-promotion rule before posting — several restrict it to
particular days or require flair.

---

## 1 — r/zen_browser

**Title**

```
I made an extension for the tab problem Zen encourages you to have
```

**Body**

```
Zen is the first browser I've used that doesn't punish you for keeping 300 tabs open.
Which is lovely, right up until you need to find something.

I built Tabglutton for the cleanup pass. Two normal features and an odd third one.

**Close duplicates.** The toolbar badge counts them; the popup groups them by canonical
URL and closes them in one action. URLs get normalized before comparison — lowercased
host, `www.` and trailing slash stripped, `utm_*`/`fbclid`/`gclid`/`si` dropped, remaining
params sorted — so the same page reached from a newsletter and from Twitter matches. The
tab you touched most recently is the one kept, and Undo puts everything back in its
original position.

**File the keepers into Obsidian.** Select tabs, press Devour. Each is extracted with
Defuddle (the same library behind Obsidian's official Web Clipper), turned into markdown
with frontmatter, dropped in your vault under `Clippings/`, and closed. There's a
full-screen cockpit for this on `Alt+Shift+D` — tabs grouped by host, keyboard triage,
`j`/`k` `space` `d` `x` `/`.

**Let a coding agent do the triage.** Optional and off by default: it ships a local MCP
server, so Claude Code or Codex can list your tabs, read the promising ones, clip those
worth keeping and close the rest. Loopback only, token-authenticated, and nothing gets
closed that Undo can't reverse.

**One Zen-specific note**, because it'll come up: Zen exposes no workspace API to
extensions, so "current workspace" is a heuristic — `tab.hidden === false`. It works, but
if it ever misreads (every tab in the window reading as visible) the popup warns you and
you can fall back to plain current-window scope in settings. If anyone knows a better
signal, I would genuinely like to hear it.

MIT, no telemetry, no account, no server. Source:
https://github.com/mlsimon734/tabglutton

Firefox add-ons: {{AMO}}

I'm the developer — happy to answer anything.
```

---

## 2 — r/ObsidianMD

**Title**

```
I kept using Web Clipper one tab at a time. Then I looked up and had 400 tabs.
```

**Body**

```
Web Clipper is great when you're clipping *a* page. My problem was never one page — it was
the forty tabs I'd opened over a week that were all, in principle, things I wanted in the
vault. Clipping them one at a time was never going to happen, so they just sat in the
browser being a worse version of a notes app.

So I built a browser extension that does it in bulk. It's called Tabglutton.

You select a batch of tabs and hit Devour. Each one gets extracted with **Defuddle** — the
same library Obsidian's own Web Clipper uses, so the notes come out looking exactly like
the ones you already have — converted to markdown with frontmatter (title, source URL,
author, site, published date), filed under `Clippings/`, and the tab closes behind it.

There's a full-screen view for working through a backlog: tabs grouped by host, an
inspector that shows you the exact vault path each note will land at before you commit,
and keyboard triage the whole way (`j`/`k` to move, `space` to select, `d` to devour, `/`
to filter). It also finds and collapses duplicate tabs first, which on a real backlog
removes a surprising fraction of the work before you make a single decision.

Everything is local. It goes into your vault through `obsidian://`, exactly like Web
Clipper does. No account, no server, no telemetry, and the source is public.

There's also an optional piece I'll mention briefly because some of you will want it: it
can expose your open tabs to a local coding agent over MCP, so you can ask Claude to go
through the backlog, clip what's worth keeping and close the rest. That's off by default
and gated behind a token.

Source: https://github.com/mlsimon734/tabglutton
Firefox: {{AMO}} · Chrome: {{CWS}}

I built this for my own vault and I'm the developer, so ask me anything — and I'd
especially like to hear how people want the frontmatter shaped, since mine is just what
worked for me.
```

The closing question is doing real work: it invites the comment this sub always produces
anyway, and turns "here's my thing" into "help me shape my thing."

---

## 3 — r/mcp

**Title**

```
Tabglutton — an MCP server that exposes your live browser tabs: list, read, clip, close, undo
```

**Body**

````
Most browser MCP servers drive a *separate* automated browser. This one attaches to the
browser you already have open, with your sessions and your 400-tab backlog in it.

It's a WebExtension (Firefox/Zen/Chrome) plus a zero-dependency Bun sidecar. The extension
dials a loopback WebSocket; the sidecar is the MCP server your agent spawns over stdio.

| Tool         | What it does                                                    |
| ------------ | --------------------------------------------------------------- |
| `tabs_list`  | Metadata for every tab — no content, so it's cheap at any scale |
| `tabs_load`  | Wake tabs the browser discarded, so they can be read            |
| `tab_read`   | Full Defuddle extraction of one page as markdown                |
| `tab_clip`   | File a tab into Obsidian, optionally closing it                 |
| `tabs_close` | Close a batch, returns a `batchId`                              |
| `undo_close` | Reverse any batch                                               |

**The design problem that shaped it** is that reading 400 pages is unaffordable, so the
tool descriptions themselves push the model into triaging on metadata first — title, URL,
`lastAccessed` — and calling `tab_read` only on survivors. Getting that into the tool
description rather than hoping the caller figures it out made the difference between a
useful run and a very expensive one.

**Safety, since this is a tool that closes things:**

- Off until you turn it on. No socket is opened while it's off.
- Loopback bind, plus origin check. Both ends prove knowledge of a shared token against a
  nonce the other chose, so the token never crosses the wire.
- Waking tabs is a *second*, separate opt-in — it's the only method that acts on a page
  rather than reading one.
- Nothing is closed that the undo log couldn't put back. If a tab can't be recorded, it's
  left open and reported as skipped. `closed` always equals the number of reversible
  entries.

Several agent sessions can share one browser — the first process to bind the port becomes
the hub and later ones attach as peers and proxy through it, because nothing guarantees
one sidecar per session (a single `codex` process was observed spawning two).

Setup is a token from the extension's settings page, written once with its copyable setup
command, and one MCP entry:

```json
{
  "mcpServers": {
    "tabglutton": {
      "command": "bunx",
      "args": ["tabglutton-gullet"]
    }
  }
}
```

Source and the full wire protocol: https://github.com/mlsimon734/tabglutton
(`docs/BRIDGE.md` has the design rationale and a long catalogue of browser quirks that cost me
real time.)

I'm the author. Interested in what breaks it.
````

**Reuse for r/ClaudeAI** with a different framing — that sub responds to outcome, not
architecture:

```
Title: I gave Claude Code access to my actual browser tabs and had it clear a 400-tab backlog

Body: open with the transcript-shaped version — "go through my open tabs, tell me what's
worth keeping, clip those into Obsidian and close the rest" — then what it actually did
(triaged on metadata, read ~30, clipped 12, closed 300+), then the safety paragraph above,
then the link. Keep the tool table; drop the hub/peer election and the JSON block.
```

---

## 4 — X thread

```
1/ I kept 400 tabs open because closing them felt like losing them.

So I built a browser extension that reads them, files the good ones into Obsidian as
markdown, and closes the rest. It also ships an MCP server, so Claude Code can do the
triage for me.

2/ First it collapses duplicates. URLs get canonicalized before comparison — tracking
params dropped, host lowercased, params sorted — so the same article reached from a
newsletter and from a group chat finally matches.

On a real backlog this alone clears a double-digit percentage.

3/ Then: select tabs, press Devour.

Each one is extracted with Defuddle (the library behind Obsidian's own Web Clipper),
converted to markdown with frontmatter, filed under Clippings/, and closed.

There's a full-screen cockpit for it. Keyboard the whole way.

4/ The part I actually built it for:

Turn on the bridge, point Claude Code at it, and your agent gets six tools over your live
tabs — list, load, read, clip, close, undo.

"Go through my tabs, keep what matters, close the noise" is now a thing you can just ask.

5/ It's careful about the closing.

Loopback only. Token auth where the token never crosses the wire. Off by default. Waking
a tab is a separate opt-in.

And nothing is ever closed that undo couldn't put back — if a tab can't be recorded, it
stays open.

6/ No telemetry, no account, no server. MIT.

Firefox: {{AMO}}
Chrome: {{CWS}}
Source: github.com/mlsimon734/tabglutton
```

Post 3 or 5 with the cockpit screenshot attached; a thread with one image outperforms one
with none, and more than two dilutes.

---

## 5 — r/firefox

Shorter and flatter than the others on purpose. This sub reads enthusiasm as advertising.

**Title**

```
Tabglutton — MV3 extension for closing duplicate tabs and saving the rest into Obsidian
```

**Body**

```
I wrote a tab extension and it's now on AMO, so: {{AMO}}. Source is MIT at
https://github.com/mlsimon734/tabglutton. I'm the developer.

What it does:

- Finds duplicate tabs by canonical URL (tracking params stripped, host lowercased,
  params sorted) and closes them in one action, keeping whichever you touched most
  recently. Undo restores original positions.
- Extracts selected tabs with Defuddle and writes them into an Obsidian vault as markdown
  with frontmatter, then closes them.
- Optionally exposes those same operations to a local MCP server, so a coding agent can
  triage a backlog for you. Off by default.

Since it'll be the first question: **it requests `<all_urls>`, and here's exactly why.**
Clipping means injecting an article extractor into a page you picked, and there's no way
to know in advance which pages those are. But it declares no content scripts and runs
nothing on page load — injection happens through `scripting.executeScript`, against one
specific tab, only when you press the button. Pages you haven't selected are never
touched. If you never clip anything and only use the dedup, nothing is ever injected at
all.

No analytics, no telemetry, no remote server, no account. Page content goes exactly two
places, both on your own machine: your vault, and (only if you enable it) a loopback
socket to an MCP server you started yourself.

Works on regular Firefox and on Zen; there's a Zen-specific workspace heuristic because
Zen gives extensions no workspace API.
```

Leading with the permission question rather than waiting for it is the whole strategy
here. On r/firefox the top comment on any extension post is about permissions, and
answering it in the post means the top comment is about something else.

---

## 6 — Show HN

**Title** — recommended:

```
Show HN: Tabglutton – Tab dedup and Obsidian clipping, drivable by an MCP agent
```

Alternative if you'd rather lead with the novel part (`Show HN: Tabglutton – A browser
extension your coding agent can drive`). The first is more honest about what most people
will use it for; the second gets more clicks. Both are under HN's 80-character limit.

**Post text** — keep it short. HN treats a long submission text as a press release.

```
I open thirty tabs a day out of mild interest and close almost none of them, on the theory
that closing a tab loses the thing. Tabglutton is what I built to stop believing that.

It does three things: collapses duplicate tabs by canonical URL, extracts selected tabs
with Defuddle and files them into an Obsidian vault as markdown before closing them, and —
the part I actually find interesting — ships a local MCP server so a coding agent can do
the triage. Six tools over your live browser tabs: list, load, read, clip, close, undo.
Every close is reversible by construction: a tab that can't be recorded in the undo log is
left open rather than closed.

It's a WebExtension for Firefox/Zen/Chrome plus a zero-dependency Bun sidecar. MIT, no
telemetry, no server, no account.

The cross-browser work was much worse than the feature work, and I wrote most of it down —
Chrome mints a new tab id every time it discards a tab, Firefox's default MV3 CSP silently
upgrades ws://127.0.0.1 to wss:// and breaks loopback WebSockets, and Gecko has an
undocumented escalating penalty for reconnecting to a port that has been refusing. Details
in AGENTS.md if that's your kind of thing.

https://github.com/mlsimon734/tabglutton
```

**First comment**, posted immediately after — this is where the depth goes, and on HN it
reliably outperforms putting it in the submission:

```
Three things that cost me the most time, in case they save someone else some:

**Chrome assigns a new tab id when it discards a tab.** Verified: `chrome.tabs.discard(766110265)`
returns a tab with id `766110267`. Firefox keeps the id. Any flow that lists tabs and acts
on them later — which is the entire shape of an agent triaging a backlog — can therefore
meet ids that no longer resolve even though the tabs are still there. Worse, Chrome's
`tabs.remove` isn't atomic over a batch: it removes in order and rejects at the first id
that doesn't resolve, so the tabs ahead of it close and the ones behind it don't, and the
call reports failure for all of them. The fix is to treat a rejection as a demotion — retry
each id alone, then ask the browser which ids still exist, and trust *absence* rather than
the retry's own result.

**Firefox's default MV3 extension CSP includes `upgrade-insecure-requests`, and it rewrites
WebSocket URLs.** `ws://127.0.0.1:4589/` silently becomes `wss://`. Loopback is not
exempted. The sidecar then receives a TLS ClientHello, so its request handler never runs
and the connection is invisible from both ends — nothing in the server log, and the
extension sees only close code 1015. Declaring `content_security_policy.extension_pages`
explicitly drops the directive.

**Gecko delays reconnects to a WebSocket endpoint that has been refusing**
(`network.websocket.delay-failed-reconnects`), and applies the delay *before* issuing the
TCP connect — so the socket sits in CONNECTING with nothing for `lsof` to see. The delay
grows 1.5x per failed connect and caps at 60s. A reconnect loop polling an empty port
reaches the ceiling in about a minute, which presents as "extension won't connect" with
every component healthy. The actual fix wasn't a longer timeout, it was to stop dialling
blind: probe the port with a plain `fetch` first, which doesn't feed the penalty, and only
open a socket if something answers.

The last one I chased for two days through three progressively longer timeouts, each of
which made it worse, because a shorter deadline meant more failed connects, which meant a
longer penalty.
```

That closing line is the comment's whole payload. Debugging stories where the obvious fix
made things worse are the single most reliable HN comment shape.

---

## Comment prep

The questions you will get, in rough order of certainty.

**"How is this different from [any of the fifty duplicate-tab extensions]?"**
The dedup isn't the point and isn't novel; canonicalization quality and the undo are the
only places it's better. The point is what happens to the tabs that _aren't_ duplicates —
they become notes instead of staying tabs. No other tab extension has an agent bridge.

**"Why not just use Web Clipper?"** (r/ObsidianMD)
You should — for one page. This is for forty, and it closes them behind you. Same
extractor, so the notes are identical.

**"`<all_urls>` is a lot of permission."** (r/firefox, HN)
Answer in `PRIVACY.md`, and pre-empted in the r/firefox post. Short version: capability,
not behaviour — no declared content scripts, injection only on explicit action against one
named tab. Pure dedup use never injects anything. If pressed on why it isn't optional:
it's a fair ask and worth doing, but it isn't done today — say so rather than arguing.

**"Isn't letting an LLM close my tabs insane?"**
Yes, which is why closing is the one thing that's structurally reversible. The undo log is
written before the removal, a tab that can't be recorded is left open, and `closed` never
exceeds the number of entries undo can restore. The failure mode is leaving tabs open, not
losing them.

**"Does it work on Safari / Arc / Vivaldi / Orion?"**
Chromium builds should load in Vivaldi/Brave/Edge unpacked but are untested; say so
plainly. Safari needs a native wrapper and is not planned.

**"Obsidian-only? What about Notion / Logseq / plain files?"**
True today. The extraction is separate from the destination, so other targets are
tractable. Don't promise a date.

**"Why is it called that?"**
Don't over-explain. "It eats tabs" is the whole joke.

---

## After posting

- Fill the real install counts into the r/firefox post's opening if it's going out later
  in the week — "it's now on AMO with ~N users" reads very differently from "I made a
  thing."
- Watch for the same question appearing in three venues; that's a README fix, not a
  comment reply.
- The demo GIF slot in the README is still empty. If any of these posts get traction, that
  is the highest-value asset left unbuilt — a 20-second recording of a real backlog being
  emptied will outperform every screenshot here.
