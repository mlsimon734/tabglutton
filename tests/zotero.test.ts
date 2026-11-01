import { afterEach, describe, expect, test } from "bun:test";
import { md5Hex } from "../src/md5.js";
import {
  connectZotero,
  failureForStatus,
  saveCitationToZotero,
  ZOTERO_LOCAL_ORIGIN,
  ZoteroError,
  zoteroReachability,
  type ZoteroFailureKind,
} from "../src/zotero.js";
import type { ZoteroCitation } from "../src/zotero-item.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | Uint8Array | undefined;
}

type Handler = (req: Seen) => Response | undefined;

/**
 * A stand-in for Zotero's local API, answering the way server_localAPI.js does
 * at 10.0.6. Each test gets its own server id, because the client caches the
 * schema and collections per instance.
 */
function fakeZotero(serverId: string, override: Handler = () => undefined): Seen[] {
  const seen: Seen[] = [];
  const items = new Map<string, Record<string, unknown>>();
  const collections: Array<{ key: string; data: { name: string } }> = [];
  let next = 0;
  const pendingMd5 = new Map<string, string>();
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Zotero-Server-ID": serverId, "Content-Type": "application/json" },
    });

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body =
      init?.body instanceof Uint8Array
        ? init.body
        : ((init?.body as string | undefined) ?? undefined);
    const req: Seen = {
      method: init?.method ?? "GET",
      path: url.pathname + url.search,
      headers,
      body,
    };
    seen.push(req);
    if (url.origin !== ZOTERO_LOCAL_ORIGIN) throw new TypeError("unexpected origin");
    // server.js drops a browser-shaped request with no allow header: no status at all.
    if (headers["zotero-allowed-request"] !== "1") throw new TypeError("connection dropped");
    const answered = override(req);
    if (answered) return answered;

    if (req.method === "GET" && url.pathname === "/api/") return json({});
    if (req.method === "GET" && url.pathname === "/api/itemTypeFields") {
      return json(
        ["title", "abstractNote", "date", "DOI", "url", "accessDate", "pages"].map((field) => ({
          field,
        })),
      );
    }
    if (req.method !== "GET" && !url.pathname.startsWith("/api/local/uploads/")) {
      if (headers["zotero-server-id"] !== serverId) return new Response("", { status: 412 });
      if (headers["zotero-api-key"] !== "good-key") return new Response("", { status: 401 });
    }
    if (req.method === "GET" && url.pathname === "/api/users/0/collections/top") {
      return json(collections);
    }
    if (req.method === "POST" && url.pathname === "/api/users/0/collections") {
      const [created] = JSON.parse(String(body)) as Array<{ name: string }>;
      const key = `C${(next += 1)}`;
      collections.push({ key, data: { name: created?.name ?? "" } });
      return json({ successful: { "0": { key } }, failed: {} });
    }
    if (req.method === "POST" && url.pathname === "/api/users/0/items") {
      const [object] = JSON.parse(String(body)) as Array<Record<string, unknown>>;
      const key = `I${(next += 1)}`;
      items.set(key, { ...object });
      return json({ successful: { "0": { key } }, failed: {} });
    }
    const file = /^\/api\/users\/0\/items\/(\w+)\/file$/.exec(url.pathname);
    if (req.method === "POST" && file) {
      const params = new URLSearchParams(String(body));
      const itemKey = file[1] ?? "";
      if (params.has("upload")) {
        const item = items.get(itemKey);
        if (item) item.md5 = pendingMd5.get(params.get("upload") ?? "");
        return new Response(null, { status: 204 });
      }
      const uploadKey = `U${(next += 1)}`;
      pendingMd5.set(uploadKey, params.get("md5") ?? "");
      // Zotero builds this from the request's Host header; the client must use only its path.
      return json({ url: `http://localhost:23119/api/local/uploads/${uploadKey}`, uploadKey });
    }
    const upload = /^\/api\/local\/uploads\/(\w+)$/.exec(url.pathname);
    if (req.method === "POST" && upload) {
      const bytes = body instanceof Uint8Array ? body : new Uint8Array();
      const expected = pendingMd5.get(upload[1] ?? "");
      return new Response(null, { status: md5Hex(bytes) === expected ? 201 : 412 });
    }
    const item = /^\/api\/users\/0\/items\/(\w+)$/.exec(url.pathname);
    if (req.method === "GET" && item) {
      const data = items.get(item[1] ?? "");
      return data ? json({ key: item[1], data }) : new Response("", { status: 404 });
    }
    return new Response("unhandled", { status: 500 });
  }) as typeof fetch;
  return seen;
}

const PDF = new TextEncoder().encode("%PDF-1.7 tiny but real enough");

