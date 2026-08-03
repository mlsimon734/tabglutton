import { describe, test, expect } from "bun:test";
import type { BridgeTab } from "../src/bridge-protocol.js";
import { displayUrl, renderTabs, TAB_TITLE_MAX, TAB_URL_MAX } from "../src/tabs-view.js";

function makeTab(fields: Partial<BridgeTab> & Pick<BridgeTab, "id" | "url">): BridgeTab {
  return { title: "", windowId: 1, index: 0, ...fields };
}

describe("displayUrl()", () => {
  test("drops the noise that makes URLs long", () => {
    expect(displayUrl("https://www.example.com/post/?utm_source=x&utm_medium=y&id=7")).toBe(
      "https://example.com/post?id=7",
    );
    expect(displayUrl("https://example.com/a/b/")).toBe("https://example.com/a/b");
  });

  test("keeps the scheme, so the result can still be handed to the user verbatim", () => {
    expect(displayUrl("http://example.com/x")).toStartWith("http://");
    expect(displayUrl("https://example.com/x")).toStartWith("https://");
  });

  test("keeps a non-default port", () => {
    expect(displayUrl("http://localhost:3000/app/")).toBe("http://localhost:3000/app");
    expect(displayUrl("https://www.example.com:8443/path")).toBe("https://example.com:8443/path");
  });

  // For an SPA the fragment is the whole page identity, so stripping it — which
  // normalizeUrl does by default, because it is building a dedup key — would
  // collapse every route of an app into one indistinguishable URL.
  test("keeps the fragment", () => {
    expect(displayUrl("https://example.com/app#/settings/profile")).toBe(
      "https://example.com/app#/settings/profile",
    );
  });

  test("keeps parameter order rather than sorting it", () => {
    expect(displayUrl("https://example.com/?z=1&a=2")).toBe("https://example.com?z=1&a=2");
  });

  test("passes through what it cannot parse or does not own", () => {
    expect(displayUrl("about:blank")).toBe("about:blank");
    expect(displayUrl("not a url")).toBe("not a url");
  });

  test("clips only as a backstop, and marks it", () => {
    const long = `https://example.com/${"p".repeat(400)}`;
    const out = displayUrl(long);
    expect(out).toHaveLength(TAB_URL_MAX);
    expect(out).toEndWith("…");
  });
});

describe("renderTabs()", () => {
  test("clips a long title and marks it, leaving a short one alone", () => {
    const long = "t".repeat(TAB_TITLE_MAX + 50);
    const [clipped, short] = renderTabs([
      makeTab({ id: 1, url: "https://a.test/", title: long }),
      makeTab({ id: 2, url: "https://b.test/", title: "short" }),
    ]).tabs;
    expect(clipped?.title).toHaveLength(TAB_TITLE_MAX);
    expect(clipped?.title).toEndWith("…");
    expect(short?.title).toBe("short");
  });

  test("drops index and hoists a window every tab shares", () => {
    const view = renderTabs([
      makeTab({ id: 1, url: "https://a.test/", windowId: 7, index: 0 }),
      makeTab({ id: 2, url: "https://b.test/", windowId: 7, index: 1 }),
    ]);
    expect(view.windowId).toBe(7);
    expect(view.tabs[0]).not.toHaveProperty("windowId");
    expect(view.tabs[0]).not.toHaveProperty("index");
  });

  test("keeps windowId per tab once a listing spans two windows", () => {
    const view = renderTabs([
      makeTab({ id: 1, url: "https://a.test/", windowId: 7 }),
      makeTab({ id: 2, url: "https://b.test/", windowId: 8 }),
    ]);
    expect(view.windowId).toBeUndefined();
    expect(view.tabs.map((t) => t.windowId)).toEqual([7, 8]);
  });

  // Two browsers can each call their window 1; hoisting would then claim a
  // single window that does not exist.
  test("refuses to hoist across a merged listing", () => {
    const view = renderTabs(
      [makeTab({ id: 1, url: "https://a.test/" }), makeTab({ id: 2, url: "https://b.test/" })],
      { hoistWindow: false },
    );
    expect(view.windowId).toBeUndefined();
    expect(view.tabs.map((t) => t.windowId)).toEqual([1, 1]);
  });

  test("carries only the flags that are true", () => {
    const [tab] = renderTabs([
      makeTab({ id: 1, url: "https://a.test/", discarded: true, pinned: false }),
    ]).tabs;
    expect(tab).toMatchObject({ discarded: true });
    expect(tab).not.toHaveProperty("pinned");
    expect(tab).not.toHaveProperty("active");
    expect(tab).not.toHaveProperty("lastAccessed");
  });

  test("preserves order one-for-one, which the origin lookup depends on", () => {
    const input = [3, 1, 2].map((id) => makeTab({ id, url: `https://${id}.test/` }));
    expect(renderTabs(input).tabs.map((t) => t.id)).toEqual([3, 1, 2]);
  });
});
