import { describe, expect, test } from "bun:test";

import {
  agoLabel,
  BridgeErrorLog,
  renderDiagnostics,
  type DiagnosticsBackgroundFacts,
  type DiagnosticsFacts,
} from "../src/diagnostics.js";

const T0 = 1_700_000_000_000;

function backgroundFacts(
  over: Partial<DiagnosticsBackgroundFacts> = {},
): DiagnosticsBackgroundFacts {
  return {
    engine: "Firefox 134.0.2",
    platform: "mac arm64",
    tabsInScope: 412,
    tabsTotal: 1207,
    duplicates: 37,
    windows: 3,
    scope: "hidden-false",
    clipDestination: "obsidian",
    zoteroRouting: false,
    bridge: {
      enabled: true,
      hasToken: true,
      portMode: "auto",
      fixedPort: 4589,
      status: "connected",
      connectedPort: 4589,
      allowTabLoad: false,
      errors: [],
    },
    ...over,
  };
}

function facts(over: Partial<DiagnosticsFacts> = {}): DiagnosticsFacts {
  return {
    version: "0.4.0",
    target: "firefox",
    grants: { sites: "held", loopback: "held", downloads: "missing" },
    background: backgroundFacts(),
    ...over,
  };
}

describe("BridgeErrorLog", () => {
  test("keeps entries oldest first", () => {
    const log = new BridgeErrorLog();
    log.record("dial-timeout", "4589", T0);
    log.record("heartbeat-lost", "4589", T0 + 1_000);

    expect(log.list()).toEqual([
      { at: T0, kind: "dial-timeout", subject: "4589", count: 1 },
      { at: T0 + 1_000, kind: "heartbeat-lost", subject: "4589", count: 1 },
    ]);
  });

  test("drops the oldest entry once the capacity is reached", () => {
    const log = new BridgeErrorLog(3);
    // Distinct subjects so nothing coalesces and every record takes a slot.
    for (let i = 0; i < 5; i += 1) log.record("dial-failed", String(4589 + i), T0 + i);

    expect(log.list().map((entry) => entry.subject)).toEqual(["4591", "4592", "4593"]);
  });

  test("collapses consecutive identical failures into a count", () => {
    const log = new BridgeErrorLog();
    log.record("dial-timeout", "4589", T0);
    log.record("dial-timeout", "4589", T0 + 30_000);
    log.record("dial-timeout", "4589", T0 + 60_000);

    // One slot, the newest timestamp — the reconnect loop this exists to catch
    // would otherwise fill every slot with the same line inside five minutes.
    expect(log.list()).toEqual([
      { at: T0 + 60_000, kind: "dial-timeout", subject: "4589", count: 3 },
    ]);
  });

  test("does not collapse across a different failure", () => {
    const log = new BridgeErrorLog();
    log.record("dial-timeout", "4589", T0);
    log.record("auth-failed", "4589", T0 + 1);
    log.record("dial-timeout", "4589", T0 + 2);

    expect(log.list().map((entry) => [entry.kind, entry.count])).toEqual([
      ["dial-timeout", 1],
      ["auth-failed", 1],
      ["dial-timeout", 1],
    ]);
  });

  test("distinguishes the same failure on different ports", () => {
    const log = new BridgeErrorLog();
    log.record("dial-failed", "4589", T0);
    log.record("dial-failed", "4590", T0 + 1);

    expect(log.list()).toHaveLength(2);
  });

  test("hands out copies, so a caller cannot edit the log by holding it", () => {
    const log = new BridgeErrorLog();
    log.record("heartbeat-lost", "4589", T0);
    const first = log.list()[0];
    if (!first) throw new Error("expected one entry");
    first.count = 99;

    expect(log.list()[0]?.count).toBe(1);
  });
});

describe("agoLabel", () => {
  test("coarsens as the gap grows", () => {
    expect(agoLabel(0)).toBe("just now");
    expect(agoLabel(4_999)).toBe("just now");
    expect(agoLabel(42_000)).toBe("42s ago");
    expect(agoLabel(9 * 60_000)).toBe("9m ago");
    expect(agoLabel(3 * 3_600_000)).toBe("3h ago");
    expect(agoLabel(2 * 86_400_000)).toBe("2d ago");
  });
});

describe("renderDiagnostics", () => {
  test("renders every fact, with the errors oldest first", () => {
    const block = renderDiagnostics(
      facts({
        background: backgroundFacts({
          bridge: {
            ...backgroundFacts().bridge,
            status: "idle",
            connectedPort: undefined,
            errors: [
              { at: T0 - 9 * 60_000, kind: "handshake-timeout", subject: "4589", count: 3 },
              { at: T0 - 4 * 60_000, kind: "method-failed", subject: "tabs_list", count: 1 },
            ],
          },
        }),
      }),
      T0,
    );

    expect(block).toBe(
      [
        "```text",
        "Tabglutton 0.4.0 diagnostics (firefox build)",
        "grants       sites held · loopback held · downloads missing",
        "engine       Firefox 134.0.2",
        "platform     mac arm64",
        "tabs         412 in scope of 1207 open · 37 duplicates · 3 windows",
        "scope        hidden-false",
        "clips        obsidian · zotero routing off",
        "bridge       on · automatic port · idle · tab load off",
        "bridge errors (2, oldest first)",
        "  9m ago  handshake-timeout 4589 (x3)",
        "  4m ago  method-failed tabs_list",
        "```",
      ].join("\n"),
    );
  });

  test("names the connected port and the fixed port mode", () => {
    const block = renderDiagnostics(
      facts({
        background: backgroundFacts({
          bridge: {
            ...backgroundFacts().bridge,
            portMode: "fixed",
            fixedPort: 4600,
            connectedPort: 4600,
            allowTabLoad: true,
          },
        }),
      }),
      T0,
    );

    expect(block).toContain(
      "bridge       on · fixed port 4600 · connected on 4600 · tab load allowed",
    );
  });

  test("says so when the bridge is on but has no token, which reads as disabled", () => {
    const block = renderDiagnostics(
      facts({
        background: backgroundFacts({
          bridge: { ...backgroundFacts().bridge, hasToken: false, status: "disabled" },
        }),
      }),
      T0,
    );

    expect(block).toContain("bridge       on · no token · automatic port · disabled");
  });

  test("reports an unreachable background rather than inventing the rest", () => {
    const block = renderDiagnostics(facts({ background: undefined }), T0);

    expect(block).toBe(
      [
        "```text",
        "Tabglutton 0.4.0 diagnostics (firefox build)",
        "grants       sites held · loopback held · downloads missing",
        "note         the background page did not answer, so nothing else is known",
        "```",
      ].join("\n"),
    );
  });

  test("carries no token, URL or tab title — the whole point of the block", () => {
    const block = renderDiagnostics(
      facts({
        background: backgroundFacts({
          bridge: {
            ...backgroundFacts().bridge,
            errors: [{ at: T0 - 1_000, kind: "method-failed", subject: "tab_clip", count: 1 }],
          },
        }),
      }),
      T0,
    );

    // `DiagnosticsFacts` has no field that could carry any of these, so this is
    // a regression guard on the interface rather than on a filter: adding a
    // field that leaks one would have to break this test on the way in.
    expect(block).not.toContain("://");
    expect(block).not.toMatch(/token/i);
  });

  test("uses the singular for one duplicate and one window", () => {
    const block = renderDiagnostics(
      facts({ background: backgroundFacts({ duplicates: 1, windows: 1 }) }),
      T0,
    );

    expect(block).toContain("1 duplicate · 1 window");
  });
});
