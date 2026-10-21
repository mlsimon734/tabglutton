import { beforeEach, describe, expect, test } from "bun:test";
import { BridgeRequestError, type TabsCloseResult } from "../src/bridge-protocol.js";
import {
  DIGESTS_KEY,
  type DigestItemRecord,
  type DigestRecord,
  type LiveTab,
} from "../src/digest.js";
import {
  DigestActions,
  isDigestMutation,
  ORDER_CHANGED,
  type DigestActionDeps,
} from "../src/digest-actions.js";
import { layoutFrom, type OrderMove } from "../src/tab-order.js";
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
    index: 0,
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
  moves: Array<[number, OrderMove]>;
}

/**
 * One window's tabs moved the way Chrome 148 measured: the moved tab or group
 * ends up at `index`, everything else keeps its relative order.
 */
function simulateMove(h: Harness, windowId: number, move: OrderMove): void {
  const order = h.live.filter((t) => t.windowId === windowId).sort((a, b) => a.index - b.index);
  const moving = order.filter((t) =>
    move.block.groupId !== undefined
      ? t.groupId === move.block.groupId
      : t.id === move.block.tabIds[0],
  );
  const rest = order.filter((t) => !moving.includes(t));
  rest.splice(move.index, 0, ...moving);
  rest.forEach((t, index) => {
    t.index = index;
  });
}

/** Tab ids of one window, in index order. */
function windowOrder(h: Harness, windowId = 1): number[] {
  return h.live
    .filter((t) => t.windowId === windowId)
    .sort((a, b) => a.index - b.index)
    .map((t) => t.id);
}

