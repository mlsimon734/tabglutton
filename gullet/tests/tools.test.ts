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
    connections: () => connections,
    request: async (connectionId, method, params) => {
      const entry = { connectionId, method, params };
      sent.push(entry);
      return respond(entry);
    },
    startupError: null,
    ...overrides,
  });
  return { call, sent };
}

function payload(result: { content: Array<{ type: "text"; text: string }> }): unknown {
  return JSON.parse(result.content[0]?.text ?? "null");
}

describe("tool definitions", () => {
  test("exposes exactly the five v1 tools", () => {
    expect(GULLET_TOOLS.map((t) => t.name)).toEqual([
      "tabs_list",
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
  });

  test("every schema is a closed object, so bad arguments surface at the client", () => {
    for (const tool of GULLET_TOOLS) {
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    }
  });
});

describe("tabs_list", () => {
  test("fans out over every browser and tags each tab with its origin", async () => {
    const { call } = caller([zen, chrome], ({ connectionId }) => ({
      tabs: [{ id: connectionId === "conn-1" ? 1 : 2 }],
    }));
    const result = await call("tabs_list", {});
    expect(payload(result)).toEqual({
      browsers: [zen, chrome],
      tabs: [
        { id: 1, browser: "Zen", connectionId: "conn-1" },
        { id: 2, browser: "Chrome", connectionId: "conn-2" },
      ],
    });
  });

  test("narrows to the named browser", async () => {
    const { call, sent } = caller([zen, chrome], () => ({ tabs: [] }));
    await call("tabs_list", { browser: "Chrome" });
    expect(sent.map((s) => s.connectionId)).toEqual(["conn-2"]);
  });

  test("forwards its own params but not the routing field", async () => {
    const { call, sent } = caller([zen], () => ({ tabs: [] }));
    await call("tabs_list", { browser: "Zen", scope: "current-window", includeHidden: false });
    expect(sent[0]?.params).toEqual({ scope: "current-window", includeHidden: false });
  });

  test("tolerates a browser that returns no tabs field", async () => {
    const { call } = caller([zen], () => ({}));
    expect(payload(await call("tabs_list", {}))).toMatchObject({ tabs: [] });
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
    const result = await call("tab_load", { tabId: 1 });
    expect(payload(result)).toMatchObject({ error: "bad-request" });
    expect(sent).toEqual([]);
  });

  test("a missing token is explained instead of failing to connect silently", async () => {
    const { call, sent } = caller([zen], () => ({}), {
      startupError: { code: "unauthorized", message: "no token" },
    });
    const result = await call("tabs_list", {});
    expect(payload(result)).toMatchObject({ error: "unauthorized" });
    expect(sent).toEqual([]);
  });

  // The port-conflict case, which used to exit before the MCP handshake and so
  // could only be reported by the client as "connection closed".
  test("a startup fault answers every tool rather than killing the session", async () => {
    const { call, sent } = caller([zen], () => ({}), {
      startupError: { code: "unsupported", message: "Another process is already listening" },
    });
    for (const tool of GULLET_TOOLS) {
      const result = await call(tool.name, {});
      expect(result.isError).toBe(true);
      expect(payload(result)).toMatchObject({ error: "unsupported" });
    }
    expect(sent).toEqual([]);
  });
});
