// Zotero 10's local API: the route papers take into the user's library.
//
// `http://127.0.0.1:23119/api/` is the web API's shape served by the running
// desktop app, and from Zotero 10 it takes writes. That replaced the Zotero
// Connector route, which needed an extension API upstream declined to add
// (docs/ZOTERO_POC.md). Every wire fact below was read in Zotero's own source at
// tag 10.0.6 (`chrome/content/zotero/xpcom/server/server.js` and
// `server_localAPI.js`) and measured live (docs/ENGINEERING.md §Zotero):
//
// - Zotero silently drops any request that looks like a browser's — an
//   `Origin` header or a `Mozilla/` User-Agent, so every request an extension
//   makes — unless it carries `Zotero-Allowed-Request`. No HTTP status comes
//   back, just a closed connection, which `fetch` reports exactly as it reports
//   Zotero not running.
// - Reads need no key. Writes need a local API key (`Zotero-API-Key`), which the
//   user grants in a Zotero dialog, and a `Zotero-Server-ID` naming the
//   instance, read from any response. A key the user approved with "Allow"
//   rather than "Always Allow" is consumed by the first write, and one save is
//   several writes, so only a remembered key is kept (`connectZotero`).
// - Zotero sends no CORS headers, so the extension reaches it only through a
//   host permission for the loopback origin (`ZOTERO_ORIGINS`).
//
// The key is a credential: it lives in settings beside `bridgeToken`, under the
// same rules — never logged, never in Copy diagnostics.

import { md5Hex } from "./md5.js";
import { createTaskPool } from "./serialize.js";
import {
  pdfFileName,
  pruneToSchema,
  type ZoteroCitation,
  type ZoteroItemData,
} from "./zotero-item.js";

/**
 * The loopback address, not `localhost`: Zotero binds IPv4, and a `localhost`
 * that resolves to `::1` first would read as Zotero not running.
 */
export const ZOTERO_LOCAL_ORIGIN = "http://127.0.0.1:23119";
const LIBRARY = "/api/users/0";

/** What Zotero's authorization dialog says is asking. */
export const ZOTERO_APP_NAME = "Tabglutton";

/** A PDF larger than this is not downloaded into the background page; the item is filed without it. */
const MAX_PDF_BYTES = 64 * 1024 * 1024;

/**
 * How many saves may be in flight at once, across every caller.
 *
 * A ceiling, not a queue. Each save is a handful of local requests plus one
 * download from the paper's site, so the ceiling bounds the request rate that
 * site sees when Devour files a backlog of papers at once, and the memory held
 * by PDFs in flight. See docs/ENGINEERING.md §Concurrency before moving it.
 */
export const ZOTERO_SAVE_CONCURRENCY = 3;

/**
 * The ceiling belongs to Zotero, not to any one run, so it lives beside the call
 * it bounds: Devour and the bridge both save, and a per-caller pool would let
 * the two add up to a number neither chose.
 */
const savePool = createTaskPool(ZOTERO_SAVE_CONCURRENCY);

/** Why a Zotero call failed, closed set. The sentence for each is `zoteroFailureMessage`. */
export type ZoteroFailureKind =
  | "unreachable"
  | "api-disabled"
  | "not-connected"
  | "key-rejected"
  | "denied"
  | "rate-limited"
  | "server-changed"
  | "refused";

