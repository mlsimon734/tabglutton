import { describe, test, expect } from "bun:test";
import {
  BRIDGE_PROTO,
  BridgeRequestError,
  DEFAULT_BRIDGE_PORT,
  deriveProof,
  generateToken,
  isBridgeMethod,
  parseMessage,
  parseTabClipParams,
  parseTabReadParams,
  parseTabsCloseParams,
  parseTabsListParams,
  parseUndoCloseParams,
  proofsMatch,
  randomNonce,
} from "../src/bridge-protocol.js";

describe("constants", () => {
  test("port and proto are the documented values", () => {
    expect(DEFAULT_BRIDGE_PORT).toBe(4588);
    expect(BRIDGE_PROTO).toBe(1);
  });
});

describe("deriveProof()", () => {
  test("is deterministic for the same token and nonce", async () => {
    expect(await deriveProof("tok", "nonce")).toBe(await deriveProof("tok", "nonce"));
  });

  test("is a 64-char hex sha-256 digest", async () => {
    expect(await deriveProof("tok", "nonce")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("differs when the token differs", async () => {
    expect(await deriveProof("a", "n")).not.toBe(await deriveProof("b", "n"));
  });

  test("differs when the nonce differs — a replayed proof is useless", async () => {
    expect(await deriveProof("tok", "n1")).not.toBe(await deriveProof("tok", "n2"));
  });

  test("token and nonce are not confusable across the separator", async () => {
    expect(await deriveProof("a:b", "c")).not.toBe(await deriveProof("a", "b:c"));
  });
});

describe("proofsMatch()", () => {
  test("accepts identical strings", () => {
    expect(proofsMatch("abc", "abc")).toBe(true);
  });

  test("rejects differing strings of equal length", () => {
    expect(proofsMatch("abc", "abd")).toBe(false);
  });

  test("rejects differing lengths", () => {
    expect(proofsMatch("abc", "abcd")).toBe(false);
  });

  test("rejects empty against non-empty", () => {
    expect(proofsMatch("", "a")).toBe(false);
  });
});

describe("token and nonce generation", () => {
  test("tokens are 48 hex chars and unique", () => {
    const a = generateToken();
    expect(a).toMatch(/^[0-9a-f]{48}$/);
    expect(a).not.toBe(generateToken());
  });

  test("nonces are 32 hex chars and unique", () => {
    const a = randomNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(randomNonce());
  });
});

describe("isBridgeMethod()", () => {
  test("accepts the five v1 methods", () => {
    for (const m of ["tabs_list", "tab_read", "tab_clip", "tabs_close", "undo_close"]) {
      expect(isBridgeMethod(m)).toBe(true);
    }
  });

  test("rejects tools the trust boundary excludes", () => {
    for (const m of ["tab_load", "navigate", "click", "evaluate", ""]) {
      expect(isBridgeMethod(m)).toBe(false);
    }
  });

  test("rejects non-strings", () => {
    expect(isBridgeMethod(null)).toBe(false);
    expect(isBridgeMethod(42)).toBe(false);
  });
});

describe("parseMessage()", () => {
  test("returns a typed message for a known envelope", () => {
    expect(parseMessage('{"type":"ping","t":1}')).toEqual({ type: "ping", t: 1 });
  });

  test("returns null on malformed JSON", () => {
    expect(parseMessage("{not json")).toBeNull();
  });

  test("returns null for an unknown type", () => {
    expect(parseMessage('{"type":"navigate","url":"http://x"}')).toBeNull();
  });

  test("returns null for non-objects and arrays", () => {
    expect(parseMessage('"hello"')).toBeNull();
    expect(parseMessage("[1,2]")).toBeNull();
    expect(parseMessage("null")).toBeNull();
  });
});

describe("parseTabsListParams()", () => {
  test("defaults to every window, hidden included", () => {
    expect(parseTabsListParams(undefined)).toEqual({ scope: "all", includeHidden: true });
  });

  test("accepts the documented values", () => {
    expect(parseTabsListParams({ scope: "current-window", includeHidden: false })).toEqual({
      scope: "current-window",
      includeHidden: false,
    });
  });

  test("rejects an unknown scope", () => {
    expect(() => parseTabsListParams({ scope: "everything" })).toThrow(BridgeRequestError);
  });

  test("rejects a non-boolean includeHidden", () => {
    expect(() => parseTabsListParams({ includeHidden: "yes" })).toThrow(BridgeRequestError);
  });
});

describe("parseTabReadParams()", () => {
  test("accepts an integer tabId", () => {
    expect(parseTabReadParams({ tabId: 7 })).toEqual({ tabId: 7 });
  });

  test("rejects a missing, fractional, or string tabId", () => {
    expect(() => parseTabReadParams({})).toThrow(BridgeRequestError);
    expect(() => parseTabReadParams({ tabId: 1.5 })).toThrow(BridgeRequestError);
    expect(() => parseTabReadParams({ tabId: "7" })).toThrow(BridgeRequestError);
  });

  test("reports bad-request so the agent can correct itself", () => {
    try {
      parseTabReadParams({});
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as BridgeRequestError).code).toBe("bad-request");
    }
  });
});

describe("parseTabClipParams()", () => {
  test("defaults close to false — closing stays an explicit act", () => {
    expect(parseTabClipParams({ tabId: 3 })).toEqual({ tabId: 3, close: false });
  });

  test("honours close: true", () => {
    expect(parseTabClipParams({ tabId: 3, close: true })).toEqual({ tabId: 3, close: true });
  });

  test("rejects a non-boolean close", () => {
    expect(() => parseTabClipParams({ tabId: 3, close: 1 })).toThrow(BridgeRequestError);
  });
});

describe("parseTabsCloseParams()", () => {
  test("accepts an array of integers", () => {
    expect(parseTabsCloseParams({ tabIds: [1, 2] })).toEqual({ tabIds: [1, 2] });
  });

  test("rejects an empty array rather than closing nothing silently", () => {
    expect(() => parseTabsCloseParams({ tabIds: [] })).toThrow(BridgeRequestError);
  });

  test("deduplicates repeated ids — one tab, one close, one undo entry", () => {
    expect(parseTabsCloseParams({ tabIds: [1, 2, 1, 2, 1] })).toEqual({ tabIds: [1, 2] });
  });

  test("rejects non-array and non-integer members", () => {
    expect(() => parseTabsCloseParams({ tabIds: 5 })).toThrow(BridgeRequestError);
    expect(() => parseTabsCloseParams({ tabIds: [1, "2"] })).toThrow(BridgeRequestError);
  });
});

describe("parseUndoCloseParams()", () => {
  test("an absent batchId means the most recent batch", () => {
    expect(parseUndoCloseParams({})).toEqual({});
    expect(parseUndoCloseParams(undefined)).toEqual({});
  });

  test("accepts a string batchId", () => {
    expect(parseUndoCloseParams({ batchId: "b1" })).toEqual({ batchId: "b1" });
  });

  test("rejects a non-string batchId", () => {
    expect(() => parseUndoCloseParams({ batchId: 1 })).toThrow(BridgeRequestError);
  });
});

describe("BridgeRequestError", () => {
  test("converts to the wire error shape", () => {
    const err = new BridgeRequestError("tab-discarded", "unloaded");
    expect(err.toBridgeError()).toEqual({ code: "tab-discarded", message: "unloaded" });
  });
});
