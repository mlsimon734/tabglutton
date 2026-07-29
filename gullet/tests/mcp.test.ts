import { describe, test, expect } from "bun:test";
import {
  createRpcHandler,
  MCP_LATEST_PROTOCOL,
  negotiateProtocol,
  serveStdio,
  type McpServerOptions,
  type McpToolResult,
  type McpTransport,
} from "../src/mcp.js";

/**
 * A transport whose input the test feeds by hand, so a request can be sent while
 * an earlier one is still running.
 */
function fakeTransport(): {
  transport: McpTransport;
  send: (msg: unknown) => void;
  sendRaw: (text: string) => void;
  end: () => void;
  lines: string[];
  writeStarted: number;
  concurrentWrites: number;
} {
  const encoder = new TextEncoder();
  const queue: Uint8Array[] = [];
  let notify: (() => void) | null = null;
  let done = false;
  const state = { lines: [] as string[], writeStarted: 0, concurrentWrites: 0 };
  let openWrites = 0;

  const input = (async function* (): AsyncGenerator<Uint8Array> {
    for (;;) {
      while (queue.length > 0) yield queue.shift() as Uint8Array;
      if (done) return;
      await new Promise<void>((resolve) => (notify = resolve));
    }
  })();

  const wake = (): void => {
    const resume = notify;
    notify = null;
    resume?.();
  };

  return {
    transport: {
      input,
      write: async (line) => {
        state.writeStarted += 1;
        openWrites += 1;
        state.concurrentWrites = Math.max(state.concurrentWrites, openWrites);
        // A real pipe write is async; this is where an interleave would show up.
        await new Promise((r) => setTimeout(r, 1));
        state.lines.push(line);
        openWrites -= 1;
      },
    },
    send: (msg) => {
      queue.push(encoder.encode(`${JSON.stringify(msg)}\n`));
      wake();
    },
    sendRaw: (text) => {
      queue.push(encoder.encode(text));
      wake();
    },
    end: () => {
      done = true;
      wake();
    },
    get lines() {
      return state.lines;
    },
    get writeStarted() {
      return state.writeStarted;
    },
    get concurrentWrites() {
      return state.concurrentWrites;
    },
  };
}

function parseLines(lines: string[]): Array<Record<string, unknown>> {
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}

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

describe("serveStdio()", () => {
  test("a slow tool call does not block the rest of the session", async () => {
    // The bug this replaces: `await dispatch(...)` per line froze the pump for
    // the whole call, so a ping issued during a 35s connect-wait went unanswered
    // and the client concluded the server was dead.
    let releaseCall!: () => void;
    const inCall = new Promise<void>((r) => (releaseCall = r));
    const t = fakeTransport();

    const pump = serveStdio(
      server(async () => {
        await inCall;
        return { content: [{ type: "text", text: "slow" }] };
      }),
      t.transport,
    );

    t.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tabs_list" } });
    t.send({ jsonrpc: "2.0", id: 2, method: "ping" });

    // The ping answers while the tool call is still in flight.
    await Bun.sleep(20);
    expect(parseLines(t.lines).map((m) => m.id)).toEqual([2]);

    releaseCall();
    t.end();
    await pump;
    expect(parseLines(t.lines).map((m) => m.id)).toEqual([2, 1]);
  });

  test("serializes writes, so two replies landing at once cannot interleave", async () => {
    const t = fakeTransport();
    const pump = serveStdio(server(), t.transport);
    for (let id = 1; id <= 5; id++) t.send({ jsonrpc: "2.0", id, method: "ping" });
    t.end();
    await pump;
    expect(t.writeStarted).toBe(5);
    // The guarantee is ours, not the runtime's: never two writes open at once.
    expect(t.concurrentWrites).toBe(1);
    expect(t.lines.every((l) => l.endsWith("\n"))).toBe(true);
  });

  test("drains in-flight work before returning, so replies are not truncated", async () => {
    const t = fakeTransport();
    const pump = serveStdio(
      server(async () => {
        await Bun.sleep(15);
        return { content: [{ type: "text", text: "late" }] };
      }),
      t.transport,
    );
    t.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tabs_list" } });
    await Bun.sleep(1);
    t.end(); // client closed stdin while the call was still running
    await pump;
    expect(parseLines(t.lines).map((m) => m.id)).toEqual([1]);
  });

  test("a handler that throws answers the id instead of leaving it hanging", async () => {
    const t = fakeTransport();
    // `call` is what createToolCaller normally guards; a raw throw here stands
    // in for a bug that gets past it.
    const pump = serveStdio(
      server(() => {
        throw new Error("handler bug");
      }),
      t.transport,
    );
    t.send({ jsonrpc: "2.0", id: 42, method: "tools/call", params: { name: "tabs_list" } });
    t.end();
    await pump;
    const [reply] = parseLines(t.lines);
    expect(reply).toMatchObject({ id: 42, error: { code: -32603 } });
  });

  test("a notification that throws stays silent, per JSON-RPC", async () => {
    const t = fakeTransport();
    const pump = serveStdio(
      server(() => {
        throw new Error("handler bug");
      }),
      t.transport,
    );
    t.send({ jsonrpc: "2.0", method: "tools/call", params: { name: "tabs_list" } });
    t.end();
    await pump;
    expect(t.lines).toEqual([]);
  });

  test("skips blank and unparseable lines without dropping the ones around them", async () => {
    const t = fakeTransport();
    const pump = serveStdio(server(), t.transport);
    t.send({ jsonrpc: "2.0", id: 1, method: "ping" });
    t.sendRaw("\n");
    t.sendRaw("{ not json\n");
    t.send({ jsonrpc: "2.0", id: 2, method: "ping" });
    t.end();
    await pump;
    expect(parseLines(t.lines).map((m) => m.id)).toEqual([1, 2]);
  });

  test("reassembles a message split across chunks", async () => {
    const t = fakeTransport();
    const pump = serveStdio(server(), t.transport);
    t.sendRaw('{"jsonrpc":"2.0","id":1,');
    t.sendRaw('"method":"ping"}\n');
    t.end();
    await pump;
    expect(parseLines(t.lines).map((m) => m.id)).toEqual([1]);
  });
});

describe("serveStdio() write failures", () => {
  test("a broken pipe is logged, not thrown, and the pump still drains", async () => {
    const t = fakeTransport();
    const broken: McpTransport = {
      input: t.transport.input,
      write: () => Promise.reject(new Error("EPIPE")),
    };
    const pump = serveStdio(server(), broken);
    t.send({ jsonrpc: "2.0", id: 1, method: "ping" });
    t.send({ jsonrpc: "2.0", id: 2, method: "ping" });
    t.end();
    // The bug this guards: the rejection escaping dispatch and taking the
    // process down as an unhandled rejection.
    await pump;
  });
});