function paper(pdfUrl?: string): ZoteroCitation {
  return {
    item: {
      itemType: "conferencePaper",
      title: "BERT",
      creators: [{ creatorType: "author", firstName: "Jacob", lastName: "Devlin" }],
      DOI: "10.18653/v1/N19-1423",
      // Not in the fake schema: must be dropped, not sent.
      proceedingsTitle: "NAACL",
    },
    ...(pdfUrl ? { pdfUrl } : {}),
  };
}

async function kindOf(promise: Promise<unknown>): Promise<ZoteroFailureKind | "resolved"> {
  try {
    await promise;
    return "resolved";
  } catch (err) {
    if (err instanceof ZoteroError) return err.kind;
    throw err;
  }
}

describe("failureForStatus()", () => {
  test.each([
    [401, "write", "key-rejected"],
    [403, "read", "api-disabled"],
    [403, "write", "refused"],
    [412, "write", "server-changed"],
    [429, "write", "rate-limited"],
    [428, "write", "refused"],
    [500, "read", "refused"],
  ] as const)("%i on a %s is %s", (status, phase, kind) => {
    expect(failureForStatus(status, phase)).toBe(kind);
  });
});

describe("saveCitationToZotero()", () => {
  test("files the item into the collection, attaches the PDF, and reads both back", async () => {
    const seen = fakeZotero("S-happy");
    const receipt = await saveCitationToZotero(paper("https://aclanthology.org/N19-1423.pdf"), {
      key: "good-key",
      collection: "Tabglutton test",
      fetchPdf: async () => PDF,
    });
    expect(receipt).toEqual({ itemKey: expect.any(String), pdf: "attached" });

    // Every request carries the allow header, or Zotero would have dropped it.
    expect(seen.every((req) => req.headers["zotero-allowed-request"] === "1")).toBe(true);
    const created = seen.find((req) => req.path === "/api/users/0/items" && req.method === "POST");
    const sent = JSON.parse(String(created?.body)) as Array<Record<string, unknown>>;
    expect(sent[0]?.proceedingsTitle).toBeUndefined();
    expect(sent[0]?.DOI).toBe("10.18653/v1/N19-1423");
    expect(sent[0]?.collections).toEqual(["C1"]);
    // The bytes went to Zotero's path on our own origin, never to the host it named.
    expect(seen.some((req) => req.path.startsWith("/api/local/uploads/"))).toBe(true);
  });

  test("creates a missing collection once, however many saves race for it", async () => {
    const seen = fakeZotero("S-race");
    const options = { key: "good-key", collection: "Papers", fetchPdf: async () => PDF };
    await Promise.all([1, 2, 3].map(() => saveCitationToZotero(paper(), options)));
    const creates = seen.filter(
      (req) => req.method === "POST" && req.path === "/api/users/0/collections",
    );
    expect(creates.length).toBe(1);
  });

  test("a collection deleted between saves is looked up again, not served from memory", async () => {
    let deleted = false;
    const seen = fakeZotero("S-deleted", (req) =>
      deleted && req.path.startsWith("/api/users/0/collections/top")
        ? new Response("[]", { status: 200, headers: { "Zotero-Server-ID": "S-deleted" } })
        : undefined,
    );
    const options = { key: "good-key", collection: "Papers", fetchPdf: async () => PDF };
    await saveCitationToZotero(paper(), options);
    deleted = true;
    await saveCitationToZotero(paper(), options);
    const items = seen
      .filter((req) => req.method === "POST" && req.path === "/api/users/0/items")
      .map((req) => (JSON.parse(String(req.body)) as Array<{ collections?: string[] }>)[0]);
    expect(items.map((item) => item?.collections)).toEqual([["C1"], ["C3"]]);
  });

  test("a title Zotero stores normalized still reads back as the one sent", async () => {
    const decomposed = "Cafe\u0301 au lait";
    fakeZotero("S-nfc", (req) =>
      req.method === "GET" && /^\/api\/users\/0\/items\/\w+$/.test(req.path)
        ? new Response(JSON.stringify({ data: { title: decomposed.normalize() } }), {
            status: 200,
            headers: { "Zotero-Server-ID": "S-nfc" },
          })
        : undefined,
    );
    const citation = paper();
    citation.item.title = decomposed;
    const receipt = await saveCitationToZotero(citation, {
      key: "good-key",
      collection: "",
      fetchPdf: async () => PDF,
    });
    expect(receipt.pdf).toBe("none");
  });

  test("a blank collection files into the library root", async () => {
    const seen = fakeZotero("S-root");
    await saveCitationToZotero(paper(), {
      key: "good-key",
      collection: " ",
      fetchPdf: async () => PDF,
    });
    expect(seen.some((req) => req.path.includes("/collections"))).toBe(false);
  });

  test("a PDF that cannot be had leaves the saved item, and says why", async () => {
    fakeZotero("S-nopdf");
    const receipt = await saveCitationToZotero(paper("https://example.org/paper.pdf"), {
      key: "good-key",
      collection: "",
      fetchPdf: async () => new TextEncoder().encode("<html>Just a moment...</html>"),
    });
    expect(receipt.pdf).toBe("failed");
    expect(receipt.pdfNote).toContain("did not return a PDF");
  });

  test("a key refused mid-PDF fails the PDF, not the item already in the library", async () => {
    fakeZotero("S-midpdf", (req) =>
      req.method === "POST" && /\/items\/\w+\/file$/.test(req.path)
        ? new Response("", { status: 401 })
        : undefined,
    );
    const receipt = await saveCitationToZotero(paper("https://example.org/paper.pdf"), {
      key: "good-key",
      collection: "",
      fetchPdf: async () => PDF,
    });
    expect(receipt.pdf).toBe("failed");
    expect(receipt.pdfNote).toContain("Connect to Zotero");
  });

  test("no key is not connected, and nothing is written", async () => {
    const seen = fakeZotero("S-nokey");
    expect(
      await kindOf(
        saveCitationToZotero(paper(), { key: "", collection: "", fetchPdf: async () => PDF }),
      ),
    ).toBe("not-connected");
    expect(seen.length).toBe(0);
  });

  test("a key Zotero no longer knows is key-rejected", async () => {
    fakeZotero("S-badkey");
    expect(
      await kindOf(
        saveCitationToZotero(paper(), { key: "stale", collection: "", fetchPdf: async () => PDF }),
      ),
    ).toBe("key-rejected");
  });

  test("the local API switched off is api-disabled", async () => {
    fakeZotero("S-off", (req) =>
      req.path === "/api/" ? new Response("Local API is not enabled", { status: 403 }) : undefined,
    );
    expect(
      await kindOf(
        saveCitationToZotero(paper(), {
          key: "good-key",
          collection: "",
          fetchPdf: async () => PDF,
        }),
      ),
    ).toBe("api-disabled");
  });

  test("no answer at all is unreachable", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(
      await kindOf(
        saveCitationToZotero(paper(), {
          key: "good-key",
          collection: "",
          fetchPdf: async () => PDF,
        }),
      ),
    ).toBe("unreachable");
  });

  test("an item that reads back different is not a save", async () => {
    fakeZotero("S-mismatch", (req) =>
      req.method === "GET" && /^\/api\/users\/0\/items\/\w+$/.test(req.path)
        ? new Response(JSON.stringify({ data: { title: "Something else" } }), {
            status: 200,
            headers: { "Zotero-Server-ID": "S-mismatch" },
          })
        : undefined,
    );
    expect(
      await kindOf(
        saveCitationToZotero(paper(), {
          key: "good-key",
          collection: "",
          fetchPdf: async () => PDF,
        }),
      ),
    ).toBe("refused");
  });
});

