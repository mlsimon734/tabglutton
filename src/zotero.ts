import { IS_CHROME } from "./target.js";

export const ZOTERO_CONNECTOR_API_VERSION = 1;

/**
 * The published Connector IDs. A locally loaded Chromium proof-of-concept gets
 * its own ID, so the options page lets a developer override this value.
 */
export const DEFAULT_ZOTERO_CONNECTOR_ID = IS_CHROME
  ? "ekhagklcjbdpajgpjgmbionohlpdbjgc"
  : "zotero@chnm.gmu.edu";

export interface ZoteroTranslatorSummary {
  itemType: string;
  label: string;
}

export interface ZoteroTabInfo {
  state: "ready" | "detecting";
  isPDF: boolean;
  translator?: ZoteroTranslatorSummary;
}

interface ZoteroExternalResponse {
  ok?: unknown;
  status?: unknown;
  state?: unknown;
  isPDF?: unknown;
  translator?: unknown;
  error?: unknown;
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
  const response = (await browser.runtime.sendMessage(connectorId, {
    action: "getTabInfo",
    version: ZOTERO_CONNECTOR_API_VERSION,
    tabId,
  })) as ZoteroExternalResponse | undefined;

  if (!response || response.ok !== true) {
    throw new Error(responseError(response, "Zotero Connector did not return tab information."));
  }
  if (response.state !== "ready" && response.state !== "detecting") {
    throw new Error("Zotero Connector returned an invalid detection state.");
  }

  const info: ZoteroTabInfo = {
    state: response.state,
    isPDF: response.isPDF === true,
  };
  if (response.translator !== undefined) {
    if (!isTranslatorSummary(response.translator)) {
      throw new Error("Zotero Connector returned invalid translator information.");
    }
    info.translator = response.translator;
  }
  return info;
}

export async function saveTabToZotero(connectorId: string, tabId: number): Promise<void> {
  const response = (await browser.runtime.sendMessage(connectorId, {
    action: "saveTab",
    version: ZOTERO_CONNECTOR_API_VERSION,
    tabId,
  })) as ZoteroExternalResponse | undefined;

  if (!response || response.ok !== true || response.status !== "saved") {
    throw new Error(responseError(response, "Zotero Connector did not confirm the save."));
  }
}

function isTranslatorSummary(value: unknown): value is ZoteroTranslatorSummary {
  if (!value || typeof value !== "object") return false;
  const translator = value as Record<string, unknown>;
  return typeof translator.itemType === "string" && typeof translator.label === "string";
}

function responseError(response: ZoteroExternalResponse | undefined, fallback: string): string {
  return typeof response?.error === "string" && response.error.trim() ? response.error : fallback;
}
