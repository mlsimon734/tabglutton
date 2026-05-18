import "webextension-polyfill";
import Defuddle from "defuddle/full";
import type { DefuddleResponse } from "defuddle/full";

interface ClipPayload {
  title: string;
  url: string;
  author: string;
  published: string;
  description: string;
  site: string;
  wordCount: number;
  markdown: string;
}

interface ClipResultMessage {
  type: "clip-current-result";
  requestId: string | undefined;
  ok: boolean;
  payload?: ClipPayload;
  error?: string;
}

declare global {
  interface Window {
    __tabDedupClipRequestId?: string;
  }
}

function htmlDocumentSnapshot(): Document {
  const html = `<!doctype html>${document.documentElement.outerHTML}`;
  const snapshot = new DOMParser().parseFromString(html, "text/html");
  removeMalformedJsonLd(snapshot);
  return snapshot;
}

function cleanJsonLd(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "")
    .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1")
    .replace(/^\s*(\*\/|\/\*)\s*|\s*(\*\/|\/\*)\s*$/g, "")
    .trim();
}

function removeMalformedJsonLd(doc: Document): void {
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  scripts.forEach((script) => {
    try {
      JSON.parse(cleanJsonLd(script.textContent || ""));
    } catch {
      script.remove();
    }
  });
}

function markdownFrom(result: DefuddleResponse): string {
  return result.contentMarkdown ?? result.content ?? "";
}

function payloadFrom(result: DefuddleResponse): ClipPayload {
  return {
    title: result.title || document.title || location.href,
    url: location.href,
    author: result.author || "",
    published: result.published || "",
    description: result.description || "",
    site: result.site || result.domain || "",
    wordCount: result.wordCount || 0,
    markdown: markdownFrom(result),
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

void (async () => {
  const requestId = window.__tabDedupClipRequestId;
  let msg: ClipResultMessage;
  try {
    const defuddle = new Defuddle(htmlDocumentSnapshot(), {
      url: location.href,
      markdown: true,
      separateMarkdown: true,
      useAsync: false,
    });
    msg = {
      type: "clip-current-result",
      requestId,
      ok: true,
      payload: payloadFrom(defuddle.parse()),
    };
  } catch (err) {
    msg = {
      type: "clip-current-result",
      requestId,
      ok: false,
      error: errorMessage(err),
    };
  }
  await browser.runtime.sendMessage(msg);
})();
