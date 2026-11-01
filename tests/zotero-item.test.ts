import { describe, expect, test } from "bun:test";
import {
  citationFromSnapshot,
  normalizeDate,
  parseCitationSnapshot,
  parseCreator,
  pdfFileName,
  pruneToSchema,
  webpageCitation,
  type CitationSnapshot,
} from "../src/zotero-item.js";

const NOW = "2026-10-20T00:00:00.000Z";

// Tag sets as the three pages served them on 2026-10-19 (the local API spike),
// trimmed to what the mapping reads.
const ARXIV: CitationSnapshot = {
  url: "https://arxiv.org/abs/1706.03762",
  meta: [
    ["citation_title", "Attention Is All You Need"],
    ["citation_author", "Vaswani, Ashish"],
    ["citation_author", "Shazeer, Noam"],
    ["citation_author", "Gomez, Aidan N."],
    ["citation_date", "2017/06/12"],
    ["citation_online_date", "2023/08/02"],
    ["citation_pdf_url", "https://arxiv.org/pdf/1706.03762"],
    ["citation_arxiv_id", "1706.03762"],
    ["citation_abstract", "The dominant sequence transduction models are based on ..."],
  ],
};

const ACL: CitationSnapshot = {
  url: "https://aclanthology.org/N19-1423/",
  meta: [
    ["citation_title", "BERT: Pre-training of Deep Bidirectional Transformers"],
    ["citation_author", "Jacob Devlin"],
    ["citation_author", "Ming-Wei Chang"],
    ["citation_conference_title", "Proceedings of the 2019 Conference of the NAACL"],
    ["citation_publication_date", "2019/6"],
    ["citation_pdf_url", "https://aclanthology.org/N19-1423.pdf"],
    ["citation_firstpage", "4171"],
    ["citation_lastpage", "4186"],
    ["citation_doi", "10.18653/v1/N19-1423"],
  ],
  abstract: "We introduce a new language representation model called BERT ...",
};

const PMLR: CitationSnapshot = {
  url: "https://proceedings.mlr.press/v37/ioffe15.html",
  meta: [
    ["citation_title", "Batch Normalization"],
    ["citation_author", "Sergey Ioffe"],
    ["citation_author", "Christian Szegedy"],
    [
      "citation_inbook_title",
      "Proceedings of the 32nd International Conference on Machine Learning",
    ],
    ["citation_conference_title", "International Conference on Machine Learning"],
    ["citation_publication_date", "2015/06/01"],
    ["citation_pdf_url", "http://proceedings.mlr.press/v37/ioffe15.pdf"],
    ["citation_firstpage", "448"],
    ["citation_lastpage", "456"],
    ["citation_language", "en"],
  ],
  abstract: "Training Deep Neural Networks is complicated by ...",
};

describe("citationFromSnapshot()", () => {
  test("arXiv: a preprint, its DOI derived from the identifier", () => {
    const citation = citationFromSnapshot(ARXIV, NOW);
    expect(citation?.item).toEqual({
      itemType: "preprint",
      title: "Attention Is All You Need",
      creators: [
        { creatorType: "author", lastName: "Vaswani", firstName: "Ashish" },
        { creatorType: "author", lastName: "Shazeer", firstName: "Noam" },
        { creatorType: "author", lastName: "Gomez", firstName: "Aidan N." },
      ],
      url: "https://arxiv.org/abs/1706.03762",
      accessDate: NOW,
      date: "2017-06-12",
      DOI: "10.48550/arXiv.1706.03762",
      abstractNote: "The dominant sequence transduction models are based on ...",
      repository: "arXiv",
      archiveID: "arXiv:1706.03762",
    });
    expect(citation?.pdfUrl).toBe("https://arxiv.org/pdf/1706.03762");
  });

  test("ACL: a conference paper, its abstract from the page body", () => {
    const citation = citationFromSnapshot(ACL, NOW);
    expect(citation?.item.itemType).toBe("conferencePaper");
    expect(citation?.item.proceedingsTitle).toBe("Proceedings of the 2019 Conference of the NAACL");
    expect(citation?.item.conferenceName).toBeUndefined();
    expect(citation?.item.pages).toBe("4171-4186");
    expect(citation?.item.date).toBe("2019-06");
    expect(citation?.item.abstractNote).toBe(ACL.abstract);
    expect(citation?.item.creators[1]).toEqual({
      creatorType: "author",
      firstName: "Ming-Wei",
      lastName: "Chang",
    });
  });

  test("PMLR: proceedings and conference both named, the http PDF link upgraded", () => {
    const citation = citationFromSnapshot(PMLR, NOW);
    expect(citation?.item.proceedingsTitle).toBe(
      "Proceedings of the 32nd International Conference on Machine Learning",
    );
    expect(citation?.item.conferenceName).toBe("International Conference on Machine Learning");
    expect(citation?.item.language).toBe("en");
    expect(citation?.item.DOI).toBeUndefined();
    expect(citation?.pdfUrl).toBe("https://proceedings.mlr.press/v37/ioffe15.pdf");
  });

  test("a page without citation_title is not a paper", () => {
    expect(
      citationFromSnapshot(
        { url: "https://example.com/", meta: [["citation_author", "A B"]] },
        NOW,
      ),
    ).toBeNull();
    expect(citationFromSnapshot({ url: "https://example.com/", meta: [] }, NOW)).toBeNull();
  });

  test("a journal article carries its journal, issue and ISSN", () => {
    const citation = citationFromSnapshot(
      {
        url: "https://journal.example/article/1",
        meta: [
          ["citation_title", "A Result"],
          ["citation_journal_title", "Journal of Results"],
          ["citation_issue", "4"],
          ["citation_issn", "1234-5678"],
          ["citation_doi", "https://doi.org/10.1000/xyz"],
          ["citation_keywords", "alpha; beta, alpha"],
        ],
      },
      NOW,
    );
    expect(citation?.item.itemType).toBe("journalArticle");
    expect(citation?.item.publicationTitle).toBe("Journal of Results");
    expect(citation?.item.issue).toBe("4");
    expect(citation?.item.ISSN).toBe("1234-5678");
    // A DOI written as a resolver link is stored as the bare DOI.
    expect(citation?.item.DOI).toBe("10.1000/xyz");
    expect(citation?.item.tags).toEqual([{ tag: "alpha" }, { tag: "beta" }]);
  });

  test("a page that names no type is filed as a journal article", () => {
    const citation = citationFromSnapshot(
      { url: "https://repo.example/x", meta: [["citation_title", "Untyped"]] },
      NOW,
    );
    expect(citation?.item.itemType).toBe("journalArticle");
  });

  test("a PDF link that is not http(s) is dropped, not followed", () => {
    const citation = citationFromSnapshot(
      {
        url: "https://repo.example/x",
        meta: [
          ["citation_title", "T"],
          ["citation_pdf_url", "javascript:alert(1)"],
        ],
      },
      NOW,
    );
    expect(citation?.pdfUrl).toBeUndefined();
  });
});