function harness(live: LiveTab[], overrides: Partial<DigestActionDeps> = {}): Harness {
  const h: Harness = {
    live: live.map((t, i) => ({ ...t, index: t.index || i })),
    log: [],
    closed: [],
    moves: [],
    deps: undefined as never,
  };
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
    readLayout: async (windowId) => layoutFrom(h.live.filter((t) => t.windowId === windowId)),
    moveBlock: async (windowId, move) => {
      h.moves.push([windowId, move]);
      simulateMove(h, windowId, move);
    },
    pageFacts: async () => [],
    fileTo: () => ({ kind: "obsidian", zotero: false }),
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

  // Window 1: a pinned tab, then a, [b c], d, e, f, the panel itself; window 2 holds g.
  function orderFixture(): Harness {
    seed([
      item(2, "https://a.test/", "close"),
      item(3, "https://b.test/", "close"),
      item(4, "https://c.test/", "worth-it"),
      item(5, "https://d.test/", "file"),
      { ...item(6, "https://e.test/", "close"), userFate: "worth-it" },
      item(7, "https://f.test/", "could-not-read"),
      { ...item(9, "https://g.test/", "worth-it"), anchor: { windowId: 2, incognito: false } },
    ]);
    return harness([
      tab(1, "https://pinned.test/", { index: 0, pinned: true }),
      tab(2, "https://a.test/", { index: 1 }),
      tab(3, "https://b.test/", { index: 2, groupId: 40 }),
      tab(4, "https://c.test/", { index: 3, groupId: 40 }),
      tab(5, "https://d.test/", { index: 4 }),
      tab(6, "https://e.test/", { index: 5 }),
      tab(7, "https://f.test/", { index: 6 }),
      tab(8, "moz-extension://x/popup/devour.html", { index: 7 }),
      tab(9, "https://g.test/", { index: 0, windowId: 2 }),
    ]);
  }

  test("focus orders the invoking window alone, by effective fate, groups whole", async () => {
    const h = orderFixture();
    const actions = new DigestActions(h.deps);
    const res = await actions.handle(
      { type: "digest-order", digestId: ID, direction: "focus" },
      { windowId: 1 },
    );
    // [b c] holds a worth-it tab, e was moved to worth-it by the user, then
    // could-not-read f, the neutral panel, file d, and close a last.
    expect(windowOrder(h)).toEqual([1, 3, 4, 6, 7, 8, 5, 2]);
    expect(windowOrder(h, 2)).toEqual([9]);
    expect(h.moves.every(([w]) => w === 1)).toBe(true);
    expect(res).toMatchObject({ ok: true, complete: true, ranked: 6, elsewhere: 1, fixed: 1 });
    const order = stored().order;
    expect(order?.windowId).toBe(1);
    expect(order?.before.map((b) => b.tabIds)).toEqual([[1], [2], [3, 4], [5], [6], [7], [8]]);
    expect(order?.after?.map((b) => b.tabIds)).toEqual([[1], [3, 4], [6], [7], [8], [5], [2]]);
  });

  test("clear reverses the buckets, and keeps the order inside each", async () => {
    const h = orderFixture();
    await new DigestActions(h.deps).handle(
      { type: "digest-order", digestId: ID, direction: "clear" },
      { windowId: 1 },
    );
    expect(windowOrder(h)).toEqual([1, 2, 5, 8, 7, 3, 4, 6]);
  });

  test("the window's starting layout is stored before the first move", async () => {
    const h = orderFixture();
    const seen: Array<boolean> = [];
    const move = h.deps.moveBlock;
    h.deps.moveBlock = async (windowId, m) => {
      seen.push(stored().order?.before.length === 7 && stored().order?.after === undefined);
      await move(windowId, m);
    };
    await new DigestActions(h.deps).handle(
      { type: "digest-order", digestId: ID, direction: "focus" },
      { windowId: 1 },
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toBe(true);
  });

  test("without the sender's window nothing is ordered", async () => {
    const h = orderFixture();
    const res = await new DigestActions(h.deps).handle({
      type: "digest-order",
      digestId: ID,
      direction: "focus",
    });
    expect(res).toMatchObject({ ok: false });
    expect(h.moves).toEqual([]);
    expect(stored().order).toBeUndefined();
  });

  test("undo puts the window back exactly, once", async () => {
    const h = orderFixture();
    const start = windowOrder(h);
    const actions = new DigestActions(h.deps);
    await actions.handle(
      { type: "digest-order", digestId: ID, direction: "focus" },
      { windowId: 1 },
    );
    const view = (await actions.handle({ type: "get-digests", view: true })) as {
      view: { order?: { undo: string | null } };
    };
    expect(view.view.order?.undo).toBe("ready");
    const [first, second] = await Promise.all([
      actions.handle({ type: "digest-undo-order", digestId: ID }),
      actions.handle({ type: "digest-undo-order", digestId: ID }),
    ]);
    expect([first, second]).toContainEqual(expect.objectContaining({ ok: true, exact: true }));
    expect([first, second]).toContainEqual(expect.objectContaining({ ok: false }));
    expect(windowOrder(h)).toEqual(start);
    expect(stored().order?.undoneAt).toEqual(expect.any(Number));
    const after = (await actions.handle({ type: "get-digests", view: true })) as {
      view: { order?: { undo: string | null } };
    };
    expect(after.view.order?.undo).toBeNull();
  });

  test("undo refuses once the window changed, and moves nothing", async () => {
    const h = orderFixture();
    const actions = new DigestActions(h.deps);
    await actions.handle(
      { type: "digest-order", digestId: ID, direction: "focus" },
      { windowId: 1 },
    );
    // The user drags the panel to the front.
    simulateMove(h, 1, { block: { tabIds: [8], start: 5, end: 5 }, index: 1 });
    const dragged = windowOrder(h);
    const moves = h.moves.length;
    const view = (await actions.handle({ type: "get-digests", view: true })) as {
      view: { order?: { undo: string | null } };
    };
    expect(view.view.order?.undo).toBe("changed");
    expect(await actions.handle({ type: "digest-undo-order", digestId: ID })).toEqual({
      ok: false,
      error: ORDER_CHANGED,
    });
    expect(windowOrder(h)).toEqual(dragged);
    expect(h.moves.length).toBe(moves);
    expect(stored().order?.undoneAt).toBeUndefined();
  });

  test("a closed tab, a new one, or a regroup also refuse", async () => {
    for (const change of [
      (h: Harness) => (h.live = h.live.filter((t) => t.id !== 5)),
      (h: Harness) => h.live.push(tab(20, "https://new.test/", { index: 99 })),
      (h: Harness) => (h.live = h.live.map((t) => (t.id === 4 ? { ...t, groupId: 41 } : t))),
      (h: Harness) => (h.live = h.live.map((t) => (t.id === 2 ? { ...t, pinned: true } : t))),
    ]) {
      const h = orderFixture();
      const actions = new DigestActions(h.deps);
      await actions.handle(
        { type: "digest-order", digestId: ID, direction: "focus" },
        { windowId: 1 },
      );
      change(h);
      const moves = h.moves.length;
      expect(await actions.handle({ type: "digest-undo-order", digestId: ID })).toEqual({
        ok: false,
        error: ORDER_CHANGED,
      });
      expect(h.moves.length).toBe(moves);
    }
  });

  test("orders in a row keep the first starting point, so one Undo goes all the way back", async () => {
    const h = orderFixture();
    const start = windowOrder(h);
    const actions = new DigestActions(h.deps);
    await actions.handle(
      { type: "digest-order", digestId: ID, direction: "focus" },
      { windowId: 1 },
    );
    await actions.handle(
      { type: "digest-order", digestId: ID, direction: "focus" },
      { windowId: 1 },
    );
    expect(stored().order?.moves).toBe(0);
    await actions.handle(
      { type: "digest-order", digestId: ID, direction: "clear" },
      { windowId: 1 },
    );
    expect(windowOrder(h)).toEqual([1, 2, 5, 8, 7, 3, 4, 6]);
    expect(await actions.handle({ type: "digest-undo-order", digestId: ID })).toMatchObject({
      ok: true,
      exact: true,
    });
    expect(windowOrder(h)).toEqual(start);
  });

  test("a run cut short by a drag is recorded as such, and Undo still goes back exactly", async () => {
    const h = orderFixture();
    const start = windowOrder(h);
    const move = h.deps.moveBlock;
    let calls = 0;
    h.deps.moveBlock = async (windowId, m) => {
      await move(windowId, m);
      // The user drags a tab while the order runs.
      if (++calls === 1) simulateMove(h, 1, { block: { tabIds: [5], start: 0, end: 0 }, index: 7 });
    };
    const actions = new DigestActions(h.deps);
    const res = await actions.handle(
      { type: "digest-order", digestId: ID, direction: "focus" },
      { windowId: 1 },
    );
    expect(res).toMatchObject({ ok: true, complete: false, moves: 1 });
    expect(stored().order?.complete).toBe(false);
    h.deps.moveBlock = move;
    expect(await actions.handle({ type: "digest-undo-order", digestId: ID })).toMatchObject({
      ok: true,
      exact: true,
    });
    expect(windowOrder(h)).toEqual(start);
  });

  test("unticking a close row moves it to could-not-read; ticking returns it", async () => {
    seed([item(1, "https://a.test/", "close"), item(2, "https://b.test/", "close")]);
    const h = harness([tab(1, "https://a.test/"), tab(2, "https://b.test/")]);
    const actions = new DigestActions(h.deps);
    await actions.handle({
      type: "digest-set-fate",
      digestId: ID,
      index: 1,
      fate: "could-not-read",
    });
    expect(stored().items[1]?.userFate).toBe("could-not-read");
    const res = await actions.act(ID, "close");
    expect(res.ok && res.outcomes).toEqual([{ index: 0, outcome: "closed" }]);
    expect(h.closed).toEqual([[1]]);
    await actions.handle({ type: "digest-set-fate", digestId: ID, index: 1, fate: null });
    expect(stored().items[1]?.userFate).toBeUndefined();
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
