import { asRecord } from "./bridge-protocol.js";
import { createTaskPool } from "./serialize.js";
import { IS_CHROME } from "./target.js";

const ZOTERO_CONNECTOR_API_VERSION = 1;

/**
 * The published Connector IDs. A locally loaded Chromium proof-of-concept gets
 * its own ID, so the options page lets a developer override this value.
 */
export const DEFAULT_ZOTERO_CONNECTOR_ID = IS_CHROME
  ? "ekhagklcjbdpajgpjgmbionohlpdbjgc"
  : "zotero@chnm.gmu.edu";

export interface ZoteroTabInfo {
  state: "ready" | "detecting";
  isPDF: boolean;
  /** The Connector's top translator. Only its item type is a routing signal. */
  translator?: { itemType: string };
}

const ACADEMIC_ITEM_TYPES = new Set([
  "bookSection",
  "conferencePaper",
  "journalArticle",
  "manuscript",
  "preprint",
  "report",
  "thesis",
]);

/**
 * Zotero's own translator result is the routing signal. This deliberately does
 * not enumerate publisher domains: the Connector already recognizes thousands
 * of sites, including authenticated and proxied variants that a hostname list
 * cannot cover. Standalone PDFs are included because they are a primary Zotero
 * workflow even when no page translator is available.
 */
export function isAcademicZoteroTarget(info: ZoteroTabInfo): boolean {
  if (info.state !== "ready") return false;
  if (info.isPDF) return true;
  return !!info.translator && ACADEMIC_ITEM_TYPES.has(info.translator.itemType);
}

export async function getZoteroTabInfo(connectorId: string, tabId: number): Promise<ZoteroTabInfo> {
  const response = await callConnector(connectorId, "getTabInfo", tabId);
  if (response.ok !== true) {
    throw new Error(responseError(response, "Zotero Connector did not return tab information."));
  }
  if (response.state !== "ready" && response.state !== "detecting") {
    throw new Error("Zotero Connector returned an invalid detection state.");
  }

  const info: ZoteroTabInfo = { state: response.state, isPDF: response.isPDF === true };
  const itemType = asRecord(response.translator)?.itemType;
  if (typeof itemType === "string") info.translator = { itemType };
  return info;
}

/**
 * How many Connector saves may be in flight at once, across every caller.
 *
 * A ceiling, not a queue, and the ceiling *is* the mitigation. Dispatching these
 * strictly one at a time guarded against two papers raising the Connector's
 * item-selector dialog at the same time, which routed tabs should almost never
 * do — `ACADEMIC_ITEM_TYPES` above excludes `multiple`, so a search-results page
 * never routes here in the first place. What is left is a rare case whose blast
 * radius this bounds, plus the request rate a source site sees. Both argue for a
 * small number rather than an unbounded `Promise.all` over a backlog of several
 * hundred papers.
 *
 * Reasoned from upstream's source and the serial timings in
 * [#51](https://github.com/mlsimon734/tabglutton/issues/51), not from a measured
 * parallel run — see docs/ENGINEERING.md §Concurrency before moving it, and
 * before re-serializing this on a hunch.
 */
export const ZOTERO_SAVE_CONCURRENCY = 3;

/**
 * The ceiling belongs to the Connector, not to any one run, so it lives beside
 * the call it bounds. Devour dispatches a whole selection at once and the bridge
 * serves requests concurrently, and a per-caller pool would let those two
 * surfaces add up to a number neither of them chose.
 */
const savePool = createTaskPool(ZOTERO_SAVE_CONCURRENCY);

export function saveTabToZotero(connectorId: string, tabId: number): Promise<void> {
  return savePool(async () => {
    const response = await callConnector(connectorId, "saveTab", tabId);
    if (response.ok !== true || response.status !== "saved") {
      throw new Error(responseError(response, "Zotero Connector did not confirm the save."));
    }
  });
}

/** A reply that is not a plain object cannot be `ok`, so it fails the same way. */
async function callConnector(
  connectorId: string,
  action: string,
  tabId: number,
): Promise<Record<string, unknown>> {
  const raw = await browser.runtime.sendMessage(connectorId, {
    action,
    version: ZOTERO_CONNECTOR_API_VERSION,
    tabId,
  });
  return asRecord(raw) ?? {};
}

function responseError(response: Record<string, unknown>, fallback: string): string {
  return typeof response.error === "string" && response.error.trim() ? response.error : fallback;
}
