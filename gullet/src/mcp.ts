// A minimal MCP server over stdio: newline-delimited JSON-RPC 2.0 on
// stdin/stdout, implementing just the tools half of the spec.
//
// Hand-rolled rather than pulling in the reference SDK — a tools-only server is
// five methods, and this keeps the sidecar dependency-free so `bun run
// gullet/gullet.ts` works with nothing installed.
//
// stdout is the transport. Every diagnostic in this package goes to stderr; a
// stray console.log would corrupt the stream and break the session.

import { asRecord as asRecordOrNull, errorMessage } from "../../src/bridge-protocol.js";

export const MCP_LATEST_PROTOCOL = "2025-06-18";
const MCP_SUPPORTED_PROTOCOLS = [MCP_LATEST_PROTOCOL, "2025-03-26", "2024-11-05"];

export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface McpServerOptions {
  name: string;
  version: string;
  instructions?: string;
  tools: readonly McpTool[];
  call: (name: string, args: Record<string, unknown>) => Promise<McpToolResult>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INVALID_REQUEST = -32600;
const INTERNAL_ERROR = -32603;

export function negotiateProtocol(requested: unknown): string {
  return typeof requested === "string" && MCP_SUPPORTED_PROTOCOLS.includes(requested)
    ? requested
    : MCP_LATEST_PROTOCOL;
}

/** A missing or non-object member is an empty bag here — every read is optional. */
function asRecord(value: unknown): Record<string, unknown> {
  return asRecordOrNull(value) ?? {};
}

/**
 * Handle one JSON-RPC message. Returns null for notifications, which by spec
 * get no reply.
 */
export function createRpcHandler(
  options: McpServerOptions,
): (msg: unknown) => Promise<JsonRpcResponse | null> {
  return async (msg: unknown): Promise<JsonRpcResponse | null> => {
    const req = asRecord(msg);
    const method = req.method;
    if (typeof method !== "string") {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: INVALID_REQUEST, message: "Missing method." },
      };
    }
    const id = (req.id as JsonRpcResponse["id"]) ?? null;
    const isNotification = req.id === undefined;

    switch (method) {
      case "initialize":
        return reply(id, {
          protocolVersion: negotiateProtocol(asRecord(req.params).protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: options.name, version: options.version },
          ...(options.instructions ? { instructions: options.instructions } : {}),
        });
      case "notifications/initialized":
      case "notifications/cancelled":
        return null;
      case "ping":
        return reply(id, {});
      case "tools/list":
        return reply(id, { tools: options.tools });
      case "tools/call": {
        const params = asRecord(req.params);
        const name = params.name;
        if (typeof name !== "string") {
          return errorReply(id, INVALID_PARAMS, "tools/call requires a string `name`.");
        }
        // Tool failures are results, not transport errors: the model needs to
        // read them and adapt, not have the call vanish.
        const result = await options.call(name, asRecord(params.arguments));
        return reply(id, result);
      }
      default:
        if (isNotification) return null;
        return errorReply(id, METHOD_NOT_FOUND, `Unknown method ${method}.`);
    }
  };
}

function reply(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function errorReply(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** The two ends of the stdio transport, injected so the pump can be tested. */
export interface McpTransport {
  input: AsyncIterable<Uint8Array>;
  /** Resolves once the line has been handed to the OS. Never called twice at once. */
  write: (line: string) => Promise<void>;
}

/**
 * Pump the transport through the handler.
 *
 * Requests are dispatched **concurrently**: awaiting each one before reading the
 * next line freezes the whole session for the duration of every call, and these
 * calls are long by nature — a tool call waits up to BRIDGE_CONNECT_WAIT_MS for a
 * browser to dial in, and `tabs_load` runs a 30s batch. What gets frozen is not
 * just the next tool call but `ping` and `notifications/cancelled` too, so a
 * cancellation cannot arrive during the only work it could ever cancel, and a
 * client that pings on a short interval concludes the server is dead.
 *
 * Out-of-order replies are fine — JSON-RPC matches on `id` — but interleaved
 * *bytes* are not, and a `tabs_list` frame for a few hundred tabs is far past
 * any pipe's atomic-write size. Node's Writable does queue chunks in call order,
 * which would make that safe on its own, but this is Bun's implementation over a
 * pipe and this area has already cost us days on an assumed platform behaviour
 * (see the CSP and reconnect-delay notes in AGENTS.md). So writes are serialized
 * explicitly and the ordering guarantee is ours, not the runtime's.
 */
export async function serveStdio(
  options: McpServerOptions,
  transport: McpTransport = stdioTransport(),
): Promise<void> {
  const handle = createRpcHandler(options);
  const decoder = new TextDecoder();
  const inFlight = new Set<Promise<void>>();
  let writes: Promise<unknown> = Promise.resolve();
  let buffer = "";

  const send = (line: string): Promise<void> => {
    const next = writes.then(() => transport.write(line));
    writes = next.catch((err) => console.error("[gullet] stdout write failed", err));
    return next;
  };

  const start = (line: string): void => {
    // Caught here, not left to `allSettled`: a write that fails rejects as soon
    // as the pipe says so, which is usually long before stdin closes, and an
    // uncaught rejection in between is a crash we would take for a broken pipe.
    // `send` has already logged it by then.
    const task = dispatch(handle, line, send)
      .catch(() => {})
      .finally(() => inFlight.delete(task));
    inFlight.add(task);
  };

  for await (const chunk of transport.input) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line) start(line);
    }
  }

  // stdin closed. Let whatever is mid-flight answer and drain before the caller
  // tears the backend down — the harness may still be reading our replies.
  // Safe to iterate live: tasks remove themselves in a microtask, and
  // `allSettled` collects the set synchronously.
  await Promise.allSettled(inFlight);
  await writes.catch(() => {});
}

function stdioTransport(): McpTransport {
  return {
    input: Bun.stdin.stream() as AsyncIterable<Uint8Array>,
    // Callback form, not the boolean return: over a pipe `write` reports
    // backpressure by returning false while still completing, so the callback is
    // the only signal that says "this chunk is gone" (verified on Bun).
    write: (line) =>
      new Promise((resolve, reject) => {
        process.stdout.write(line, (err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function dispatch(
  handle: (msg: unknown) => Promise<JsonRpcResponse | null>,
  line: string,
  send: (line: string) => Promise<void>,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    console.error("[gullet] ignoring unparseable stdin line");
    return;
  }
  let response: JsonRpcResponse | null;
  try {
    response = await handle(parsed);
  } catch (err) {
    console.error("[gullet] rpc handler threw", err);
    // A request that got no reply at all leaves the client waiting on that id
    // for the rest of the session. `createToolCaller` already turns tool
    // failures into results, so reaching here means a bug — but the client
    // should hear about it rather than hang on it.
    const id = asRecord(parsed).id;
    if (id === undefined) return;
    response = errorReply(
      (id as JsonRpcResponse["id"]) ?? null,
      INTERNAL_ERROR,
      `Gullet failed to handle the request: ${errorMessage(err)}`,
    );
  }
  if (response) await send(`${JSON.stringify(response)}\n`);
}
