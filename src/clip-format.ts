import type { SiteRule } from "./site-rules.js";

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

const CLIPPER_PATH = "Clippings";

function folderForRule(rule: SiteRule | null): string {
  return rule ? `${CLIPPER_PATH}/${rule.subfolder}` : CLIPPER_PATH;
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

export function obsidianNewNoteUrl(
  payload: ClipPayload,
  vault: string,
  content: string,
  rule: SiteRule | null = null,
): string {
  const file = `${folderForRule(rule)}/${sanitizeFileName(payload.title || payload.url)}`;
  let url = `obsidian://new?file=${encodeURIComponent(file)}`;
  if (vault) url += `&vault=${encodeURIComponent(vault)}`;
  url += `&content=${encodeURIComponent(content)}`;
  return url;
}
