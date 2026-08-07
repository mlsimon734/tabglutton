import { asRecord } from "./bridge-protocol.js";
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

export async function saveTabToZotero(connectorId: string, tabId: number): Promise<void> {
  const response = await callConnector(connectorId, "saveTab", tabId);
  if (response.ok !== true || response.status !== "saved") {
    throw new Error(responseError(response, "Zotero Connector did not confirm the save."));
  }
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
