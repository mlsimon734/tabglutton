// The digest's markdown note, written by Gullet straight to disk.
//
// Gullet rather than the extension, because Gullet can see the disk: the note
// lands or it does not, and the answer is known here instead of being handed to
// `obsidian://` and hoped for (docs/ENGINEERING.md §Clip verification). No URI
// either, so no size ceiling on a 150-item digest.
//
// The note is generated from the structured record the extension stored, never
// from markdown an agent wrote. Every string in that record is web-derived text
// relayed by a model, so the rendering here is load-bearing: the parser has
// already collapsed every newline (no heading, fence, or frontmatter can be
// opened), and `escapeMarkdownInline` backslash-escapes what Obsidian would
// otherwise read as markup, a link, an embed, or a Dataview inline query.

import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
  asRecord,
  DIGEST_FATES,
  digestCounts,
  type DigestNoteItem,
  type DigestNoteSource,
  type DigestUnreadable,
} from "../../src/bridge-protocol.js";
import type { ObsidianVaultPaths } from "./obsidian-vaults.js";

export interface DigestMirrorConfig {
  enabled: boolean;
  /**
   * Relative: a folder in the user's configured Obsidian vault. Absolute: that
   * directory itself, vault or not — which is also how a test points the
   * mirror somewhere harmless.
   */
  folder: string;
}

export const DEFAULT_DIGEST_MIRROR: DigestMirrorConfig = { enabled: true, folder: "Digests" };

export type DigestMirrorOutcome =
  | { state: "written"; file: string; existed: boolean }
  | { state: "failed"; reason: string }
  | { state: "off" };

/** Write one digest's note. `vault` is the extension's configured vault, when it offered one. */
export type DigestMirror = (
  note: DigestNoteSource,
  vault: string | undefined,
) => Promise<DigestMirrorOutcome>;

/**
 * The stored digest the extension hands back, checked before a note is written
 * from it. It came from our own extension, so this guards against version skew
 * and a malformed reply rather than an adversary — but it is a file write, and
 * the check is cheap.
 */
export function isDigestNoteSource(value: unknown): value is DigestNoteSource {
  const o = asRecord(value);
  const sitting = asRecord(o?.sitting);
  const reporter = asRecord(o?.reporter);
  return (
    o !== null &&
    typeof o.id === "string" &&
    /^[0-9a-f]{32}$/.test(o.id) &&
    typeof o.receivedAt === "number" &&
    reporter !== null &&
    sitting !== null &&
    Array.isArray(sitting.sources) &&
    sitting.sources.every((s) => typeof s === "string") &&
    Array.isArray(o.items) &&
    o.items.length > 0 &&
    o.items.every((raw) => {
      const item = asRecord(raw);
      return (
        item !== null &&
        typeof item.url === "string" &&
        typeof item.title === "string" &&
        typeof item.reason === "string" &&
        (DIGEST_FATES as readonly unknown[]).includes(item.fate)
      );
    })
  );
}

// --- encoding -----------------------------------------------------------------

/**
 * A YAML double-quoted scalar. JSON's string syntax is a subset of YAML's
 * double-quoted style, so `JSON.stringify` is the encoder; the three characters
 * YAML treats as line breaks and JSON leaves raw are escaped on top of it.
 */
export function yamlString(value: string): string {
  return JSON.stringify(value)
    .replace(/\u0085/g, "\\N")
    .replace(/\u2028/g, "\\L")
    .replace(/\u2029/g, "\\P");
}

/**
 * Agent text bound for a frontmatter value. Obsidian's Properties view renders
 * a `[[...]]` inside a text property as a live link whatever the quoting, so
 * brackets are turned into parentheses before encoding.
 */
export function yamlText(value: string): string {
  return yamlString(value.replace(/\[/g, "(").replace(/\]/g, ")"));
}

export function yamlStringArray(values: readonly string[]): string {
  return `[${values.map(yamlText).join(", ")}]`;
}