describe("parseCitationSnapshot()", () => {
  test("keeps well-formed entries, lowercases names, collapses whitespace", () => {
    expect(
      parseCitationSnapshot({
        url: "https://a.example/",
        meta: [
          ["Citation_Title", "  Two\n  lines "],
          ["citation_author", 7],
          "junk",
          ["citation_author", ""],
        ],
        abstract: "  An\tabstract ",
      }),
    ).toEqual({
      url: "https://a.example/",
      meta: [["citation_title", "Two lines"]],
      abstract: "An abstract",
    });
  });

  test("refuses a result with no http(s) page address or no meta list", () => {
    expect(parseCitationSnapshot({ url: "about:blank", meta: [] })).toBeNull();
    expect(parseCitationSnapshot({ url: "https://a.example/" })).toBeNull();
    expect(parseCitationSnapshot(null)).toBeNull();
  });

  test("caps what a page can send", () => {
    const meta = Array.from({ length: 1000 }, (_, i) => ["citation_author", `A${i} B`]);
    const parsed = parseCitationSnapshot({ url: "https://a.example/", meta });
    expect(parsed?.meta.length).toBe(400);
  });
});

describe("parseCreator()", () => {
  test.each([
    ["Vaswani, Ashish", { creatorType: "author", lastName: "Vaswani", firstName: "Ashish" }],
    ["Jacob Devlin", { creatorType: "author", firstName: "Jacob", lastName: "Devlin" }],
    ["Plato", { creatorType: "author", name: "Plato" }],
    ["Consortium,", { creatorType: "author", name: "Consortium" }],
  ])("%j", (raw, creator) => {
    expect(parseCreator(raw)).toEqual(creator as ReturnType<typeof parseCreator>);
  });

  test("an empty name is no creator", () => {
    expect(parseCreator("   ")).toBeNull();
  });
});

describe("normalizeDate()", () => {
  test.each([
    ["2017/06/12", "2017-06-12"],
    ["2019/6", "2019-06"],
    ["2015", "2015"],
    ["June 2015", "June 2015"],
  ])("%s → %s", (raw, date) => {
    expect(normalizeDate(raw)).toBe(date);
  });
});

describe("webpageCitation()", () => {
  test("a zotero rule's page with no citation data goes as a web page", () => {
    expect(webpageCitation("  A  page ", "https://blog.example/post", NOW)).toEqual({
      item: {
        itemType: "webpage",
        title: "A page",
        creators: [],
        url: "https://blog.example/post",
        accessDate: NOW,
        websiteTitle: "blog.example",
      },
    });
  });
});

describe("pruneToSchema()", () => {
  test("drops fields the running Zotero does not list for the type, keeps the structure", () => {
    const item = citationFromSnapshot(ACL, NOW)?.item;
    if (!item) throw new Error("ACL fixture did not map");
    const pruned = pruneToSchema({ ...item, tags: [{ tag: "x" }] }, new Set(["DOI", "pages"]));
    expect(Object.keys(pruned).sort()).toEqual(
      ["DOI", "creators", "itemType", "pages", "tags", "title"].sort(),
    );
  });
});

describe("pdfFileName()", () => {
  test("Author - Year - Title, with no path separators", () => {
    const item = citationFromSnapshot(ARXIV, NOW)?.item;
    if (!item) throw new Error("arXiv fixture did not map");
    expect(pdfFileName(item)).toBe("Vaswani - 2017 - Attention Is All You Need.pdf");
    expect(pdfFileName({ itemType: "webpage", title: "a/b\\c: d?", creators: [] })).toBe(
      "Unknown - n.d. - abc d.pdf",
    );
  });
});
