import type { SiteRule } from "./site-rules.js";
import type { ClipMode } from "./storage.js";

export interface ClipPayload {
  title: string;
  url: string;
  author: string;
  published: string;
  description: string;
  site: string;
  wordCount: number;
  markdown: string;
}

const DEFAULT_CLIPPER_PATH = "Clippings";

export function normalizeBaseFolder(input: string): string {
  const cleaned = input
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/+/g, "/");
  return cleaned === "" ? DEFAULT_CLIPPER_PATH : cleaned;
}

function folderForRule(rule: SiteRule | null, baseFolder: string): string {
  return rule ? `${baseFolder}/${rule.subfolder}` : baseFolder;
}

interface ClipperProperty {
  name: string;
  value: string;
  type: "text" | "date" | "multitext";
}

function escapeDoubleQuotes(value: string): string {
  return value.replace(/"/g, '\\"');
}

function localIsoTimestamp(date = new Date()): string {
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const offset =
    `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:` + String(abs % 60).padStart(2, "0");
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}${offset}`;
}

function wikilink(value: string): string {
  return value.trim() ? `[[${value}]]` : value;
}

function defaultAuthorProperty(author: string): string {
  return author
    .split(/, /)
    .map((item) => wikilink(item))
    .join(",");
}

function sourceUrl(url: string): string {
  return url.replace(/#:~:text=[^&]+(&|$)/, "");
}

function stripAsciiControlChars(value: string): string {
  return Array.from(value)
    .filter((char) => char.charCodeAt(0) >= 32)
    .join("");
}

/**
 * Which filesystem's naming rules a note name has to satisfy. `obsidian://` is
 * a local handoff, so the browser's platform is the vault's platform.
 */
export type FilePlatform = "win" | "mac" | "other";

/**
 * Mirrors Obsidian Web Clipper's own `sanitizeFileName`, per platform. Matching
 * it is the point: the target user runs both, and a page clipped by each should
 * land on one note rather than two differently-named ones. That is also why the
 * macOS branch strips `/` and `:` with nothing in their place — ugly, but it is
 * the same ugly.
 *
 * Tabglutton applied the macOS branch everywhere until 0.2.0, so a Windows user
 * clipping a title containing `? * " < > \` — or one that happened to be `CON`
 * — handed Obsidian a name Windows cannot write.
 */
function sanitizeFileName(fileName: string, platform: FilePlatform): string {
  // Obsidian's own reserved characters go on every platform; the rest is the host's.
  let sanitized = stripAsciiControlChars(fileName).replace(/[#[\]|^]/g, "");
  if (platform === "mac") {
    sanitized = sanitized.replace(/[/:]/g, "");
  } else {
    // Windows' illegal set, applied on Linux and BSD too: those filesystems
    // accept most of it, but a vault synced to a Windows machine does not.
    sanitized = sanitized.replace(/[<>:"/\\?*]/g, "");
    if (platform === "win") {
      sanitized = sanitized
        // DOS device names, still unwritable, with or without an extension.
        .replace(/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i, "_$1$2");
    }
  }
  sanitized = sanitized.replace(/^\.+/, "").trim().slice(0, 245);
  // Truncation can expose a trailing dot or space even when the original title
  // did not end with one. Windows silently drops both on write.
  if (platform === "win") sanitized = sanitized.replace(/[\s.]+$/, "");
  if (sanitized.length === 0) sanitized = "Untitled";
  return sanitized;
}

function generateClipperFrontmatter(properties: ClipperProperty[]): string {
  let frontmatter = "---\n";
  for (const property of properties) {
    frontmatter += `${property.name}:`;
    switch (property.type) {
      case "multitext": {
        const items = property.value
          .split(/,(?![^[]*]])/)
          .map((item) => item.trim())
          .filter(Boolean);
        if (items.length > 0) {
          frontmatter += "\n";
          for (const item of items) {
            frontmatter += `  - "${escapeDoubleQuotes(item)}"\n`;
          }
        } else {
          frontmatter += "\n";
        }
        break;
      }
      case "date":
        frontmatter += property.value.trim() !== "" ? ` ${property.value}\n` : "\n";
        break;
      default:
        frontmatter +=
          property.value.trim() !== "" ? ` "${escapeDoubleQuotes(property.value)}"\n` : "\n";
    }
  }
  frontmatter += "---\n";
  return frontmatter;
}

export function markdownForClip(payload: ClipPayload): string {
  const content = payload.markdown.trim();
  const properties: ClipperProperty[] = [
    { name: "title", value: payload.title, type: "text" },
    { name: "source", value: sourceUrl(payload.url), type: "text" },
    {
      name: "author",
      value: defaultAuthorProperty(payload.author),
      type: "multitext",
    },
    {
      name: "published",
      value: payload.published.split(",")[0]?.trim() ?? "",
      type: "date",
    },
    { name: "created", value: localIsoTimestamp(), type: "date" },
    { name: "description", value: payload.description, type: "text" },
    { name: "tags", value: "clippings", type: "multitext" },
  ];
  return generateClipperFrontmatter(properties) + content;
}

export const CLIPBOARD_FALLBACK_CONTENT =
  "[Tabglutton] Clipboard handoff failed — re-run the clip.";

/**
 * Minimum gap between `obsidian://` launches. Both the popup's Devour and the
 * bridge's `tab_clip` pace themselves by it, so it lives here rather than being
 * a bare `200` in one file and a constant in the other.
 */
export const OBSIDIAN_HANDOFF_GAP_MS = 200;

export interface ObsidianClipRequest {
  url: string;
  clipboard: string | null;
  /** Vault-relative note path this request files under, without extension. */
  file: string;
}

/** Vault-relative note path a clip will be filed under, without extension. */
function clipFilePath(
  payload: ClipPayload,
  rule: SiteRule | null,
  baseFolder: string,
  platform: FilePlatform,
): string {
  const base = normalizeBaseFolder(baseFolder);
  return `${folderForRule(rule, base)}/${sanitizeFileName(payload.title || payload.url, platform)}`;
}

/**
 * The clip request actually handed to Obsidian: clipboard mode when the copy
 * lands, legacy URI when it does not. Both the popup's Devour and the bridge's
 * `tab_clip` go through here, so the fallback rule has exactly one owner.
 * `copyToClipboard` is injected because this module stays free of browser APIs.
 */
export async function resolveClipRequest(
  payload: ClipPayload,
  vault: string,
  content: string,
  rule: SiteRule | null,
  mode: ClipMode,
  baseFolder: string,
  platform: FilePlatform,
  copyToClipboard: (text: string) => Promise<boolean>,
): Promise<ObsidianClipRequest> {
  const request = obsidianClipRequest(payload, vault, content, rule, mode, baseFolder, platform);
  if (request.clipboard === null) return request;
  if (await copyToClipboard(request.clipboard)) return request;
  // The URI carries the note itself — bigger, but it does not need the clipboard.
  return obsidianClipRequest(payload, vault, content, rule, "legacy-uri", baseFolder, platform);
}

export function obsidianClipRequest(
  payload: ClipPayload,
  vault: string,
  content: string,
  rule: SiteRule | null,
  mode: ClipMode,
  baseFolder: string = DEFAULT_CLIPPER_PATH,
  // "other" is the conservative set — everything Windows rejects, minus the
  // reserved-name rewrite. Defaulting to it means a caller that cannot answer
  // the question still produces a name every filesystem accepts.
  platform: FilePlatform = "other",
): ObsidianClipRequest {
  const file = clipFilePath(payload, rule, baseFolder, platform);
  let url = `obsidian://new?file=${encodeURIComponent(file)}`;
  if (vault) url += `&vault=${encodeURIComponent(vault)}`;
  if (mode === "clipboard") {
    url += `&clipboard&content=${encodeURIComponent(CLIPBOARD_FALLBACK_CONTENT)}`;
    return { url, clipboard: content, file };
  }
  url += `&content=${encodeURIComponent(content)}`;
  return { url, clipboard: null, file };
}
