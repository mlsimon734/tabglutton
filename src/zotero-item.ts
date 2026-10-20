// What a page says about itself as a paper, and the Zotero item that says.
//
// The routing signal and the metadata are one thing: the Highwire Press
// `citation_*` meta tags publishers emit for Google Scholar, read from the tab
// the user already has open (`readCitationSnapshot` in background.ts). A page
// that carries `citation_title` is a paper; one that does not is not, and goes
// to the note destinations. That replaced the Zotero Connector's translator
// verdict, which an extension can no longer ask for — see docs/ZOTERO_POC.md.
//
// Everything here is page-controlled text, so it is shape-checked and capped
// before it becomes an item, and nothing in it is ever rendered as markup.
// Pure, so the mapping is unit-tested against captured pages.

/** What the injected reader hands back: the page's address, its meta tags, and a body abstract. */
export interface CitationSnapshot {
  /** The document's own `location.href`, http(s) only. */
  url: string;
  /** `[name, content]`, names lowercased, in document order. Repeats are meaningful (authors). */
  meta: Array<[string, string]>;
  /** Read from the page body only when no meta tag carries the abstract. */
  abstract?: string;
}

export interface ZoteroCreator {
  creatorType: "author";
  firstName?: string;
  lastName?: string;
  /** Single-field form, for a name with no space to split on. */
  name?: string;
}

/**
 * One Zotero item in the web API's JSON shape. Field names are Zotero's; the
 * client drops any the running Zotero's schema does not list for the type
 * before writing (`pruneToSchema`), so a field one version lacks costs that
 * field, not the save.
 */
export interface ZoteroItemData {
  itemType: string;
  title: string;
  creators: ZoteroCreator[];
  tags?: Array<{ tag: string }>;
  [field: string]: string | ZoteroCreator[] | Array<{ tag: string }> | undefined;
}

export interface ZoteroCitation {
  item: ZoteroItemData;
  /** From `citation_pdf_url`, absolute. Absent when the page names no PDF. */
  pdfUrl?: string;
}

const MAX_META_ENTRIES = 400;
const MAX_TITLE_CHARS = 1000;
const MAX_ABSTRACT_CHARS = 20_000;
const MAX_FIELD_CHARS = 500;
const MAX_CREATORS = 500;
const MAX_TAGS = 30;

/**
 * Shape-check what came back from the page. The injection runs in the isolated
 * world, but every string in it was written by the site, so the counts and
 * lengths are capped here rather than trusted.
 */
export function parseCitationSnapshot(raw: unknown): CitationSnapshot | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.url !== "string" || !/^https?:\/\//i.test(record.url)) return null;
  if (!Array.isArray(record.meta)) return null;
  const meta: Array<[string, string]> = [];
  for (const entry of record.meta.slice(0, MAX_META_ENTRIES)) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [name, content] = entry as unknown[];
    if (typeof name !== "string" || typeof content !== "string") continue;
    const value = collapse(content);
    if (value) meta.push([name.toLowerCase().slice(0, 100), value.slice(0, MAX_ABSTRACT_CHARS)]);
  }
  const abstract = typeof record.abstract === "string" ? collapse(record.abstract) : "";
  return {
    url: record.url,
    meta,
    ...(abstract ? { abstract: abstract.slice(0, MAX_ABSTRACT_CHARS) } : {}),
  };
}

/**
 * The item a paper page describes, or `null` when it is not one. `citation_title`
 * is the test: it is the one tag Google Scholar's inclusion rules make
 * mandatory, so a page without it is not claiming to be a paper.
 */
