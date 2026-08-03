import { describe, test, expect } from "bun:test";
import { BridgeRequestError, type BridgeMethod } from "../../src/bridge-protocol.js";
import type { ConnectionSummary } from "../src/select.js";
import { createToolCaller, GULLET_TOOLS, type ToolContext } from "../src/tools.js";
import { chrome, zen } from "./fixtures.js";

interface Sent {
  connectionId: string;
  method: BridgeMethod;
  params: unknown;
}

function caller(
  connections: ConnectionSummary[],
  respond: (sent: Sent) => unknown,
  overrides: Partial<ToolContext> = {},
): { call: ReturnType<typeof createToolCaller>; sent: Sent[] } {
  const sent: Sent[] = [];
  const call = createToolCaller({
    connections: async () => connections,
    request: async (connectionId, method, params) => {
      const entry = { connectionId, method, params };
      sent.push(entry);
      return respond(entry);
    },
    startupError: () => null,
    ...overrides,
  });
  return { call, sent };
}

function payload(result: { content: Array<{ type: "text"; text: string }> }): unknown {
  return JSON.parse(result.content[0]?.text ?? "null");
}

describe("tool definitions", () => {
  test("exposes exactly the shipped tools", () => {
    expect(GULLET_TOOLS.map((t) => t.name)).toEqual([
      "tabs_list",
      "tabs_load",
      "tab_read",
      "tab_clip",
      "tabs_close",
      "undo_close",
    ]);
  });

  test("marks every tool that can close a tab destructive, and the reads read-only", () => {
    const byName = new Map(GULLET_TOOLS.map((t) => [t.name, t]));
    expect(byName.get("tabs_close")?.annotations?.destructiveHint).toBe(true);
    // `close: true` ends in tabs.remove, and annotations cannot vary by argument.
    expect(byName.get("tab_clip")?.annotations?.destructiveHint).toBe(true);
    expect(byName.get("undo_close")?.annotations?.destructiveHint).toBe(false);
    expect(byName.get("tab_read")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("tabs_list")?.annotations?.readOnlyHint).toBe(true);
    // Loading acts on a page, so it is not read-only — but it removes nothing.
    expect(byName.get("tabs_load")?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get("tabs_load")?.annotations?.destructiveHint).toBe(false);
  });

  test("every schema is a closed object, so bad arguments surface at the client", () => {
    for (const tool of GULLET_TOOLS) {
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    }
  });
});

