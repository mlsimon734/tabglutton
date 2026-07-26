import { describe, test, expect } from "bun:test";
import { BridgeRequestError } from "../../src/bridge-protocol.js";
import { selectAll, selectOne, type ConnectionSummary } from "../src/select.js";

const zen: ConnectionSummary = {
  connectionId: "conn-1",
  browser: "firefox",
  label: "Zen",
  extVersion: "0.1.2.1",
};
const chrome: ConnectionSummary = {
  connectionId: "conn-2",
  browser: "chrome",
  label: "Chrome",
  extVersion: "0.1.2.1",
};

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as BridgeRequestError).code;
  }
  throw new Error("expected a throw");
}

describe("selectAll()", () => {
  test("returns every connection when no target is named", () => {
    expect(selectAll([zen, chrome])).toEqual([zen, chrome]);
  });

  test("matches on label, browser id, and connectionId, case-insensitively", () => {
    expect(selectAll([zen, chrome], "zen")).toEqual([zen]);
    expect(selectAll([zen, chrome], "chrome")).toEqual([chrome]);
    expect(selectAll([zen, chrome], "CONN-1")).toEqual([zen]);
  });

  test("ignores surrounding whitespace in the target", () => {
    expect(selectAll([zen, chrome], "  Zen ")).toEqual([zen]);
  });

  test("reports no-connection when nothing is dialled in", () => {
    expect(codeOf(() => selectAll([]))).toBe("no-connection");
  });

  test("reports not-found, listing what is connected", () => {
    expect(codeOf(() => selectAll([zen], "safari"))).toBe("not-found");
    expect(() => selectAll([zen], "safari")).toThrow(/conn-1 \(Zen\)/);
  });

  test("does not hand back the caller's array", () => {
    const summaries = [zen];
    expect(selectAll(summaries)).not.toBe(summaries);
  });
});

describe("selectOne()", () => {
  test("uses the only connection when just one is dialled in", () => {
    expect(selectOne([zen])).toEqual(zen);
  });

  test("refuses to guess between two browsers — tab ids are per-browser", () => {
    expect(codeOf(() => selectOne([zen, chrome]))).toBe("ambiguous-target");
  });

  test("resolves the ambiguity when a target is given", () => {
    expect(selectOne([zen, chrome], "Chrome")).toEqual(chrome);
  });

  test("still reports ambiguity when a target matches two connections", () => {
    const second: ConnectionSummary = { ...zen, connectionId: "conn-3" };
    expect(codeOf(() => selectOne([zen, second], "firefox"))).toBe("ambiguous-target");
  });

  test("reports no-connection on an empty registry", () => {
    expect(codeOf(() => selectOne([]))).toBe("no-connection");
  });
});
