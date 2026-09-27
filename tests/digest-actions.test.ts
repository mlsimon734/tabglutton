import { beforeEach, describe, expect, test } from "bun:test";
import { BridgeRequestError, type TabsCloseResult } from "../src/bridge-protocol.js";
import {
  DIGESTS_KEY,
  type DigestItemRecord,
  type DigestRecord,
  type LiveTab,
} from "../src/digest.js";
import { DigestActions, isDigestMutation, type DigestActionDeps } from "../src/digest-actions.js";
import type { PlannedGroup } from "../src/grouping.js";
import type { UndoBatch } from "../src/undo-log.js";

// The actions reach storage and runtime messaging through the `browser`
// global; everything else is injected. An in-memory stand-in is enough.
let store: Record<string, unknown> = {};
(globalThis as unknown as { browser: unknown }).browser = {
  storage: {
    local: {
      get: async (key: string) => ({ [key]: store[key] }),
      set: async (items: Record<string, unknown>) => {
        store = { ...store, ...structuredClone(items) };
      },
    },
  },
  runtime: { sendMessage: async () => undefined },
};

const ID = "f".repeat(32);

function tab(id: number, url: string, extra: Partial<LiveTab> = {}): LiveTab {
  return {
    id,
    url,
    windowId: 1,
    incognito: false,
    pinned: false,
    active: false,
    hidden: false,
    discarded: false,
    ...extra,
  };
}

function item(tabIdHint: number, url: string, fate: DigestItemRecord["fate"]): DigestItemRecord {
  return {
    url,
    title: url,
    fate,
    reason: "r",
    tabIdHint,
    anchor: { windowId: 1, incognito: false },
    observed: { open: true },
  };
}

function seed(items: DigestItemRecord[]): void {
  const record: DigestRecord = {
    id: ID,
    receivedAt: 1,
    reporter: {},
    sitting: { sources: [] },
    items,
    closes: [],
    mirror: { state: "pending" },
  };
  store = { [DIGESTS_KEY]: { v: 1, digests: [record] } };
}

function stored(): DigestRecord {
  const raw = store[DIGESTS_KEY] as { digests: DigestRecord[] };
  const record = raw.digests[0];
  if (!record) throw new Error("no digest stored");
  return record;
}

interface Harness {
  deps: DigestActionDeps;
  live: LiveTab[];
  log: UndoBatch[];
  closed: number[][];
  groups: PlannedGroup[][];
}

function harness(live: LiveTab[], overrides: Partial<DigestActionDeps> = {}): Harness {
  const h: Harness = { live, log: [], closed: [], groups: [], deps: undefined as never };
  h.deps = {
    opts: () => ({}),
    liveTabs: async () => h.live,
    getTab: async (id) => h.live.find((t) => t.id === id) ?? null,
    readUndoLog: async () => h.log,
    closeTabs: async (tabIds): Promise<TabsCloseResult> => {
      h.closed.push(tabIds);
      const batchId = "batch-1";
      h.log = [
        {
          id: batchId,
          closedAt: Date.now(),
          entries: tabIds.map((id) => ({
            url: h.live.find((t) => t.id === id)?.url ?? "",
            title: "",
            pinned: false,
            windowId: 1,
            index: 0,
          })),
        },
      ];
      h.live = h.live.filter((t) => !tabIds.includes(t.id));
      return { closed: tabIds.length, batchId, entries: [] };
    },
    undoClose: async (batchId) => {
      h.log = h.log.filter((b) => b.id !== batchId);
      return { batchId, restored: 1, failed: 0 };
    },
    group: async (groups) => {
      h.groups.push(groups);
      return { groupedIds: groups.flatMap((g) => g.tabIds) };
    },
    focusTab: async () => {},
    openUrl: async () => {},
    ...overrides,
  };
  return h;
}

beforeEach(() => {
  store = {};
});