describe("connectZotero()", () => {
  const authorize = (serverId: string, answer: Response): void => {
    fakeZotero(serverId, (req) => (req.path === "/api/local/authorize" ? answer : undefined));
  };

  test("Always Allow returns the key", async () => {
    authorize("S-c1", new Response(JSON.stringify({ key: "k1", remember: true }), { status: 200 }));
    expect(await connectZotero()).toEqual({ kind: "connected", key: "k1" });
  });

  test("Allow once returns no key: it would be spent by the first of a save's writes", async () => {
    authorize(
      "S-c2",
      new Response(JSON.stringify({ key: "k2", remember: false }), { status: 200 }),
    );
    expect(await connectZotero()).toEqual({ kind: "once" });
  });

  test("Deny is denied, and Zotero's rate limit is rate-limited", async () => {
    authorize("S-c3", new Response("", { status: 403 }));
    expect(await kindOf(connectZotero())).toBe("denied");
    authorize("S-c4", new Response("", { status: 429 }));
    expect(await kindOf(connectZotero())).toBe("rate-limited");
  });
});

describe("zoteroReachability()", () => {
  test("ready, switched off, or not there", async () => {
    fakeZotero("S-r1");
    expect(await zoteroReachability()).toBe("ready");
    fakeZotero("S-r2", (req) =>
      req.path === "/api/" ? new Response("", { status: 403 }) : undefined,
    );
    expect(await zoteroReachability()).toBe("api-disabled");
    globalThis.fetch = (async () => {
      throw new TypeError("refused");
    }) as unknown as typeof fetch;
    expect(await zoteroReachability()).toBe("unreachable");
  });
});
