# Zotero routing

With **Route papers to Zotero** on, Devour and `tab_clip` save a tab that carries citation data
into the user's Zotero library, with its PDF, instead of writing it as a note. Tabglutton talks to
Zotero desktop directly, through the local API Zotero 10 added, and needs no Zotero Connector
([#113](https://github.com/mlsimon734/tabglutton/issues/113)). The file keeps its old name because
it started as the Connector proof of concept; that history is at the end.

## How a paper is filed

1. **The page decides whether it is a paper.** Tabglutton injects a small reader into the tab and
   collects its Highwire `citation_*` meta tags, which arXiv, OpenReview, ACL Anthology, PMLR, and
   most publishers emit for Google Scholar. A page with no `citation_title` is not a paper and goes
   to the clip destination as before. `src/zotero-item.ts` maps the tags to a Zotero item: the item
   type is inferred (conference, journal, thesis, report, or arXiv preprint; a page that names none
   is a journal article), names are split per their written order, an arXiv id yields its DataCite
   DOI, and the abstract falls back to the page body where no tag carries it.
2. **The item is written and read back.** `src/zotero.ts` reads Zotero's server id, drops any field
   the running Zotero does not list for that item type, finds or creates the configured top-level
   collection, creates the item, and reads it back to check the title and collection. That read is
   what `confirmedBy: "browser"` means.
3. **The PDF is attached.** The extension fetches `citation_pdf_url` with the user's cookies, checks
   that it is a PDF of at most 64 MB, creates an `imported_url` attachment, uploads the bytes, and
   reads the attachment back for its MD5. A PDF that cannot be had (a bot check, a paywall) leaves
   the saved item with its URL and closes the tab. `tab_clip` says so in `pdf` / `pdfNote`; Devour
   only logs it to the console, and Zotero's **Find Available PDF** is the remedy for that item.

Anything that stops the item itself is `zotero-failed` with a sentence naming the remedy, and the tab
stays open. Routing never falls through to the note destination.

## What the user does

1. In Zotero 10 or later, turn on **Settings → Advanced → "Allow other applications on this
   computer to communicate with Zotero"**.
2. In Tabglutton's settings, turn on **Route papers to Zotero**. On Chrome this asks for access to
   `http://127.0.0.1`, the same optional permission the bridge uses; refusing leaves the switch off.
3. Press **Connect to Zotero** and choose **Always Allow** in the dialog Zotero shows. A plain
   **Allow** grants a single write, and filing a paper takes several, so Tabglutton does not keep it
   and says to connect again.
4. Optionally name a collection. Papers go into that top-level collection, created on first use, or
   into My Library when it is empty.

## What the local API requires

Read from Zotero's source at tag 10.0.6 where the documentation is silent, and confirmed live:

- Until the user turns the API on, every request answers `403`.
- Writes need a **local API key** from `POST /api/local/authorize` with an `appName`, approved by the
  user in a Zotero dialog. Unless the user picks **Always Allow** the key is single-use, and it is
  consumed by the first write that validates it even when that write then fails
  (`server_localAPI.js:652`). At most five dialog-raising requests are accepted a minute (`429`),
  and Deny answers `403`.
- Every write carries **`Zotero-Server-ID`**, returned on every response (`server_localAPI.js:594`);
  a write without it answers `428`, a mismatch `412`. Tabglutton reads it fresh for each save.
- **Browser-shaped requests are dropped with no response**: any `Origin` header, or a `Mozilla/`
  user agent, unless the request carries `Zotero-Allowed-Request`
  ([`server.js:414-432`](https://github.com/zotero/zotero/blob/10.0.6/chrome/content/zotero/xpcom/server/server.js#L414-L432)).
  An extension's own origin counts, so every request sends the header; without it Zotero looks
  exactly like Zotero not running.
- **No CORS headers** are sent except to the bookmarklet origin (`server.js:280`), so an extension
  needs a host permission for the loopback origin.
- A file upload is three requests: `POST items/<key>/file` with the MD5, name, size and mtime; the
  bytes to the returned `/api/local/uploads/<uploadKey>` with a binary content type (text, JSON and
  form bodies are decoded as text and corrupt the file); then `upload=<uploadKey>` to register it.
  Zotero checks the MD5, which WebCrypto does not offer, hence `src/md5.ts`. The upload URL's host
  is copied from the request's `Host` header, so Tabglutton uses only its path.

## Verification

**Live, 2026-10-19, against Zotero 10.0.6** with the user's real library, writing into a "Tabglutton
test" collection and deleting nothing (`scratch-chrome/zotero-live.ts`, local only). Chrome for
Testing 148 and Firefox 154, both headless, each passed the same run:

- Devour over arXiv 1706.03762, ACL Anthology N19-1423, PMLR v37 ioffe15, an OpenReview forum page,
  and a local page without citation tags. The three papers were filed with their PDFs, read back
  from the library directly (2.2 MB, 786 KB, 318 KB on disk), and their tabs closed; the run took
  1.2 s on Chrome and 1.3 s on Firefox with the tabs already loaded. The local page was not routed.
- OpenReview served both headless browsers its "Verifying your browser" challenge, so the tab
  carried no citation tags and was correctly not routed. OpenReview's forum page does emit
  `citation_title`, `citation_author`, and `citation_pdf_url` (`app/forum/page.js` in
  openreview-web), so a tab the user has open past the challenge should route — read from source,
  not measured.
- `tab_clip` with `close: true` through a fresh Gullet on a private port, on arXiv 1810.04805:
  `destination: "zotero"`, `confirmedBy: "browser"`, `pdf: "attached"`, closed; the item and PDF
  were in the library.
- A key Zotero does not know: `zotero-failed` with "Press Connect to Zotero … and choose Always
  Allow", tab kept open.
- "Copy diagnostics" carried `zoteroConnected` and not the key.

**Unit-tested only:** the Connect flow (Always Allow, Allow, Deny, rate limit) and the options
switch's permission request, because both need a person to click; the status table for `401`,
`403`, `412`, `428`, and `429`; schema pruning; the collection race; and the citation mapping
against the tag sets arXiv, ACL, and PMLR served on 2026-10-19.

## What it gives up against the Connector

The Connector's roughly 600 translators recognised pages this route does not: any site without
`citation_*` tags, and **standalone PDF tabs**, which no longer route to Zotero. It also loses
arXiv's category tags, author comment, and version links; publisher fields only the BibTeX carries;
the translators' per-site name order; PDFs behind a paywall the browser cannot fetch; and the
Connector's "save to the current collection" UI. For papers on arXiv, OpenReview, and conference
sites the loss is small.

## History: the Connector proof of concept

Routing first went through a patched Zotero Connector that answered two cross-extension requests,
`getTabInfo` (the Connector's own translator verdict) and `saveTab`. The published Connector never
exposed them, and the proposal was made upstream three times:

- [zotero-connectors#60](https://github.com/zotero/zotero-connectors/issues/60) (2018), where
  Tridactyl's maintainer first asked for the same API. It was closed on an unrelated question.
- [zotero-dev, 2026-08-17](https://groups.google.com/g/zotero-dev/c/Gd-U-z0rh10), the proposal as
  prose. No replies.
- [zotero-connectors#637](https://github.com/zotero/zotero-connectors/pull/637), the same proposal
  as a diff, with an `externalAPI.allowedExtensions` allowlist. **Declined 2026-09-28**: a
  maintainer wrote that they are "unlikely to merge and commit to maintaining something like this
  without a clearer value proposition to a broader number of our users".

Without the API the route was inert for everyone using a published Connector, so it was replaced by
the local API route rather than kept beside it. The patch lives on in that pull request.
