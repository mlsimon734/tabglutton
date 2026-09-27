// Where page facts live: `storage.local`, one key, behind its own queue (the
// same reasoning as `digest-store.ts`: concurrent reads write one array, and a
// queue guards a key). The model is pure and lives in `page-facts.ts`.
//
// Recording runs after `tab_read` has answered and is never awaited by it, so
// a slow image costs the agent nothing. The thumbnail is fetched once, here,
// from the background, with no cookies and no referrer, and only from an
// address `imageSourceAllowed` accepts (the fetch carries host permission, so
// the page must not be able to aim it at a private address). Its header is
// checked before anything decodes it. The panel shows only the stored `data:`
// URL and never contacts the site.

import type { ClipPayload } from "./clip-format.js";
import {
  fitWithin,
  IMAGE_SOURCE_MAX_PIXELS,
  imageDimensions,
  imageSourceAllowed,
  isStorableImage,
  PAGE_FACTS_KEY,
  PAGE_FACTS_VERSION,
  PAGE_IMAGE_MAX_CHARS,
  pageFactsFrom,
  parsePageFacts,
  rememberFacts,
  resolvePageResource,
  THUMBNAIL_LADDER,
  type PageFacts,
} from "./page-facts.js";
import { createTaskQueue } from "./serialize.js";

const withPageFacts = createTaskQueue();

const IMAGE_FETCH_TIMEOUT_MS = 6_000;
/** A source image larger than this is not worth decoding for a thumbnail. */
const IMAGE_SOURCE_MAX_BYTES = 8 * 1024 * 1024;
/** The formats `imageDimensions` can size before decoding. */
const RASTER = /^image\/(png|jpeg|webp|gif)$/i;

export async function readPageFacts(): Promise<PageFacts[]> {
  const stored = await browser.storage.local.get(PAGE_FACTS_KEY);
  return parsePageFacts((stored as Record<string, unknown>)[PAGE_FACTS_KEY]);
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function encode(bitmap: ImageBitmap, edge: number, quality: number): Promise<string | null> {
  const { width, height } = fitWithin(bitmap.width, bitmap.height, edge);
  if (width === 0) return null;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, width, height);
  let blob = await canvas.convertToBlob({ type: "image/webp", quality });
  // An engine that cannot encode WebP hands back PNG, which is far larger.
  if (blob.type !== "image/webp")
    blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  return `data:${blob.type};base64,${base64(new Uint8Array(await blob.arrayBuffer()))}`;
}

/**
 * A small `data:` thumbnail of a page image, or null. Raster types only (an
 * SVG is a document, not a picture), bounded in time and size, and never
 * larger than `PAGE_IMAGE_MAX_CHARS`.
 */
export async function thumbnailOf(src: string, pageUrl: string): Promise<string | null> {
  if (!imageSourceAllowed(src, pageUrl)) return null;
  try {
    const res = await fetch(src, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
      // A redirect could land on the private address the check above refused;
      // a redirected og:image falls back to the favicon tile instead.
      redirect: "error",
      signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
    });
    const type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
    if (!res.ok || !RASTER.test(type)) return null;
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > IMAGE_SOURCE_MAX_BYTES) return null;
    const blob = await res.blob();
    if (blob.size > IMAGE_SOURCE_MAX_BYTES) return null;
    const size = imageDimensions(new Uint8Array(await blob.arrayBuffer()));
    if (!size || size.width * size.height > IMAGE_SOURCE_MAX_PIXELS) return null;
    const bitmap = await createImageBitmap(blob);
    try {
      for (const step of THUMBNAIL_LADDER) {
        const url = await encode(bitmap, step.edge, step.quality);
        if (url && url.length <= PAGE_IMAGE_MAX_CHARS) return url;
      }
      return null;
    } finally {
      bitmap.close();
    }
  } catch {
    return null;
  }
}

/**
 * Record what a read saw of one tab. Private tabs are skipped: `storage.local`
 * is on disk, and a thumbnail of a private page is more than the digest itself
 * keeps. Failures are swallowed: facts are a nicety the panel can do without.
 */
export async function recordPageFacts(
  tab: { id: number; url: string; incognito: boolean; favIconUrl?: string },
  payload: ClipPayload,
): Promise<void> {
  // The document that was read, which is the page these facts describe; the
  // tab's favicon only while the tab still shows that same document.
  const url = payload.url || tab.url;
  if (tab.incognito || !url) return;
  try {
    const source = resolvePageResource(payload.page?.image, url);
    const image = source ? await thumbnailOf(source, url) : null;
    const entry = pageFactsFrom({
      tabId: tab.id,
      url,
      readAt: Date.now(),
      payload,
      ...(tab.favIconUrl && tab.url === url ? { tabFavicon: tab.favIconUrl } : {}),
      image: isStorableImage(image) ? image : null,
    });
    await withPageFacts(async () => {
      const list = rememberFacts(await readPageFacts(), entry);
      await browser.storage.local.set({
        [PAGE_FACTS_KEY]: { v: PAGE_FACTS_VERSION, facts: list },
      });
    });
    void browser.runtime.sendMessage({ type: "digests-changed" }).catch(() => {});
  } catch (err) {
    // The error's name only: a message could carry the page's URL.
    console.warn("[tabglutton] page facts: not recorded", String((err as Error)?.name ?? ""));
  }
}