export class ZoteroError extends Error {
  constructor(
    readonly kind: ZoteroFailureKind,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The user-facing sentence for a failure, naming its remedy. `detail` is
 * Zotero's own message for a refusal this cannot name better; it carries no
 * credential (Zotero never echoes the key).
 */
export function zoteroFailureMessage(kind: ZoteroFailureKind, detail = ""): string {
  switch (kind) {
    case "unreachable":
      return "Zotero did not answer at 127.0.0.1:23119. Open Zotero, then try again.";
    case "api-disabled":
      return "Zotero's local API is off. In Zotero, open Settings → Advanced and turn on “Allow other applications on this computer to communicate with Zotero”, then try again.";
    case "not-connected":
      return "Tabglutton is not connected to Zotero yet. Press Connect to Zotero in Tabglutton's settings and choose Always Allow.";
    case "key-rejected":
      return "Zotero no longer accepts Tabglutton's key. Press Connect to Zotero in Tabglutton's settings and choose Always Allow.";
    case "denied":
      return "Zotero declined the connection. Press Connect to Zotero again and choose Always Allow.";
    case "rate-limited":
      return "Zotero is limiting how often it asks for permission. Wait a minute, then press Connect to Zotero again.";
    case "server-changed":
      return "A different Zotero answered partway through the save, so nothing more was written. Try again.";
    case "refused":
      return `Zotero refused the save${detail ? `: ${detail}` : "."}`;
  }
}

/** Classify one non-success answer. Pure, so the status table is pinned by tests. */
export function failureForStatus(status: number, phase: "read" | "write"): ZoteroFailureKind {
  if (status === 401) return "key-rejected";
  // 403 on a read is the API switched off (Zotero answers every endpoint that
  // way); on a write it is the library refusing, which only Zotero can explain.
  if (status === 403) return phase === "read" ? "api-disabled" : "refused";
  if (status === 412) return "server-changed";
  if (status === 429) return "rate-limited";
  return "refused";
}

interface ZoteroResponse {
  status: number;
  headers: Headers;
  text: string;
}

async function call(
  method: string,
  path: string,
  init: { headers?: Record<string, string>; body?: BodyInit } = {},
): Promise<ZoteroResponse> {
  let response: Response;
  try {
    response = await fetch(`${ZOTERO_LOCAL_ORIGIN}${path}`, {
      method,
      headers: { "Zotero-Allowed-Request": "1", ...init.headers },
      body: init.body,
      // Zotero's answers carry nothing a cookie or a redirect should touch.
      credentials: "omit",
      redirect: "error",
    });
  } catch {
    // A refused connection, Zotero's silent drop of a request it took for a
    // browser's, and a missing host grant all reach here as the same TypeError;
    // the caller that can check the grant does (`zoteroSaveFailure`).
    throw new ZoteroError("unreachable", zoteroFailureMessage("unreachable"));
  }
  return { status: response.status, headers: response.headers, text: await response.text() };
}

function fail(response: ZoteroResponse, phase: "read" | "write"): never {
  const kind = failureForStatus(response.status, phase);
  const detail = `HTTP ${response.status}${response.text.trim() ? ` — ${response.text.trim().slice(0, 200)}` : ""}`;
  throw new ZoteroError(kind, zoteroFailureMessage(kind, detail));
}

function parseJson<T>(response: ZoteroResponse): T {
  try {
    return JSON.parse(response.text) as T;
  } catch {
    throw new ZoteroError("refused", zoteroFailureMessage("refused", "its answer was not JSON"));
  }
}

/** The instance id every write must name, read fresh so a restarted Zotero cannot be written blind. */
async function serverId(): Promise<string> {
  const response = await call("GET", "/api/");
  const id = response.headers.get("Zotero-Server-ID");
  if (response.status !== 200 || !id) fail(response, "read");
  return id;
}

/** Whether Zotero is there and answering, for the options page's status line. Never throws. */
export async function zoteroReachability(): Promise<"ready" | "api-disabled" | "unreachable"> {
  try {
    await serverId();
    return "ready";
  } catch (err) {
    return err instanceof ZoteroError && err.kind === "api-disabled"
      ? "api-disabled"
      : "unreachable";
  }
}

export type ZoteroConnectResult = { kind: "connected"; key: string } | { kind: "once" };

/** What the options page says after an "Allow" rather than "Always Allow". */
export const ZOTERO_ALLOWED_ONCE =
  "Zotero allowed a single write, and filing a paper takes several, so that approval was not kept. Press Connect to Zotero again and choose Always Allow.";

/**
 * Ask Zotero for a key. Zotero shows its own dialog and holds this request open
 * until the user answers it, so this can take as long as the user does.
 *
 * `once` is an "Allow" rather than "Always Allow": that key is spent by the
 * first write and a save takes several, so it is not returned at all.
 */
export async function connectZotero(): Promise<ZoteroConnectResult> {
  const id = await serverId();
  const response = await call("POST", "/api/local/authorize", {
    headers: { "Content-Type": "application/json", "Zotero-Server-ID": id },
    body: JSON.stringify({ appName: ZOTERO_APP_NAME }),
  });
  if (response.status === 403) {
    throw new ZoteroError("denied", zoteroFailureMessage("denied"));
  }
  if (response.status !== 200) fail(response, "write");
  const body = parseJson<{ key?: unknown; remember?: unknown }>(response);
  if (typeof body.key !== "string" || !body.key) {
    throw new ZoteroError("refused", zoteroFailureMessage("refused", "it answered without a key"));
  }
  return body.remember === true ? { kind: "connected", key: body.key } : { kind: "once" };
}

/** What a save produced, read back from the library rather than taken from the write's answer. */
export interface ZoteroSaveReceipt {
  itemKey: string;
  /** Whether the PDF the page named is in the library with the bytes that were sent. */
  pdf: "attached" | "none" | "failed";
  /** Why there is no PDF, when the page named one. */
  pdfNote?: string;
}

export interface ZoteroSaveOptions {
  key: string;
  /** Top-level collection name; empty files into the library root. */
  collection: string;
  /** Fetch the PDF with the browser's view of the site. Injected so tests need no network. */
  fetchPdf: (url: string) => Promise<Uint8Array<ArrayBuffer>>;
}

/**
 * File one paper: the item, then its PDF, each read back before this resolves.
 * Resolves only when the item is in the library under the title that was sent;
 * a PDF that could not be fetched or attached is reported on the receipt, not
 * thrown, because the item is already saved by then and a thrown save would
 * keep the tab open over a paper that is in the library.
 */
export function saveCitationToZotero(
  citation: ZoteroCitation,
  options: ZoteroSaveOptions,
): Promise<ZoteroSaveReceipt> {
  return savePool(async () => {
    if (!options.key) throw new ZoteroError("not-connected", zoteroFailureMessage("not-connected"));
    const id = await serverId();
    const writeHeaders = { "Zotero-API-Key": options.key, "Zotero-Server-ID": id };

    const fields = await schemaFields(id, citation.item.itemType);
    const collectionKey = options.collection.trim()
      ? await collectionKeyFor(id, options.collection.trim(), writeHeaders)
      : undefined;
    const item = {
      ...pruneToSchema(citation.item, fields),
      ...(collectionKey ? { collections: [collectionKey] } : {}),
    };
    const itemKey = await createOne(item, writeHeaders);

    const back = parseJson<{ data?: { title?: unknown; collections?: unknown } }>(
      await readOk(`${LIBRARY}/items/${itemKey}`),
    );
    const collections = Array.isArray(back.data?.collections) ? back.data.collections : [];
    if (
      back.data?.title !== item.title ||
      (collectionKey && !collections.includes(collectionKey))
    ) {
      throw new ZoteroError(
        "refused",
        zoteroFailureMessage("refused", "the item read back did not match what was sent"),
      );
    }

    if (!citation.pdfUrl) return { itemKey, pdf: "none" };
    try {
      await attachPdf(itemKey, citation.pdfUrl, citation.item, options.fetchPdf, writeHeaders);
      return { itemKey, pdf: "attached" };
    } catch (err) {
      // A key or instance problem would fail the next save too, so it is the
      // save's failure; anything about the PDF itself is only the PDF's.
      if (err instanceof ZoteroError && err.kind !== "refused") throw err;
      return { itemKey, pdf: "failed", pdfNote: err instanceof Error ? err.message : String(err) };
    }
  });
}

async function readOk(path: string): Promise<ZoteroResponse> {
  const response = await call("GET", path);
  if (response.status !== 200) fail(response, "read");
  return response;
}

/** Field names per item type, per instance, so one Zotero restart cannot serve another's schema. */
const schemaCache = new Map<string, Promise<ReadonlySet<string>>>();

function schemaFields(id: string, itemType: string): Promise<ReadonlySet<string>> {
  const cacheKey = `${id}\u0000${itemType}`;
  let fields = schemaCache.get(cacheKey);
  if (!fields) {
    fields = (async () => {
      const response = await readOk(`/api/itemTypeFields?itemType=${encodeURIComponent(itemType)}`);
      const list = parseJson<Array<{ field?: unknown }>>(response);
      return new Set(
        list.map((entry) => entry.field).filter((f): f is string => typeof f === "string"),
      );
    })();
    schemaCache.set(cacheKey, fields);
    fields.catch(() => schemaCache.delete(cacheKey));
  }
  return fields;
}

/**
 * Single-flight per instance and name: three saves into a collection that does
 * not exist yet must create it once, not three times.
 */
const collectionCache = new Map<string, Promise<string>>();

function collectionKeyFor(
  id: string,
  name: string,
  writeHeaders: Record<string, string>,
): Promise<string> {
  const cacheKey = `${id}\u0000${name}`;
  let key = collectionCache.get(cacheKey);
  if (!key) {
    key = (async () => {
      const found = await findTopCollection(name);
      if (found) return found;
      const response = await call("POST", `${LIBRARY}/collections`, {
        headers: { ...writeHeaders, "Content-Type": "application/json" },
        body: JSON.stringify([{ name }]),
      });
      return writtenKey(response, "collection");
    })();
    collectionCache.set(cacheKey, key);
    key.catch(() => collectionCache.delete(cacheKey));
  }
  return key;
}

async function findTopCollection(name: string): Promise<string | undefined> {
  const pageSize = 100;
  for (let start = 0; ; start += pageSize) {
    const page = parseJson<Array<{ key?: unknown; data?: { name?: unknown } }>>(
      await readOk(`${LIBRARY}/collections/top?limit=${pageSize}&start=${start}`),
    );
    const match = page.find((entry) => entry.data?.name === name);
    if (match && typeof match.key === "string") return match.key;
    if (page.length < pageSize) return undefined;
  }
}

async function createOne(
  object: Record<string, unknown>,
  writeHeaders: Record<string, string>,
): Promise<string> {
  const response = await call("POST", `${LIBRARY}/items`, {
    headers: { ...writeHeaders, "Content-Type": "application/json" },
    body: JSON.stringify([object]),
  });
  return writtenKey(response, "item");
}

/** The web API answers a batch write 200 with per-object outcomes; one object went in. */
function writtenKey(response: ZoteroResponse, what: string): string {
  if (response.status !== 200) fail(response, "write");
  const body = parseJson<{
    successful?: Record<string, { key?: unknown }>;
    failed?: Record<string, { message?: unknown }>;
  }>(response);
  const key = body.successful?.["0"]?.key;
  if (typeof key === "string") return key;
  const reason = body.failed?.["0"]?.message;
  throw new ZoteroError(
    "refused",
    zoteroFailureMessage("refused", typeof reason === "string" ? reason : `no ${what} was created`),
  );
}

/**
 * The web API's three-step file upload, served locally: authorize with the
 * MD5, send the bytes to the URL Zotero names, register. Zotero hashes what
 * arrived and refuses a mismatch, and the attachment then reads back carrying
 * the MD5 it accepted, which is the check here.
 */
async function attachPdf(
  parentItem: string,
  pdfUrl: string,
  item: ZoteroItemData,
  fetchPdf: (url: string) => Promise<Uint8Array<ArrayBuffer>>,
  writeHeaders: Record<string, string>,
): Promise<void> {
  const bytes = await fetchPdf(pdfUrl);
  if (bytes.length > MAX_PDF_BYTES) {
    throw new Error(
      `The PDF is larger than ${MAX_PDF_BYTES / (1024 * 1024)} MB, so it was not attached.`,
    );
  }
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") {
    throw new Error(
      "The page's PDF link did not return a PDF (often a login or bot-check page), so none was attached.",
    );
  }
  const md5 = md5Hex(bytes);
  const filename = pdfFileName(item);
  const attachmentKey = await createOne(
    {
      itemType: "attachment",
      parentItem,
      linkMode: "imported_url",
      title: "Full Text PDF",
      url: pdfUrl,
      contentType: "application/pdf",
      filename,
      accessDate: new Date().toISOString(),
    },
    writeHeaders,
  );

  const filePath = `${LIBRARY}/items/${attachmentKey}/file`;
  const form = {
    ...writeHeaders,
    "Content-Type": "application/x-www-form-urlencoded",
    "If-None-Match": "*",
  };
  const authorized = await call("POST", filePath, {
    headers: form,
    body: new URLSearchParams({
      md5,
      filename,
      filesize: String(bytes.length),
      mtime: String(Date.now()),
    }).toString(),
  });
  if (authorized.status !== 200) fail(authorized, "write");
  const upload = parseJson<{ exists?: unknown; url?: unknown; uploadKey?: unknown }>(authorized);
  if (upload.exists !== 1) {
    if (typeof upload.url !== "string" || typeof upload.uploadKey !== "string") {
      throw new ZoteroError("refused", zoteroFailureMessage("refused", "no upload URL was given"));
    }
    // Only the path is taken from Zotero's URL: it builds the host from the
    // request's own Host header, and the origin the grant covers is this one.
    const sent = await call("POST", new URL(upload.url).pathname, {
      // Not text, JSON, or form-encoded: Zotero decodes those as UTF-8 and
      // would corrupt the PDF before hashing it.
      headers: { "Content-Type": "application/pdf" },
      body: bytes,
    });
    if (sent.status !== 201) fail(sent, "write");
    const registered = await call("POST", filePath, {
      headers: form,
      body: new URLSearchParams({ upload: upload.uploadKey }).toString(),
    });
    if (registered.status !== 204) fail(registered, "write");
  }

  const back = parseJson<{ data?: { md5?: unknown } }>(
    await readOk(`${LIBRARY}/items/${attachmentKey}`),
  );
  if (back.data?.md5 !== md5) {
    throw new ZoteroError(
      "refused",
      zoteroFailureMessage("refused", "the attached PDF read back with a different checksum"),
    );
  }
}