describe("tabs_list", () => {
  const tab = (
    id: number,
    url: string,
    lastAccessed?: number,
    windowId = 1,
  ): Record<string, unknown> => ({
    id,
    title: `tab ${id}`,
    url,
    windowId,
    index: id,
    ...(lastAccessed === undefined ? {} : { lastAccessed }),
  });
  /** A tab as it comes back out: index dropped, windowId hoisted, url trimmed. */
  const shown = (id: number, url: string): Record<string, unknown> => ({
    id,
    title: `tab ${id}`,
    url,
  });

  test("fans out over every browser and stamps origin only on a merged listing", async () => {
    const { call } = caller([zen, chrome], ({ connectionId }) =>
      connectionId === "conn-1"
        ? { tabs: [tab(1, "https://a.test/")] }
        : { tabs: [tab(2, "https://b.test/")] },
    );
    expect(payload(await call("tabs_list", {}))).toEqual({
      browsers: [zen, chrome],
      // No hoisted windowId: both browsers call their window 1, and claiming a
      // single shared window across two browsers would be a lie.
      tabs: [
        { ...shown(1, "https://a.test"), windowId: 1, connectionId: "conn-1" },
        { ...shown(2, "https://b.test"), windowId: 1, connectionId: "conn-2" },
      ],
      matched: 2,
    });
  });

  test("leaves the origin off when only one browser is connected", async () => {
    const { call } = caller([zen], () => ({ tabs: [tab(1, "https://a.test/")] }));
    // The constants used to be repeated once per tab; `browsers` and the hoisted
    // `windowId` already say both.
    expect(payload(await call("tabs_list", {}))).toEqual({
      browsers: [zen],
      windowId: 1,
      tabs: [shown(1, "https://a.test")],
      matched: 1,
    });
  });

  test("clips a long title but still matches a query against the full one", async () => {
    const buried = `${"x".repeat(200)} needle`;
    const { call } = caller([zen], () => ({
      tabs: [{ ...tab(1, "https://a.test/"), title: buried }],
    }));
    const result = payload(await call("tabs_list", { query: "needle" })) as {
      tabs: Array<{ title: string }>;
      matched: number;
    };
    expect(result.matched).toBe(1);
    expect(result.tabs[0]?.title).toEndWith("…");
    expect(result.tabs[0]?.title).not.toContain("needle");
  });

  test("narrows to the named browser", async () => {
    const { call, sent } = caller([zen, chrome], () => ({ tabs: [] }));
    await call("tabs_list", { browser: "Chrome" });
    expect(sent.map((s) => s.connectionId)).toEqual(["conn-2"]);
  });

  test("forwards its own params but not the routing field", async () => {
    const { call, sent } = caller([zen], () => ({ tabs: [] }));
    await call("tabs_list", { browser: "Zen", scope: "current-window", query: "x" });
    expect(sent[0]?.params).toEqual({ scope: "current-window", query: "x" });
  });

  test("tolerates a browser that returns no tabs field", async () => {
    const { call } = caller([zen], () => ({}));
    expect(payload(await call("tabs_list", {}))).toMatchObject({ tabs: [] });
  });

  test("rejects bad arguments before dialling any browser", async () => {
    const { call, sent } = caller([zen], () => ({ tabs: [] }));
    const result = await call("tabs_list", { sort: "alphabetical" });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ error: "bad-request" });
    expect(sent).toEqual([]);
  });

  // Filtering and truncation run again here, over the merged set: an extension
  // that ignored `query` must not flood the agent anyway, and a per-browser
  // limit is not the limit the agent asked for.
  test("re-applies query and limit across browsers that ignored them", async () => {
    const { call } = caller([zen, chrome], ({ connectionId }) =>
      connectionId === "conn-1"
        ? { tabs: [tab(1, "https://x.com/a", 100), tab(2, "https://other.test/", 400)] }
        : { tabs: [tab(3, "https://x.com/b", 300), tab(4, "https://x.com/c", 200)] },
    );
    const result = payload(await call("tabs_list", { query: "x.com", limit: 2 })) as {
      tabs: Array<{ id: number }>;
      matched: number;
      truncated: boolean;
    };
    expect(result.tabs.map((t) => t.id)).toEqual([3, 4]);
    expect(result).toMatchObject({ matched: 3, truncated: true });
  });

  // A current extension truncates before sending, so the page that arrives is
  // not the match count. Recomputing `matched` here reported 2 of 900 as
  // "matched: 2" with no `truncated` — the agent's only signal that more
  // existed, lost precisely when it did. Invisible against an extension that
  // sends everything, which is why it survived a live run.
  test("keeps the browser's matched when the browser truncated for us", async () => {
    const { call } = caller([zen], () => ({
      tabs: [tab(1, "https://x.com/a", 400), tab(2, "https://x.com/b", 300)],
      matched: 900,
      truncated: true,
    }));
    const result = payload(await call("tabs_list", { query: "x.com", limit: 2 }));
    expect(result).toMatchObject({ matched: 900, truncated: true });
  });

  test("falls back to its own count for a browser that sent no matched", async () => {
    const { call } = caller([zen], () => ({
      tabs: [tab(1, "https://x.com/a"), tab(2, "https://x.com/b"), tab(3, "https://other.test/")],
    }));
    // No `matched` on the wire means the browser did not filter, so the honest
    // total is what our own filter kept — not the three tabs it handed over.
    expect(payload(await call("tabs_list", { query: "x.com" }))).toMatchObject({ matched: 2 });
  });

  test("sums matched across browsers of different vintages", async () => {
    const { call } = caller([zen, chrome], ({ connectionId }) =>
      connectionId === "conn-1"
        ? { tabs: [tab(1, "https://x.com/a", 400)], matched: 500 }
        : { tabs: [tab(2, "https://x.com/b", 300), tab(3, "https://no.test/")] },
    );
    // 500 reported by the new one, plus the single tab our filter keeps from
    // the old one's three.
    expect(payload(await call("tabs_list", { query: "x.com" }))).toMatchObject({
      matched: 501,
      truncated: true,
    });
  });

  // Regression, caught live: grouping ran on the unfiltered merge, so a query
  // plus groupBy counted the whole backlog. The browser here ignores `query`
  // entirely, which is the version skew that exposed it — a newer extension
  // pre-filters and would have hidden the bug rather than prevented it.
  test("groupBy honours query even when the browser ignored it", async () => {
    const { call } = caller([zen], () => ({
      tabs: [tab(1, "https://x.com/a"), tab(2, "https://x.com/b"), tab(3, "https://other.test/c")],
    }));
    const result = payload(await call("tabs_list", { query: "x.com", groupBy: "domain" }));
    expect(result).toMatchObject({
      groups: [{ domain: "x.com", tabs: 2, discarded: 0 }],
      domains: 1,
      matched: 2,
    });
  });

  test("groupBy: domain answers with counts across every browser and no tabs", async () => {
    const { call } = caller([zen, chrome], ({ connectionId }) =>
      connectionId === "conn-1"
        ? { tabs: [tab(1, "https://x.com/a"), tab(2, "https://www.x.com/b")] }
        : { tabs: [tab(3, "https://x.com/c"), tab(4, "https://other.test/")] },
    );
    const result = payload(await call("tabs_list", { groupBy: "domain" }));
    expect(result).toEqual({
      browsers: [zen, chrome],
      groups: [
        { domain: "x.com", tabs: 3, discarded: 0 },
        { domain: "other.test", tabs: 1, discarded: 0 },
      ],
      domains: 2,
      matched: 4,
    });
  });
});

