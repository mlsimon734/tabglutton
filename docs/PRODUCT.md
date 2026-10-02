# Product

## Register

product

## Users

A single power user (and users like him): a heavy, fast content consumer who lives in
Zen Browser, files knowledge into Obsidian, and runs coding agents (Claude Code, Codex)
as part of his workflow. He routinely opens dozens of tabs out of mild-to-major
interest — tweets, blog posts, GitHub repos — and wants to follow that curiosity without
accumulating decisions he must personally resolve later. His context is a between-tasks
cleanup session or a quick capture mid-flow.
He is keyboard-first and impatient with chrome that gets in the way.

## Product Purpose

Tabglutton is a cross-browser WebExtension (Zen / Firefox / Chrome) for foraging without
the executive burden of an unread, untriaged tab backlog. Opening an interesting link
should be cheap: the user explores, and delegated triage resolves what deserves attention.
Triage separates quality from immediate relevance, and every tab leaves with a fate the
ledger in [`ROADMAP.md`](ROADMAP.md) records — dropped, kept, filed, or digested, the last
being what an agent hands the unread remainder of a feed sitting: a verdict per item, a
shortlist kept open, the rest closed. The three judgments underneath:

- **Low signal** — clickbait, empty promotion, astroturf, repetition, anything that would
  waste the user's time: **dropped**.
- **Valuable and relevant now** — surfaced, or left open for the user's current work:
  **kept**.
- **Valuable, but not relevant now** — **filed** into Obsidian for later reference, then
  cleared from the browser. Filing creates no obligation to read it.

An active document or tool may need to stay open regardless of its value as reading
material; triage respects that working context as much as the user's immediate goals.

Capabilities, shipped and planned:

- **Dedup** — collapse duplicate tabs by normalized URL.
- **Devour** — read selected tabs through Defuddle, file them into an Obsidian vault as
  markdown notes with frontmatter, then close them. The full-screen **Devour cockpit**
  (queue + inspector + keyboard nav) is the workspace for this.
- **Agent bridge** — a narrow API for an external agent to list, read, file, and close
  tabs, with loading enabled separately and an undo trail for closures. Judgment lives in
  the agent, its instructions, and the user's context; the extension has no content
  classifier of its own.
- **(Planned) Digest** — the fate for the tabs a feed session leaves unresolved: an agent
  reads them, the shortlist stays open in its own tab group, the rest close behind a
  verdict per item that lives in the browser (a fate ledger the cockpit renders) and,
  optionally, mirrors into the vault. The extension proposes and applies fates; the agent
  only reads and reports. Deterministic signals first (rules, duplicates, clip memory,
  provenance), a read only for what nothing else has an opinion about. The whole plan,
  its sequence, and its experiments are in [`ROADMAP.md`](ROADMAP.md).

The deeper "map-reduce" synthesis (linking high-signal clippings across the knowledge
base) runs separately as a Claude Code job inside the user's Obsidian vault ("Hyphae").
It is optional downstream work, not something Tabglutton needs in order to deliver value.

Success: the user returns to his work with fewer decisions to make and no need to audit
every discarded tab. Measure review effort and decisions avoided alongside mistaken
dismissals, regretted closures, and whether filed references are ever retrieved.
Clearing a 40-tab session in a couple of minutes counts only if the user trusts the
result; a learning outcome or a new reading queue is not required.

## Brand Personality

Appetite, warmth, craft. The product has a playful gluttony metaphor (devour / chomp /
bite out of a page stack) executed with restraint, not cartoon. Voice is dry, concise,
confident — labels are verbs (Dedup, Devour, Close), copy is terse. The feel is a warm
editorial workshop: paper-and-ink, keyboard-fast, calm under density. Personality lives in
the typography, the accent, and a few well-placed moments — never in decoration.

## Anti-references

- Generic SaaS-cream dashboards and the "hero metric + gradient accent" template.
- Over-decorated extension popups: gradient text, decorative glassmorphism, neon, heavy drop
  shadows paired with borders, oversized rounding. The distinction that matters: frosted
  cards floating on a gradient for looks are still out; a translucent **navigation layer**
  over content that genuinely scrolls beneath it is a material, and is in. See DESIGN.md —
  content surfaces stay opaque.
- Cartoonish "eating" mascotry. The glutton idea is a wink, not a brand bear.
- Anything that reads as "an AI generated this UI" — sketchy SVG, eyebrow kickers on every
  section, identical card grids, rainbow status colors.

## Design Principles

1. **The tool disappears into the task.** Earned familiarity over novelty. A Linear/Raycast
   user should sit down and trust it instantly. Standard affordances for standard jobs.
2. **Keyboard-first, density-friendly.** Built for fast triage: every primary action has a
   key, lists are dense but legible, nothing makes the user wait for choreography.
3. **Warmth lives in type and accent, not the background.** The paper palette is the
   substrate; identity is carried by the display serif — now the wordmark alone — the
   terracotta accent, and rhythm. The UI face is the platform's own, so the one bundled
   typeface has to earn its 10 KB in a single word.
4. **Motion conveys state, never decorates.** Selection, progress, arrival, undo — that's it.
   150–250ms, ease-out, reduced-motion honored.
5. **Consistent vocabulary across surfaces.** Popup, cockpit, and options share one button
   system, one form-control set, one icon style, one set of nouns and verbs.

## Accessibility & Inclusion

- Target WCAG AA: body text ≥ 4.5:1, large/UI text ≥ 3:1, placeholders ≥ 4.5:1.
- Light and dark themes via `prefers-color-scheme`; both must pass contrast.
- `prefers-reduced-motion` honored everywhere (crossfade/instant fallbacks).
- Visible keyboard focus on every interactive element; full keyboard operability in the
  cockpit. Hit areas comfortable for pointer use on a dense surface.