export function citationFromSnapshot(
  snapshot: CitationSnapshot,
  accessDate: string,
): ZoteroCitation | null {
  const pageUrl = snapshot.url;
  const meta = metaMap(snapshot.meta);
  const title = first(meta, "citation_title");
  if (!title) return null;

  let host = "";
  try {
    host = new URL(pageUrl).hostname;
  } catch {
    // An unparseable page URL only costs the arXiv host signal.
  }
  const itemType = itemTypeFor(meta, host);
  const arxivId = first(meta, "citation_arxiv_id");
  const item: ZoteroItemData = {
    itemType,
    title: title.slice(0, MAX_TITLE_CHARS),
    creators: (meta.get("citation_author") ?? [])
      .slice(0, MAX_CREATORS)
      .map(parseCreator)
      .filter((creator): creator is ZoteroCreator => creator !== null),
    url: httpUrl(first(meta, "citation_abstract_html_url"), pageUrl) ?? pageUrl,
    accessDate,
  };

  const date = first(meta, "citation_publication_date", "citation_date", "citation_online_date");
  if (date) item.date = normalizeDate(date);
  // arXiv registers a DataCite DOI for every paper and states the identifier
  // rather than the DOI, so the DOI is derived from it.
  const doi = first(meta, "citation_doi") ?? (arxivId ? `10.48550/arXiv.${arxivId}` : undefined);
  if (doi) item.DOI = field(doi.replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)/i, ""));
  const abstract = first(meta, "citation_abstract", "dc.description") ?? snapshot.abstract;
  if (abstract) item.abstractNote = abstract.slice(0, MAX_ABSTRACT_CHARS);
  const language = first(meta, "citation_language", "dc.language");
  if (language) item.language = field(language);
  const volume = first(meta, "citation_volume");
  if (volume) item.volume = field(volume);
  const firstPage = first(meta, "citation_firstpage");
  const lastPage = first(meta, "citation_lastpage");
  if (firstPage) item.pages = field(lastPage ? `${firstPage}-${lastPage}` : firstPage);
  const publisher = first(meta, "citation_publisher");

  switch (itemType) {
    case "conferencePaper": {
      const proceedings = first(meta, "citation_inbook_title", "citation_conference_title");
      if (proceedings) item.proceedingsTitle = field(proceedings);
      const conference = first(meta, "citation_conference_title", "citation_conference");
      if (conference && conference !== proceedings) item.conferenceName = field(conference);
      if (publisher) item.publisher = field(publisher);
      const isbn = first(meta, "citation_isbn");
      if (isbn) item.ISBN = field(isbn);
      break;
    }
    case "journalArticle": {
      const journal = first(meta, "citation_journal_title");
      if (journal) item.publicationTitle = field(journal);
      const abbreviation = first(meta, "citation_journal_abbrev");
      if (abbreviation) item.journalAbbreviation = field(abbreviation);
      const issue = first(meta, "citation_issue");
      if (issue) item.issue = field(issue);
      const issn = first(meta, "citation_issn");
      if (issn) item.ISSN = field(issn);
      break;
    }
    case "preprint": {
      const repository = host.endsWith("arxiv.org") ? "arXiv" : publisher;
      if (repository) item.repository = field(repository);
      if (arxivId) item.archiveID = field(`arXiv:${arxivId}`);
      break;
    }
    case "thesis": {
      const university = first(meta, "citation_dissertation_institution");
      if (university) item.university = field(university);
      break;
    }
    case "report": {
      const institution = first(meta, "citation_technical_report_institution");
      if (institution) item.institution = field(institution);
      const number = first(meta, "citation_technical_report_number");
      if (number) item.reportNumber = field(number);
      break;
    }
    default:
      break;
  }

  const tags = (meta.get("citation_keywords") ?? [])
    .flatMap((keywords) => keywords.split(/[;,]/))
    .map((tag) => tag.trim().slice(0, 100))
    .filter(Boolean);
  if (tags.length > 0) item.tags = [...new Set(tags)].slice(0, MAX_TAGS).map((tag) => ({ tag }));

  const pdfUrl = httpUrl(first(meta, "citation_pdf_url"), pageUrl);
  return pdfUrl ? { item, pdfUrl } : { item };
}

/**
 * The item a `zotero` site rule files when the page carries no citation data:
 * the user named Zotero for the site outright, so the page goes there as a web
 * page rather than being refused or rerouted.
 */
export function webpageCitation(
  title: string,
  pageUrl: string,
  accessDate: string,
): ZoteroCitation {
  let site = "";
  try {
    site = new URL(pageUrl).hostname;
  } catch {
    // No website title, then.
  }
  return {
    item: {
      itemType: "webpage",
      title: (collapse(title) || pageUrl).slice(0, MAX_TITLE_CHARS),
      creators: [],
      url: pageUrl,
      accessDate,
      ...(site ? { websiteTitle: site } : {}),
    },
  };
}