describe("tab-scoped tools", () => {
  test("route to the only connection and tag the result with its origin", async () => {
    const { call, sent } = caller([zen], () => ({ tabId: 5, markdown: "# hi" }));
    const result = await call("tab_read", { tabId: 5 });
    expect(sent[0]).toEqual({ connectionId: "conn-1", method: "tab_read", params: { tabId: 5 } });
    expect(payload(result)).toEqual({
      browser: "Zen",
      connectionId: "conn-1",
      tabId: 5,
      markdown: "# hi",
    });
  });

  test("refuse to guess when two browsers are connected", async () => {
    const { call, sent } = caller([zen, chrome], () => ({}));
    const result = await call("tabs_close", { tabIds: [1] });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ error: "ambiguous-target" });
    expect(sent).toEqual([]);
  });

  test("act once the browser is named", async () => {
    const { call, sent } = caller([zen, chrome], () => ({ closed: 1, batchId: "b1" }));
    const result = await call("tabs_close", { browser: "chrome", tabIds: [1] });
    expect(sent[0]?.connectionId).toBe("conn-2");
    expect(payload(result)).toMatchObject({ browser: "Chrome", batchId: "b1" });
  });

  test("tabs_load routes like any tab-scoped tool", async () => {
    const { call, sent } = caller([zen], () => ({ tabs: [], ready: 0, pending: 0, failed: 0 }));
    const result = await call("tabs_load", { tabIds: [1, 2] });
    expect(sent[0]).toEqual({
      connectionId: "conn-1",
      method: "tabs_load",
      params: { tabIds: [1, 2] },
    });
    expect(payload(result)).toMatchObject({ browser: "Zen", ready: 0 });
  });

  test("tabs_load refuses to guess between two browsers, like every id-scoped tool", async () => {
    const { call, sent } = caller([zen, chrome], () => ({}));
    expect(payload(await call("tabs_load", { tabIds: [1] }))).toMatchObject({
      error: "ambiguous-target",
    });
    expect(sent).toEqual([]);
  });

  test("a browser with loading switched off is reported, not retried", async () => {
    const { call } = caller([zen], () => {
      throw new BridgeRequestError("not-enabled", "switched off");
    });
    const result = await call("tabs_load", { tabIds: [1] });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ error: "not-enabled" });
  });

  test("undo_close passes an omitted batchId straight through", async () => {
    const { call, sent } = caller([zen], () => ({ restored: 2 }));
    await call("undo_close", {});
    expect(sent[0]?.params).toEqual({});
  });
});

