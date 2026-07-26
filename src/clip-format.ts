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

function sanitizeFileName(fileName: string): string {
  let sanitized = stripAsciiControlChars(fileName)
    .replace(/[#[\]|^]/g, "")
    .replace(/[/:]/g, "")
    .replace(/^\./, "")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 245);
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
}

/** Vault-relative note path a clip will be filed under, without extension. */
export function clipFilePath(
  payload: ClipPayload,
  rule: SiteRule | null,
  baseFolder: string = DEFAULT_CLIPPER_PATH,
): string {
  const base = normalizeBaseFolder(baseFolder);
  return `${folderForRule(rule, base)}/${sanitizeFileName(payload.title || payload.url)}`;
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
  copyToClipboard: (text: string) => Promise<boolean>,
): Promise<ObsidianClipRequest> {
  const request = obsidianClipRequest(payload, vault, content, rule, mode, baseFolder);
  if (request.clipboard === null) return request;
  if (await copyToClipboard(request.clipboard)) return request;
  // The URI carries the note itself — bigger, but it does not need the clipboard.
  return obsidianClipRequest(payload, vault, content, rule, "legacy-uri", baseFolder);
}

export function obsidianClipRequest(
  payload: ClipPayload,
  vault: string,
  content: string,
  rule: SiteRule | null,
  mode: ClipMode,
  baseFolder: string = DEFAULT_CLIPPER_PATH,
): ObsidianClipRequest {
  const file = clipFilePath(payload, rule, baseFolder);
  let url = `obsidian://new?file=${encodeURIComponent(file)}`;
  if (vault) url += `&vault=${encodeURIComponent(vault)}`;
  if (mode === "clipboard") {
    url += `&clipboard&content=${encodeURIComponent(CLIPBOARD_FALLBACK_CONTENT)}`;
    return { url, clipboard: content };
  }
  url += `&content=${encodeURIComponent(content)}`;
  return { url, clipboard: null };
}