/**
 * Drop the fields the running Zotero does not list for the item's type. Zotero
 * refuses an object with an unknown field outright, and the schema moves between
 * versions, so asking it is cheaper than keeping a copy of it here.
 */
export function pruneToSchema(item: ZoteroItemData, fields: ReadonlySet<string>): ZoteroItemData {
  const kept: ZoteroItemData = {
    itemType: item.itemType,
    title: item.title,
    creators: item.creators,
  };
  for (const [name, value] of Object.entries(item)) {
    if (name === "itemType" || name === "title" || name === "creators") continue;
    if (name === "tags" || fields.has(name)) kept[name] = value;
  }
  return kept;
}

/** A PDF's file name in the library: `Author - Year - Title.pdf`, bare (no path separators). */
export function pdfFileName(item: ZoteroItemData): string {
  const creator = item.creators[0];
  const author = creator?.lastName ?? creator?.name ?? "Unknown";
  const date = typeof item.date === "string" ? item.date : "";
  const year = /^\d{4}/.exec(date)?.[0] ?? "n.d.";
  const base = `${author} - ${year} - ${item.title}`
    // oxlint-disable-next-line no-control-regex -- control characters are exactly what a file name must not carry
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .trim();
  return `${base || "Full Text"}.pdf`;
}

/** "2017/06/12" → "2017-06-12", "2019/6" → "2019-06"; anything else as written. */
export function normalizeDate(raw: string): string {
  const match = /^(\d{4})(?:[/-](\d{1,2})(?:[/-](\d{1,2}))?)?/.exec(raw.trim());
  if (!match) return field(raw);
  const [, year, month, day] = match;
  return [year, month?.padStart(2, "0"), day?.padStart(2, "0")]
    .filter((part): part is string => !!part)
    .join("-");
}

/**
 * `citation_author` is "Last, First" on arXiv and "First Last" on ACL and PMLR,
 * with nothing saying which. A comma decides; otherwise the last word is the
 * surname, which is wrong for some names and is what Zotero's own Embedded
 * Metadata translator does too.
 */
export function parseCreator(raw: string): ZoteroCreator | null {
  const name = collapse(raw).slice(0, MAX_FIELD_CHARS);
  if (!name) return null;
  const comma = name.indexOf(",");
  if (comma > 0) {
    const lastName = name.slice(0, comma).trim();
    const firstName = name.slice(comma + 1).trim();
    return firstName
      ? { creatorType: "author", firstName, lastName }
      : { creatorType: "author", name: lastName };
  }
  const space = name.lastIndexOf(" ");
  if (space < 0) return { creatorType: "author", name };
  return {
    creatorType: "author",
    firstName: name.slice(0, space).trim(),
    lastName: name.slice(space + 1).trim(),
  };
}

/**
 * Highwire tags carry no item type, so the type is read off which tags exist.
 * A page that names none of them is filed as a journal article, the default
 * Zotero's Embedded Metadata translator uses for the same tags.
 */
function itemTypeFor(meta: ReadonlyMap<string, string[]>, host: string): string {
  if (first(meta, "citation_conference_title", "citation_conference")) return "conferencePaper";
  if (first(meta, "citation_journal_title")) return "journalArticle";
  if (first(meta, "citation_dissertation_institution")) return "thesis";
  if (first(meta, "citation_technical_report_institution")) return "report";
  if (first(meta, "citation_arxiv_id") || host === "arxiv.org" || host.endsWith(".arxiv.org")) {
    return "preprint";
  }
  return "journalArticle";
}

function metaMap(entries: ReadonlyArray<[string, string]>): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const [name, content] of entries) map.set(name, [...(map.get(name) ?? []), content]);
  return map;
}

function first(meta: ReadonlyMap<string, string[]>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = meta.get(name)?.[0];
    if (value) return value;
  }
  return undefined;
}

/** Resolved against the page, http(s) only, and upgraded from http — PMLR still emits http:// links. */
function httpUrl(raw: string | undefined, base: string): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw, base);
    if (url.protocol === "http:") url.protocol = "https:";
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function field(text: string): string {
  return collapse(text).slice(0, MAX_FIELD_CHARS);
}