describe("error handling", () => {
  test("no connected browser is reported, not swallowed", async () => {
    const { call } = caller([], () => ({}));
    const result = await call("tabs_list", {});
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ error: "no-connection" });
  });

  test("a browser-side failure keeps its code so the agent can adapt", async () => {
    const { call } = caller([zen], () => {
      throw new BridgeRequestError("tab-discarded", "needs manual load");
    });
    const result = await call("tab_read", { tabId: 9 });
    expect(result.isError).toBe(true);
    expect(payload(result)).toEqual({ error: "tab-discarded", message: "needs manual load" });
  });

  test("an unexpected throw becomes an internal error rather than crashing the server", async () => {
    const { call } = caller([zen], () => {
      throw new Error("kaboom");
    });
    expect(payload(await call("tab_read", { tabId: 9 }))).toEqual({
      error: "internal",
      message: "kaboom",
    });
  });

  test("an unknown tool name is rejected before reaching the browser", async () => {
    const { call, sent } = caller([zen], () => ({}));
    const result = await call("tab_navigate", { url: "http://example.com" });
    expect(payload(result)).toMatchObject({ error: "bad-request" });
    expect(sent).toEqual([]);
  });

  test("a missing token is explained instead of failing to connect silently", async () => {
    const { call, sent } = caller([zen], () => ({}), {
      startupError: () => ({ code: "unauthorized", message: "no token" }),
    });
    const result = await call("tabs_list", {});
    expect(payload(result)).toMatchObject({ error: "unauthorized" });
    expect(sent).toEqual([]);
  });

  // The port-conflict case, which used to exit before the MCP handshake and so
  // could only be reported by the client as "connection closed".
  test("a startup fault answers every tool rather than killing the session", async () => {
    const { call, sent } = caller([zen], () => ({}), {
      startupError: () => ({
        code: "unsupported",
        message: "Another process is already listening",
      }),
    });
    for (const tool of GULLET_TOOLS) {
      const result = await call(tool.name, {});
      expect(result.isError).toBe(true);
      expect(payload(result)).toMatchObject({ error: "unsupported" });
    }
    expect(sent).toEqual([]);
  });
});

describe("tabs_list with a browser that fails", () => {
  test("keeps the listing the healthy browser returned", async () => {
    // Promise.all here would throw away Zen's tabs because Chrome timed out.
    const { call } = caller([zen, chrome], ({ connectionId }) => {
      if (connectionId === chrome.connectionId) {
        throw new BridgeRequestError("timeout", "tabs_list timed out after 45000ms.");
      }
      return { tabs: [{ id: 1, title: "kept" }] };
    });
    const result = payload(await call("tabs_list", {})) as {
      tabs: Array<Record<string, unknown>>;
      failures: Array<Record<string, unknown>>;
    };
    // Only Zen answered, so it is the sole entry in `browsers` and the tab needs
    // no per-tab origin stamped on it. This tab also has no url — a malformed
    // entry renders empty rather than throwing away the listing around it.
    expect(result.tabs).toEqual([{ id: 1, title: "kept", url: "" }]);
    expect(result.failures).toEqual([
      {
        connectionId: chrome.connectionId,
        browser: chrome.label,
        error: "timeout",
        message: "tabs_list timed out after 45000ms.",
      },
    ]);
  });

  test("omits the failures key when every browser answered", async () => {
    const { call } = caller([zen, chrome], () => ({ tabs: [] }));
    expect(payload(await call("tabs_list", {}))).not.toHaveProperty("failures");
  });

  test("every browser failing is an error, not an empty tab list", async () => {
    // An empty `tabs` would read as "the user has no tabs open", which is a
    // materially different thing to tell an agent than "nothing answered".
    const { call } = caller([zen, chrome], () => {
      throw new BridgeRequestError("no-connection", "gone");
    });
    const result = await call("tabs_list", {});
    expect(result.isError).toBe(true);
    expect(payload(result)).toEqual({ error: "no-connection", message: "gone" });
  });

  test("a single browser failing still surfaces its error", async () => {
    const { call } = caller([zen], () => {
      throw new BridgeRequestError("internal", "boom");
    });
    const result = await call("tabs_list", {});
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ error: "internal" });
  });
});
