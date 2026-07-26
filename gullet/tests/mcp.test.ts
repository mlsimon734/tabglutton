import { describe, test, expect } from "bun:test";
import {
  createRpcHandler,
  MCP_LATEST_PROTOCOL,
  negotiateProtocol,
  type McpServerOptions,
  type McpToolResult,
} from "../src/mcp.js";

function server(
  call: McpServerOptions["call"] = async () => ({ content: [{ type: "text", text: "{}" }] }),
): McpServerOptions {
  return {
    name: "gullet",
    version: "0.1.0",
    instructions: "how to use me",
    tools: [
      {
        name: "tabs_list",
        title: "List open tabs",
        description: "…",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
      },
    ],
    call,
  };
}

describe("negotiateProtocol()", () => {
  test("echoes a version we support", () => {
    expect(negotiateProtocol("2024-11-05")).toBe("2024-11-05");
  });

  test("falls back to the latest for an unknown or absent version", () => {
    expect(negotiateProtocol("2099-01-01")).toBe(MCP_LATEST_PROTOCOL);
    expect(negotiateProtocol(undefined)).toBe(MCP_LATEST_PROTOCOL);
    expect(negotiateProtocol(7)).toBe(MCP_LATEST_PROTOCOL);
  });
});

describe("initialize", () => {
  test("advertises the tools capability, server info, and instructions", async () => {
    const handle = createRpcHandler(server());
    const res = await handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });
    expect(res?.result).toEqual({
      protocolVersion: "2025-03-26",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "gullet", version: "0.1.0" },
      instructions: "how to use me",
    });
  });
});

describe("notifications", () => {
  test("initialized gets no reply, per JSON-RPC", async () => {
    const handle = createRpcHandler(server());
    expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });

  test("an unknown notification is ignored rather than erroring", async () => {
    const handle = createRpcHandler(server());
    expect(await handle({ jsonrpc: "2.0", method: "notifications/progress" })).toBeNull();
  });
});

describe("tools/list", () => {
  test("returns the tool definitions verbatim", async () => {
    const options = server();
    const handle = createRpcHandler(options);
    const res = await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(res?.result).toEqual({ tools: options.tools });
  });
});

describe("tools/call", () => {
  test("passes name and arguments through to the caller", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const handle = createRpcHandler(
      server(async (name, args): Promise<McpToolResult> => {
        calls.push([name, args]);
        return { content: [{ type: "text", text: "ok" }] };
      }),
    );
    const res = await handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "tabs_list", arguments: { scope: "all" } },
    });
    expect(calls).toEqual([["tabs_list", { scope: "all" }]]);
    expect(res?.result).toEqual({ content: [{ type: "text", text: "ok" }] });
  });

  test("defaults missing arguments to an empty object", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const handle = createRpcHandler(
      server(async (_name, args) => {
        calls.push(args);
        return { content: [{ type: "text", text: "ok" }] };
      }),
    );
    await handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "tabs_list" } });
    expect(calls).toEqual([{}]);
  });

  test("rejects a call with no tool name", async () => {
    const handle = createRpcHandler(server());
    const res = await handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: {} });
    expect(res?.error?.code).toBe(-32602);
  });

  test("a failing tool comes back as a result, not a transport error", async () => {
    const handle = createRpcHandler(
      server(async () => ({ content: [{ type: "text", text: "boom" }], isError: true })),
    );
    const res = await handle({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "tabs_list" },
    });
    expect(res?.error).toBeUndefined();
    expect(res?.result).toMatchObject({ isError: true });
  });
});

describe("protocol plumbing", () => {
  test("ping answers with an empty result", async () => {
    const handle = createRpcHandler(server());
    expect((await handle({ jsonrpc: "2.0", id: 7, method: "ping" }))?.result).toEqual({});
  });

  test("an unknown request method is method-not-found", async () => {
    const handle = createRpcHandler(server());
    const res = await handle({ jsonrpc: "2.0", id: 8, method: "resources/list" });
    expect(res?.error?.code).toBe(-32601);
  });

  test("a message with no method is an invalid request", async () => {
    const handle = createRpcHandler(server());
    expect((await handle({ jsonrpc: "2.0", id: 9 }))?.error?.code).toBe(-32600);
  });

  test("responses carry the request id back", async () => {
    const handle = createRpcHandler(server());
    expect((await handle({ jsonrpc: "2.0", id: "abc", method: "ping" }))?.id).toBe("abc");
  });
});