/**
 * Backslash-escape everything Obsidian might read as syntax in running text:
 * emphasis, code spans (and with them `$= dv…` Dataview inline JS), links and
 * wikilinks, embeds, raw HTML, headings, tables, highlights, math, comments,
 * block references. CommonMark lets any ASCII punctuation be escaped, so an
 * over-eager escape costs nothing but a backslash in the source. `-`, `+` and
 * `>` only open a list or quote at the start of a line, and every escaped
 * string here is placed after a list marker, so those need no escape as
 * blocks (`>` is escaped anyway, for HTML).
 */
export function escapeMarkdownInline(text: string): string {
  return text.replace(/[\\`*_[\]()<>#|~$=!%^]/g, (c) => `\\${c}`);
}

/**
 * A URL for the `(...)` of a markdown link: characters that would end the
 * destination, open a title, or start HTML are percent-encoded. The URL is
 * already known to be http(s) — the wire parser refused anything else.
 */
export function markdownLinkUrl(url: string): string {
  return url.replace(
    /[\s()<>"'`\\[\]]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

function hostOf(url: string): string {
  try {
    const host = new URL(url).hostname;
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return url;
  }
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function localTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const UNREADABLE_LABELS: Record<DigestUnreadable, string> = {
  thin: "too thin to read",
  "login-wall": "login wall",
  "bot-check": "bot check",
  "no-transcript": "no transcript",
  "pdf-viewer": "PDF viewer",
  discarded: "unloaded",
  other: "could not read",
};

export function unreadableLabel(value: DigestUnreadable | undefined): string {
  return value ? UNREADABLE_LABELS[value] : "could not read";
}

/** Characters no filename on any of the three desktop platforms may hold, plus Obsidian's link syntax. */
// oxlint-disable-next-line no-control-regex
const FILENAME_UNSAFE = /[\\/:*?"<>|#^[\]\u0000-\u001f\u007f]/g;

/** `<YYYY-MM-DD> <sources | label | "tabs">`, the shape the skill always wrote. */
export function digestNoteName(note: DigestNoteSource): string {
  const subject =
    note.sitting.sources.length > 0 ? note.sitting.sources.join(" ") : note.sitting.label || "tabs";
  const clean = subject
    .replace(FILENAME_UNSAFE, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 120)
    .trim();
  return `${localDate(note.receivedAt)} ${clean || "tabs"}`;
}

function linkFor(item: DigestNoteItem): string {
  const text = escapeMarkdownInline(item.title || hostOf(item.url));
  return `[${text}](${markdownLinkUrl(item.url)})`;
}

function outbound(item: DigestNoteItem): string {
  if (!item.link) return "";
  return ` · links to [${escapeMarkdownInline(hostOf(item.link))}](${markdownLinkUrl(item.link)})`;
}

function interestOrNone(item: DigestNoteItem): string {
  return item.interest ? escapeMarkdownInline(item.interest) : "no match";
}

/**
 * The note, from the stored record. Sections follow the agent's fates, not the
 * user's later moves: this is a mirror of the digest, written once. Browser
 * facts (`sitting_observed`) and the client's self-description
 * (`reported_by_client`) keep separate keys from the agent's counts.
 */
export function markdownForDigest(note: DigestNoteSource): string {
  const counts = digestCounts(note.items);
  const { firstAccessed, lastAccessed } = note.sitting;
  const client = [note.reporter.client, note.reporter.clientVersion].filter(Boolean).join(" ");
  const lines: string[] = [
    "---",
    "type: digest",
    `digest_id: ${yamlString(note.id)}`,
    `received: ${yamlString(`${localDate(note.receivedAt)} ${localTime(note.receivedAt)}`)}`,
  ];
  if (firstAccessed !== undefined && lastAccessed !== undefined) {
    const span =
      localDate(firstAccessed) === localDate(lastAccessed)
        ? `${localDate(firstAccessed)} ${localTime(firstAccessed)} → ${localTime(lastAccessed)}`
        : `${localDate(firstAccessed)} ${localTime(firstAccessed)} → ${localDate(lastAccessed)} ${localTime(lastAccessed)}`;
    lines.push(`sitting_observed: ${yamlString(span)}`);
  }
  lines.push(`sources: ${yamlStringArray(note.sitting.sources)}`);
  if (note.sitting.label) lines.push(`label: ${yamlText(note.sitting.label)}`);
  lines.push(
    `items: ${note.items.length}`,
    `worth_it: ${counts["worth-it"]}`,
    `file: ${counts.file}`,
    `close: ${counts.close}`,
    `could_not_read: ${counts["could-not-read"]}`,
    `reported_by_client: ${yamlText(client ? `${client} (self-reported)` : "unknown")}`,
  );
  if (note.reporter.gullet) lines.push(`gullet: ${yamlText(note.reporter.gullet)}`);
  lines.push(`content: ${yamlString("web-derived, untrusted")}`, "---", "");

  const section = (
    title: string,
    items: DigestNoteItem[],
    render: (item: DigestNoteItem) => string[],
  ): void => {
    if (items.length === 0) return;
    lines.push(`## ${title.replace("{n}", String(items.length))}`, "");
    for (const item of items) lines.push(...render(item));
    lines.push("");
  };
  const byFate = (fate: DigestNoteItem["fate"]) => note.items.filter((i) => i.fate === fate);

  section("Worth your time ({n}) · kept open", byFate("worth-it"), (item) => {
    const detail = [`matches: ${interestOrNone(item)}`];
    if (item.quote) detail.push(`"${escapeMarkdownInline(item.quote)}"`);
    return [
      `- ${linkFor(item)} — ${escapeMarkdownInline(item.reason)}${outbound(item)}`,
      `  ${detail.join(" · ")}`,
    ];
  });
  section("File for reference ({n})", byFate("file"), (item) => [
    `- ${linkFor(item)} — ${escapeMarkdownInline(item.reason)} · ${interestOrNone(item)}${outbound(item)}`,
  ]);
  section("Close ({n})", byFate("close"), (item) => [
    `- ${linkFor(item)} — ${escapeMarkdownInline(item.reason)} · ${interestOrNone(item)}${outbound(item)}`,
  ]);
  section("Could not read ({n}) · kept open", byFate("could-not-read"), (item) => [
    `- ${linkFor(item)} — ${unreadableLabel(item.unreadable)} · ${escapeMarkdownInline(item.reason)}`,
  ]);
  return `${lines.join("\n").trimEnd()}\n`;
}

/** The `digest_id` a note on disk carries, or null. The idempotency key. */
export function noteDigestId(content: string): string | null {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1];
  if (frontmatter === undefined) return null;
  return /^digest_id:[ \t]*"([0-9a-f]{32})"[ \t]*$/m.exec(frontmatter)?.[1] ?? null;
}

// --- writing ------------------------------------------------------------------

export interface DigestMirrorFs {
  mkdir: (dir: string) => Promise<void>;
  /** Text, or null when absent. */
  read: (path: string) => Promise<string | null>;
  write: (path: string, content: string) => Promise<void>;
  /** Hard-link `from` to `to`; rejects with code EEXIST when `to` exists. */
  link: (from: string, to: string) => Promise<void>;
  unlink: (path: string) => Promise<void>;
}

const nodeFs: DigestMirrorFs = {
  mkdir: async (dir) => {
    await mkdir(dir, { recursive: true });
  },
  read: async (path) => {
    try {
      return await readFile(path, "utf8");
    } catch (err) {
      if ((err as { code?: unknown }).code === "ENOENT") return null;
      throw err;
    }
  },
  write: (path, content) => writeFile(path, content, { encoding: "utf8", flag: "wx" }),
  link: (from, to) => link(from, to),
  unlink: (path) => unlink(path),
};

/** Same-named notes tried before giving up: `name.md`, `name 2.md`, … */
const NAME_ATTEMPTS = 20;

/**
 * Write `content` as `<dir>/<base>.md` atomically and only if that file does
 * not exist. A note already there carrying this digest's id **is** this
 * digest's note — the retry that finds it reports it and writes nothing, which
 * is what makes a re-sent report land exactly once. A same-named note for a
 * different digest (two sittings of one feed on one day) moves to `base 2.md`.
 *
 * Atomic by construction: the text goes to a dotfile first (Obsidian ignores
 * those) and is hard-linked into place, which fails rather than overwrites if
 * the name was taken in between. A reader never sees a half-written note.
 */
export async function writeDigestNote(
  dir: string,
  base: string,
  content: string,
  digestId: string,
  fs: DigestMirrorFs = nodeFs,
): Promise<{ file: string; existed: boolean }> {
  await fs.mkdir(dir);
  for (let n = 1; n <= NAME_ATTEMPTS; n++) {
    const file = join(dir, n === 1 ? `${base}.md` : `${base} ${n}.md`);
    const existing = await fs.read(file);
    if (existing !== null) {
      if (noteDigestId(existing) === digestId) return { file, existed: true };
      continue;
    }
    const temp = join(dir, `.${base}.${randomBytes(6).toString("hex")}.tmp`);
    await fs.write(temp, content);
    try {
      await fs.link(temp, file);
      return { file, existed: false };
    } catch (err) {
      if ((err as { code?: unknown }).code !== "EEXIST") throw err;
      // Taken between the read and the link. If a concurrent retry of this
      // same digest took it, that is our note.
      const raced = await fs.read(file);
      if (raced !== null && noteDigestId(raced) === digestId) return { file, existed: true };
    } finally {
      await fs.unlink(temp).catch(() => {});
    }
  }
  throw new Error(`${NAME_ATTEMPTS} notes named "${base}" already exist in ${dir}.`);
}

/** Where the note goes, or why it cannot go anywhere. */
export async function mirrorDirectory(
  config: DigestMirrorConfig,
  vault: string | undefined,
  vaultPaths: ObsidianVaultPaths,
): Promise<{ dir: string } | { reason: string }> {
  if (isAbsolute(config.folder)) return { dir: config.folder };
  if (!vault) {
    return {
      reason:
        "No Obsidian vault to write into: Tabglutton is not filing clips to an Obsidian vault. Set digestMirror.folder in Gullet's config.json to an absolute path to mirror digests elsewhere.",
    };
  }
  let paths: ReadonlyMap<string, string> | null;
  try {
    paths = await vaultPaths();
  } catch {
    paths = null;
  }
  const root = paths?.get(vault);
  if (!root) {
    return {
      reason: `Obsidian's vault registry could not be read or has no vault named ${JSON.stringify(vault)}, so Gullet does not know where it is on disk.`,
    };
  }
  const base = resolve(root);
  const dir = resolve(base, config.folder);
  const prefix = base.endsWith(sep) ? base : base + sep;
  if (dir !== base && !dir.startsWith(prefix)) {
    return { reason: "digestMirror.folder leads outside the vault." };
  }
  return { dir };
}

export function createDigestMirror(
  config: DigestMirrorConfig,
  vaultPaths: ObsidianVaultPaths,
  fs: DigestMirrorFs = nodeFs,
): DigestMirror {
  return async (note, vault) => {
    if (!config.enabled) return { state: "off" };
    const target = await mirrorDirectory(config, vault, vaultPaths);
    if ("reason" in target) return { state: "failed", reason: target.reason };
    try {
      const written = await writeDigestNote(
        target.dir,
        digestNoteName(note),
        markdownForDigest(note),
        note.id,
        fs,
      );
      return { state: "written", ...written };
    } catch (err) {
      // The error's code and nothing else: a path in a message is fine, but a
      // caught error can carry whatever the OS put there, and this goes back
      // to the agent and into storage.
      const code = (err as { code?: unknown }).code;
      return {
        state: "failed",
        reason:
          typeof code === "string"
            ? `Could not write the note (${code}).`
            : err instanceof Error && err.message.includes("already exist")
              ? err.message
              : "Could not write the note.",
      };
    }
  };
}
