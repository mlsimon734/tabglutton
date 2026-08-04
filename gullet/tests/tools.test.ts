import { describe, test, expect } from "bun:test";
import { BridgeRequestError, type BridgeMethod } from "../../src/bridge-protocol.js";
import type { ObsidianVaultLookup } from "../src/obsidian-vaults.js";
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

  test("fans out over every browser and stamps origin when multiple are targeted", async () => {
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

  test("keeps the origin when only one of two browsers has matches", async () => {
    const { call } = caller([zen, chrome], ({ connectionId }) =>
      connectionId === zen.connectionId ? { tabs: [tab(1, "https://a.test/")] } : { tabs: [] },
    );
    expect(payload(await call("tabs_list", {}))).toEqual({
      browsers: [zen, chrome],
      windowId: 1,
      tabs: [{ ...shown(1, "https://a.test"), connectionId: zen.connectionId }],
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

  test("tab_clip forwards a vault Obsidian's registry knows", async () => {
    const { call, sent } = caller([zen], () => ({ file: "Clippings/example.md" }), {
      knownObsidianVaults: async () => ["Main Vault", "Work"],
    });
    expect((await call("tab_clip", { tabId: 7, vault: "Main Vault" })).isError).toBeUndefined();
    expect(sent[0]).toMatchObject({
      method: "tab_clip",
      params: { tabId: 7, vault: "Main Vault" },
    });
  });

  test("tab_clip rejects an absent vault and names only the registry's known vaults", async () => {
    const { call, sent } = caller([zen], () => ({}), {
      knownObsidianVaults: async () => ["Main Vault", "Work"],
    });
    const result = await call("tab_clip", { tabId: 7, vault: "Guessed" });
    expect(result.isError).toBe(true);
    expect(payload(result)).toEqual({
      error: "bad-request",
      message:
        'Vault "Guessed" is not in Obsidian\'s local registry. Known vaults in that registry: "Main Vault", "Work". Use an exact name from Obsidian\'s vault switcher, or omit vault to use Tabglutton\'s configured destination.',
    });
    expect(sent).toEqual([]);
  });

  // The extension cannot see whether Obsidian took the handoff, so a dropped
  // clip used to read as success — and close: true would then close the tab
  // over a note that was never written. See clip-verify.ts.
  test("tab_clip reports a clip that never reached the vault, and leaves the tab open", async () => {
    const { call, sent } = caller([zen], () => ({ file: "Clippings/Note", vault: "test" }), {
      verifyClip: async () => "missing",
    });
    const result = await call("tab_clip", { tabId: 7, close: true });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ error: "not-enabled" });
    expect(JSON.stringify(payload(result))).toContain("never reached Obsidian");
    // Exactly one call, and it did not ask the extension to close anything.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: "tab_clip", params: { tabId: 7, close: false } });
  });

  test("tab_clip closes only after the note is confirmed, via tabs_close", async () => {
    const { call, sent } = caller(
      [zen],
      (s) =>
        s.method === "tab_clip"
          ? { file: "Clippings/Note", vault: "test" }
          : { closed: 1, batchId: "b7" },
      { verifyClip: async () => "landed" },
    );
    const result = await call("tab_clip", { tabId: 7, close: true });
    expect(result.isError).toBeUndefined();
    // The close is taken away from the extension and done here, after checking.
    expect(sent.map((s) => s.method)).toEqual(["tab_clip", "tabs_close"]);
    expect(sent[0]).toMatchObject({ params: { tabId: 7, close: false } });
    expect(sent[1]).toMatchObject({ params: { tabIds: [7] } });
    // batchId still comes from tabs_close, so undo_close reverses it as before.
    expect(payload(result)).toMatchObject({ closed: true, batchId: "b7", clipVerified: true });
  });

  test("tab_clip never claims a close tabs_close did not confirm", async () => {
    const { call } = caller(
      [zen],
      (s) =>
        s.method === "tab_clip"
          ? { file: "Clippings/Note", vault: "test" }
          : { closed: 0, skipped: [7] },
      { verifyClip: async () => "landed" },
    );
    const result = await call("tab_clip", { tabId: 7, close: true });
    expect(payload(result)).toMatchObject({ closed: false });
    expect(payload(result)).not.toHaveProperty("batchId");
  });

  // The note is on disk by the time the close is attempted, so a close that
  // fails is a partial success — reporting the whole call as an error invites a
  // re-clip, and Obsidian writes the duplicate.
  test("tab_clip keeps a verified clip when the close itself fails", async () => {
    const { call, sent } = caller(
      [zen],
      (s) => {
        if (s.method === "tab_clip") return { file: "Clippings/Note", vault: "test" };
        throw new BridgeRequestError("not-found", "None of the given tab ids exist.");
      },
      { verifyClip: async () => "landed" },
    );
    const result = await call("tab_clip", { tabId: 7, close: true });
    expect(result.isError).toBeUndefined();
    expect(payload(result)).toMatchObject({
      clipVerified: true,
      closed: false,
      closeSkipped: "None of the given tab ids exist.",
    });
    expect(sent.map((s) => s.method)).toEqual(["tab_clip", "tabs_close"]);
  });

  // The MCP transport does not enforce the advertised schema, and rewriting
  // `close` before validating it turned a malformed request into a silent
  // clip-only success.
  test("tab_clip rejects a non-boolean close instead of rewriting it", async () => {
    const { call, sent } = caller([zen], () => ({ file: "Clippings/Note", vault: "test" }), {
      verifyClip: async () => "landed",
    });
    const result = await call("tab_clip", { tabId: 7, close: "yes" });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ error: "bad-request" });
    expect(sent).toEqual([]);
  });

  // A note that exists but is not ours is a different story from nothing being
  // written, and the message has to tell the user which one they are in.
  test("tab_clip distinguishes a foreign note from a missing one", async () => {
    const { call, sent } = caller([zen], () => ({ file: "Clippings/Note", vault: "test" }), {
      verifyClip: async () => "mismatched",
    });
    const result = await call("tab_clip", { tabId: 7, close: true });
    expect(result.isError).toBe(true);
    const text = JSON.stringify(payload(result));
    expect(text).toContain("its text is not what was handed over");
    expect(text).not.toContain("never reached Obsidian");
    expect(sent).toHaveLength(1); // nothing closed
  });

  // The evidence the extension supplies has to reach the verifier, or the whole
  // attribution chain is silently freshness-only.
  test("tab_clip hands the verifier the clip's own url and content hash", async () => {
    let evidence: unknown;
    const { call } = caller(
      [zen],
      () => ({
        file: "Clippings/Note",
        vault: "test",
        url: "https://example.com/post",
        contentHash: "abc123",
      }),
      {
        verifyClip: async (_vault, _file, seen) => {
          evidence = seen;
          return "landed";
        },
      },
    );
    await call("tab_clip", { tabId: 7 });
    expect(evidence).toMatchObject({
      sourceUrl: "https://example.com/post",
      contentHash: "abc123",
    });
  });

  test("tab_clip without close reports whether the note was verified", async () => {
    const { call, sent } = caller([zen], () => ({ file: "Clippings/Note", vault: "test" }), {
      verifyClip: async () => "landed",
    });
    expect(payload(await call("tab_clip", { tabId: 7 }))).toMatchObject({ clipVerified: true });
    expect(sent.map((s) => s.method)).toEqual(["tab_clip"]);
  });

  // Same soft contract as the vault-override check: an unreadable registry must
  // never turn a real clip into a reported failure.
  test("tab_clip still closes when the vault cannot be checked", async () => {
    const { call, sent } = caller(
      [zen],
      (s) =>
        s.method === "tab_clip"
          ? { file: "Clippings/Note", vault: "test" }
          : { closed: 1, batchId: "b9" },
      { verifyClip: async () => "unknown" },
    );
    const result = await call("tab_clip", { tabId: 7, close: true });
    expect(result.isError).toBeUndefined();
    expect(payload(result)).toMatchObject({ closed: true, batchId: "b9", clipVerified: false });
    expect(sent.map((s) => s.method)).toEqual(["tab_clip", "tabs_close"]);
  });

  test("tab_clip leaves the extension to close when no verifier is configured", async () => {
    const { call, sent } = caller([zen], () => ({ file: "Clippings/Note", vault: "test" }));
    await call("tab_clip", { tabId: 7, close: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: "tab_clip", params: { tabId: 7, close: true } });
  });

  test("tab_clip forwards when the registry cannot be checked", async () => {
    const lookups: (ObsidianVaultLookup | undefined)[] = [
      undefined,
      async () => null,
      async () => Promise.reject(new Error("permission denied")),
    ];
    for (const knownObsidianVaults of lookups) {
      const { call, sent } = caller([zen], () => ({ file: "Clippings/example.md" }), {
        knownObsidianVaults,
      });
      expect((await call("tab_clip", { tabId: 7, vault: "Unverified" })).isError).toBeUndefined();
      expect(sent).toHaveLength(1);
    }
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

describe("no-connection diagnosis", () => {
  // The pair of facts that produced this: the browser's badge said connected on
  // 20317 while every tool call here said nothing was attached.
  test("names the rival sidecar and points at the token", async () => {
    const { call } = caller([], () => ({}), { rivalHubs: async () => [4589] });
    const result = await call("tabs_list", {});
    expect(result.isError).toBe(true);
    const { message } = payload(result) as { message: string };
    expect(message).toContain("127.0.0.1:4589");
    expect(message).toContain("TABGLUTTON_TOKEN");
  });

  test("stays quiet when this really is the only sidecar", async () => {
    const { call } = caller([], () => ({}), { rivalHubs: async () => [] });
    const { message } = payload(await call("tabs_list", {})) as { message: string };
    expect(message).not.toContain("127.0.0.1");
  });

  // The diagnosis is a courtesy on a path that has already failed; it must never
  // replace the real error with a failure of its own.
  test("survives a probe that throws", async () => {
    const { call } = caller([], () => ({}), {
      rivalHubs: () => Promise.reject(new Error("loopback refused")),
    });
    const result = await call("tabs_list", {});
    expect(payload(result)).toMatchObject({ error: "no-connection" });
    expect((payload(result) as { message: string }).message).not.toContain("loopback refused");
  });

  test("leaves every other failure untouched", async () => {
    const { call } = caller([zen], () => {
      throw new BridgeRequestError("timeout", "tabs_list timed out.");
    });
    const probed = caller([zen], () => ({}), { rivalHubs: async () => [4589] });
    expect(payload(await call("tabs_list", {}))).toMatchObject({ error: "timeout" });
    // A healthy browser never consults the diagnosis at all.
    expect(payload(await probed.call("tabs_list", {}))).not.toHaveProperty("error");
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
    // Chrome is still a connected target even though its request failed, so the
    // surviving tab needs an origin for the follow-up tab-scoped call. This tab
    // also has no url — a malformed entry renders empty rather than throwing
    // away the listing around it.
    expect(result.tabs).toEqual([
      { id: 1, title: "kept", url: "", connectionId: zen.connectionId },
    ]);
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
