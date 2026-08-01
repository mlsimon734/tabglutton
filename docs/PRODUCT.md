# Product

## Register

product

## Users

A single power user (and users like him): a heavy, fast content consumer who lives in
Zen Browser, files knowledge into Obsidian, and runs coding agents (Claude Code, Codex)
as part of his workflow. He routinely opens dozens of tabs out of mild-to-major
interest — tweets, blog posts, GitHub repos — and needs to churn through and triage them
without ceremony. His context is a between-tasks cleanup session or a quick capture mid-flow.
He is keyboard-first and impatient with chrome that gets in the way.

## Product Purpose

Tabglutton is a cross-browser WebExtension (Zen / Firefox / Chrome) for taming tab sprawl
and capturing the signal in it. Three jobs today:

- **Dedup** — collapse duplicate tabs by normalized URL.
- **Devour** — read selected tabs through Defuddle, file them into an Obsidian vault as
  markdown notes with frontmatter, then close them. The full-screen **Devour cockpit**
  (queue + inspector + keyboard nav) is the workspace for this.
- **(Planned) Triage / agenda** — a per-tab keep / close / note / devour disposition layer
  driven by a lightweight model, so noisy one-off tabs can be cleared fast. The deeper
  "map-reduce" synthesis (linking high-signal clippings across the knowledge base) runs
  separately as a Claude Code job inside the user's Obsidian vault ("Hyphae").

Success: the user empties a 40-tab session in a couple of minutes, keeps only what matters,
and the kept material lands cleanly in Obsidian — with the tool never breaking his flow.

## Brand Personality

Appetite, warmth, craft. The product has a playful gluttony metaphor (devour / chomp /
bite out of a page stack) executed with restraint, not cartoon. Voice is dry, concise,
confident — labels are verbs (Dedup, Devour, Close), copy is terse. The feel is a warm
editorial workshop: paper-and-ink, keyboard-fast, calm under density. Personality lives in
the typography, the accent, and a few well-placed moments — never in decoration.

## Anti-references

- Generic SaaS-cream dashboards and the "hero metric + gradient accent" template.
- Over-decorated extension popups: gradient text, glassmorphism, neon, heavy drop shadows
  paired with borders, oversized rounding.
- Cartoonish "eating" mascotry. The glutton idea is a wink, not a brand bear.
- Anything that reads as "an AI generated this UI" — sketchy SVG, eyebrow kickers on every
  section, identical card grids, rainbow status colors.

## Design Principles

1. **The tool disappears into the task.** Earned familiarity over novelty. A Linear/Raycast
   user should sit down and trust it instantly. Standard affordances for standard jobs.
2. **Keyboard-first, density-friendly.** Built for fast triage: every primary action has a
   key, lists are dense but legible, nothing makes the user wait for choreography.
3. **Warmth lives in type and accent, not the background.** The paper palette is the
   substrate; identity is carried by the display serif, the terracotta accent, and rhythm.
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
