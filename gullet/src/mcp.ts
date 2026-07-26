// A minimal MCP server over stdio: newline-delimited JSON-RPC 2.0 on
// stdin/stdout, implementing just the tools half of the spec.
//
// Hand-rolled rather than pulling in the reference SDK — a tools-only server is
// five methods, and this keeps the sidecar dependency-free so `bun run
// gullet/gullet.ts` works with nothing installed.
//
// stdout is the transport. Every diagnostic in this package goes to stderr; a
// stray console.log would corrupt the stream and break the session.

import { asRecord as asRecordOrNull } from "../../src/bridge-protocol.js";

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

/** Pump stdin through the handler and write replies to stdout. */
export async function serveStdio(options: McpServerOptions): Promise<void> {
  const handle = createRpcHandler(options);
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line) await dispatch(handle, line);
    }
  }
}

async function dispatch(
  handle: (msg: unknown) => Promise<JsonRpcResponse | null>,
  line: string,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    console.error("[gullet] ignoring unparseable stdin line");
    return;
  }
  try {
    const response = await handle(parsed);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch (err) {
    console.error("[gullet] rpc handler threw", err);
  }
}
