// Tests cover the pure half of clip-memory.ts. `loadClipMemory` / `recordClip`
// need browser.storage.local and are out of scope, the same split storage.ts and
// undo-log.ts use.
import { describe, expect, test } from "bun:test";
import {
  clipMemoryKey,
  lookupClip,
  parseClipMemory,
  pruneClipMemory,
  rememberClip,
  type ClipMemory,
} from "../src/clip-memory.js";
import type { NormalizeOpts } from "../src/normalize.js";

const opts: NormalizeOpts = {};

describe("clipMemoryKey", () => {
  test("matches the same page reached two ways", () => {
    const newsletter = clipMemoryKey(
      "https://www.example.com/post?utm_source=newsletter&utm_medium=email",
      opts,
    );
    const chat = clipMemoryKey("https://example.com/post#intro", opts);
    expect(newsletter).toBe("example.com/post");
    expect(chat).toBe(newsletter);
  });

  test("is null for a tab with no address yet", () => {
    expect(clipMemoryKey(undefined, opts)).toBeNull();
    expect(clipMemoryKey("", opts)).toBeNull();
    expect(clipMemoryKey("not a url", opts)).toBeNull();
  });

  test("follows the user's own normalization settings", () => {
    const keep: NormalizeOpts = { stripFragment: false };
    expect(clipMemoryKey("https://example.com/post#intro", keep)).toBe("example.com/post#intro");
    expect(clipMemoryKey("https://example.com/post#intro", opts)).toBe("example.com/post");
  });
});

describe("rememberClip", () => {
  test("records a clip under its normalized key", () => {
    const memory = rememberClip(
      {},
      { url: "https://www.example.com/a?utm_source=x", state: "launched", destination: "obsidian" },
      opts,
      1000,
    );
    expect(memory).toEqual({
      "example.com/a": { at: 1000, state: "launched", destination: "obsidian" },
    });
  });

  test("a second clip of the same page updates the time, not the entry count", () => {
    const first = rememberClip(
      {},
      { url: "https://example.com/a", state: "launched", destination: "obsidian" },
      opts,
      1000,
    );
    const second = rememberClip(
      first,
      { url: "https://example.com/a?ref=twitter", state: "launched", destination: "obsidian" },
      opts,
      2000,
    );
    expect(Object.keys(second)).toEqual(["example.com/a"]);
    expect(second["example.com/a"]?.at).toBe(2000);
  });

  test("verified outranks launched, whichever order they arrive in", () => {
    const launched = rememberClip(
      {},
      { url: "https://example.com/a", state: "launched", destination: "obsidian" },
      opts,
      1000,
    );
    // The shape clip_confirm takes: the sidecar's verdict lands after the
    // extension already wrote `launched` for the same clip.
    const confirmed = rememberClip(
      launched,
      { url: "https://example.com/a", state: "verified", destination: "obsidian" },
      opts,
      1001,
    );
    expect(confirmed["example.com/a"]?.state).toBe("verified");

    // And a later unobservable handoff never takes the knowledge back.
    const reclipped = rememberClip(
      confirmed,
      { url: "https://example.com/a", state: "launched", destination: "obsidian" },
      opts,
      2000,
    );
    expect(reclipped["example.com/a"]).toEqual({
      at: 2000,
      state: "verified",
      destination: "obsidian",
    });
  });

  test("a URL with no key is dropped rather than failing the clip", () => {
    const memory = {
      "example.com/a": { at: 1, state: "launched" as const, destination: "file" as const },
    };
    expect(
      rememberClip(memory, { url: undefined, state: "launched", destination: "file" }, opts, 2),
    ).toBe(memory);
  });

  test("prunes the least recently clipped page when over the cap", () => {
    let memory: ClipMemory = {};
    for (let i = 0; i < 3; i += 1) {
      memory = rememberClip(
        memory,
        { url: `https://example.com/${i}`, state: "launched", destination: "obsidian" },
        opts,
        1000 + i,
      );
    }
    memory = rememberClip(
      memory,
      { url: "https://example.com/new", state: "launched", destination: "obsidian" },
      opts,
      2000,
      3,
    );
    expect(Object.keys(memory).sort()).toEqual([
      "example.com/1",
      "example.com/2",
      "example.com/new",
    ]);
  });
});

describe("pruneClipMemory", () => {
  test("keeps the newest entries and leaves an under-cap map alone", () => {
    const memory: ClipMemory = {
      old: { at: 1, state: "launched", destination: "obsidian" },
      mid: { at: 2, state: "launched", destination: "obsidian" },
      new: { at: 3, state: "verified", destination: "file" },
    };
    expect(pruneClipMemory(memory, 3)).toBe(memory);
    expect(Object.keys(pruneClipMemory(memory, 2)).sort()).toEqual(["mid", "new"]);
  });
});

describe("lookupClip", () => {
  const memory: ClipMemory = {
    "example.com/a": { at: 5, state: "verified", destination: "file" },
  };

  test("finds a page by any URL that normalizes to its key", () => {
    expect(lookupClip(memory, "https://www.example.com/a/?fbclid=1", opts)?.state).toBe("verified");
  });

  test("answers undefined for a page that was never clipped", () => {
    expect(lookupClip(memory, "https://example.com/b", opts)).toBeUndefined();
    expect(lookupClip(memory, undefined, opts)).toBeUndefined();
  });
});

describe("parseClipMemory", () => {
  test("keeps well-formed entries and drops everything else", () => {
    expect(
      parseClipMemory({
        good: { at: 1, state: "launched", destination: "obsidian" },
        "bad-state": { at: 1, state: "filed", destination: "obsidian" },
        "bad-destination": { at: 1, state: "launched", destination: "dropbox" },
        "bad-at": { at: "yesterday", state: "launched", destination: "file" },
        "": { at: 1, state: "launched", destination: "file" },
        nested: null,
      }),
    ).toEqual({ good: { at: 1, state: "launched", destination: "obsidian" } });
  });

  test("answers an empty map for anything that is not one", () => {
    expect(parseClipMemory(undefined)).toEqual({});
    expect(parseClipMemory([{ at: 1, state: "launched", destination: "file" }])).toEqual({});
    expect(parseClipMemory("clipMemory")).toEqual({});
  });
});