describe("digest actions", () => {
  test("mutation vs read", () => {
    expect(isDigestMutation("get-digests")).toBe(false);
    expect(isDigestMutation("digest-act")).toBe(true);
    expect(isDigestMutation("digest-seen")).toBe(true);
  });

  test("close acts as one batch, records it, and undo state follows the undo log", async () => {
    seed([
      item(1, "https://a.test/", "close"),
      item(2, "https://b.test/", "close"),
      item(3, "https://c.test/", "close"),
      item(4, "https://d.test/", "worth-it"),
    ]);
    const h = harness([
      tab(1, "https://a.test/"),
      tab(2, "https://b.test/", { pinned: true }),
      tab(4, "https://d.test/"),
    ]);
    const actions = new DigestActions(h.deps);
    const res = await actions.act(ID, "close");
    expect(res).toEqual({
      ok: true,
      action: "close",
      done: 1,
      outcomes: [
        { index: 0, outcome: "closed" },
        { index: 1, outcome: "pinned" },
        { index: 2, outcome: "gone" },
      ],
      batchId: "batch-1",
    });
    expect(h.closed).toEqual([[1]]);
    expect(stored().closes[0]?.batchId).toBe("batch-1");

    const got = (await actions.handle({ type: "get-digests", view: true })) as {
      view: { undo: { batchId: string } | null; items: Array<{ locked: boolean }> };
    };
    expect(got.view.undo?.batchId).toBe("batch-1");
    expect(got.view.items[0]?.locked).toBe(true);

    expect(await actions.handle({ type: "digest-undo", digestId: ID })).toMatchObject({ ok: true });
    const after = (await actions.handle({ type: "get-digests", view: true })) as {
      view: { undo: unknown };
    };
    expect(after.view.undo).toBeNull();
    // A second undo finds nothing left to reopen.
    expect(await actions.handle({ type: "digest-undo", digestId: ID })).toMatchObject({
      ok: false,
    });
  });

  test("a tab that navigated between plan and act is left alone as changed", async () => {
    seed([item(1, "https://a.test/", "close"), item(2, "https://b.test/", "close")]);
    const h = harness([tab(1, "https://a.test/"), tab(2, "https://b.test/")]);
    h.deps.getTab = async (id) =>
      id === 2 ? tab(2, "https://elsewhere.test/") : (h.live.find((t) => t.id === id) ?? null);
    const res = await new DigestActions(h.deps).act(ID, "close");
    expect(res.ok && res.outcomes).toEqual([
      { index: 0, outcome: "closed" },
      { index: 1, outcome: "changed" },
    ]);
    expect(h.closed).toEqual([[1]]);
  });

  test("tabs_close refusing every id closes nothing; the browser says which are gone", async () => {
    seed([item(1, "https://a.test/", "close"), item(2, "https://b.test/", "close")]);
    const h = harness([tab(1, "https://a.test/"), tab(2, "https://b.test/")], {
      // `not-found` also means "none has committed a URL yet", so the code
      // alone cannot say gone.
      closeTabs: async () => {
        throw new BridgeRequestError(
          "not-found",
          "None of the given tabs have committed a URL yet.",
        );
      },
    });
    let checks = 0;
    const planned = h.deps.getTab;
    h.deps.getTab = async (id) => {
      checks++;
      // The recheck before closing sees both; afterwards tab 1 has gone.
      return checks > 2 && id === 1 ? null : planned(id);
    };
    const res = await new DigestActions(h.deps).act(ID, "close");
    expect(res.ok && res.outcomes).toEqual([
      { index: 0, outcome: "gone" },
      { index: 1, outcome: "failed" },
    ]);
    // The intent was written first, and the batch-less record stands.
    expect(stored().closes[0]?.batchId).toBeUndefined();
  });

  test("partial close: missing and skipped ids map back to their items", async () => {
    seed([
      item(1, "https://a.test/", "close"),
      item(2, "https://b.test/", "close"),
      item(3, "https://c.test/", "close"),
    ]);
    const h = harness(
      [tab(1, "https://a.test/"), tab(2, "https://b.test/"), tab(3, "https://c.test/")],
      {
        closeTabs: async () => ({
          closed: 1,
          batchId: "b",
          entries: [],
          missing: [2],
          skipped: [3],
        }),
      },
    );
    const res = await new DigestActions(h.deps).act(ID, "close");
    expect(res.ok && res.outcomes).toEqual([
      { index: 0, outcome: "closed" },
      { index: 1, outcome: "gone" },
      { index: 2, outcome: "failed" },
    ]);
  });

  test("keep groups per window, excluding pinned and hidden", async () => {
    seed([
      item(1, "https://a.test/", "worth-it"),
      item(2, "https://b.test/", "worth-it"),
      item(3, "https://c.test/", "worth-it"),
      item(4, "https://d.test/", "worth-it"),
    ]);
    const live = [
      tab(1, "https://a.test/"),
      tab(2, "https://b.test/", { pinned: true }),
      tab(3, "https://c.test/", { hidden: true }),
      tab(4, "https://d.test/", { windowId: 2 }),
    ];
    const items = stored().items;
    items[3] = { ...items[3]!, anchor: { windowId: 2, incognito: false } };
    const h = harness(live);
    const res = await new DigestActions(h.deps).act(ID, "keep");
    expect(res.ok && res.outcomes).toEqual([
      { index: 0, outcome: "grouped" },
      { index: 1, outcome: "pinned" },
      { index: 2, outcome: "hidden" },
      { index: 3, outcome: "grouped" },
    ]);
    expect(h.groups[0]?.map((g) => [g.name, g.color, g.windowId, g.tabIds])).toEqual([
      ["Worth your time", "yellow", 1, [1]],
      ["Worth your time", "yellow", 2, [4]],
    ]);
    expect(stored().keep?.outcomes).toHaveLength(4);
  });

  test("keep on an engine without tab groups moves nothing and records nothing", async () => {
    seed([item(1, "https://a.test/", "worth-it")]);
    const h = harness([tab(1, "https://a.test/")], {
      group: async () => ({ groupedIds: [], unsupported: "no tabs.group" }),
    });
    const res = await new DigestActions(h.deps).act(ID, "keep");
    expect(res).toEqual({
      ok: true,
      action: "keep",
      done: 0,
      outcomes: [],
      unsupported: "no tabs.group",
    });
    expect(stored().keep).toBeUndefined();
  });

  test("moving a row writes userFate; a locked row cannot move", async () => {
    seed([item(1, "https://a.test/", "close"), item(2, "https://b.test/", "close")]);
    const h = harness([tab(1, "https://a.test/"), tab(2, "https://b.test/")]);
    const actions = new DigestActions(h.deps);
    expect(
      await actions.handle({ type: "digest-set-fate", digestId: ID, index: 1, fate: "worth-it" }),
    ).toEqual({ ok: true });
    expect(stored().items[1]?.userFate).toBe("worth-it");
    // Back to the agent's own fate clears the override.
    await actions.handle({ type: "digest-set-fate", digestId: ID, index: 1, fate: "close" });
    expect(stored().items[1]?.userFate).toBeUndefined();

    await actions.act(ID, "close");
    expect(
      await actions.handle({ type: "digest-set-fate", digestId: ID, index: 0, fate: "worth-it" }),
    ).toEqual({ ok: false });
    expect(
      await actions.handle({
        type: "digest-set-fate",
        digestId: ID,
        index: 0,
        fate: "explode" as never,
      }),
    ).toEqual({ ok: false });
  });

  test("seen is written once", async () => {
    seed([item(1, "https://a.test/", "close")]);
    const actions = new DigestActions(harness([]).deps);
    await actions.handle({ type: "digest-seen", digestId: ID });
    const first = stored().openedAt;
    expect(typeof first).toBe("number");
    await actions.handle({ type: "digest-seen", digestId: ID });
    expect(stored().openedAt).toBe(first);
  });

  test("show focuses a resolved tab, or reopens a gone page's http(s) URL", async () => {
    seed([item(1, "https://a.test/", "could-not-read"), item(2, "https://b.test/", "close")]);
    const focused: number[] = [];
    const opened: string[] = [];
    const h = harness([tab(1, "https://a.test/")], {
      focusTab: async (id) => {
        focused.push(id);
      },
      openUrl: async (url) => {
        opened.push(url);
      },
    });
    const actions = new DigestActions(h.deps);
    await actions.handle({ type: "digest-show", digestId: ID, index: 0 });
    await actions.handle({ type: "digest-show", digestId: ID, index: 1 });
    expect(focused).toEqual([1]);
    expect(opened).toEqual(["https://b.test/"]);
  });
});
