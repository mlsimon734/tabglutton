// Tests cover the pure half of clip-memory.ts. `loadClipMemory` / `recordClip`
// need browser.storage.local and are out of scope, the same split storage.ts and
// undo-log.ts use.
import { describe, expect, test } from "bun:test";
import {
  clipMarkFor,
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
    expect(memory).toEqual({ "example.com/a": { at: 1000, destination: "obsidian" } });
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

  test("a page that is not a real one is never remembered", () => {
    // normalizeUrl passes a non-http URL through unchanged, so without the gate
    // in clipMemoryKey a Gecko tab mid-navigation would key under about:blank —
    // and one entry there marks every loading tab as already clipped.
    for (const url of ["about:blank", "chrome://newtab", "file:///tmp/x.html"]) {
      expect(clipMemoryKey(url, opts)).toBeNull();
      expect(rememberClip({}, { url, state: "launched", destination: "file" }, opts, 1)).toEqual(
        {},
      );
    }
  });

  test("a sighting on disk is never taken back by a later clip that saw nothing", () => {
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
    expect(clipMarkFor(confirmed["example.com/a"]!)).toBe("verified");
    expect(confirmed["example.com/a"]?.verifiedAt).toBe(1001);

    // And a later unobservable handoff never takes the knowledge back.
    const reclipped = rememberClip(
      confirmed,
      { url: "https://example.com/a", state: "launched", destination: "obsidian" },
      opts,
      2000,
    );
    // The sighting keeps its own date and the clip keeps its own: bound
    // together, "verified" would claim a note was seen on a day nothing looked.
    expect(reclipped["example.com/a"]).toEqual({
      at: 2000,
      destination: "obsidian",
      verifiedAt: 1001,
    });
  });

  test("a URL with no key is dropped rather than failing the clip", () => {
    const memory = { "example.com/a": { at: 1, destination: "file" as const } };
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
      old: { at: 1, destination: "obsidian" },
      mid: { at: 2, destination: "obsidian" },
      new: { at: 3, destination: "file", verifiedAt: 3 },
    };
    expect(pruneClipMemory(memory, 3)).toBe(memory);
    expect(Object.keys(pruneClipMemory(memory, 2)).sort()).toEqual(["mid", "new"]);
  });
});

describe("lookupClip", () => {
  const memory: ClipMemory = {
    "example.com/a": { at: 5, destination: "file", verifiedAt: 5 },
  };

  test("finds a page by any URL that normalizes to its key", () => {
    const found = lookupClip(memory, "https://www.example.com/a/?fbclid=1", opts);
    expect(found && clipMarkFor(found)).toBe("verified");
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
        good: { at: 1, destination: "obsidian" },
        "bad-destination": { at: 1, destination: "dropbox" },
        "bad-at": { at: "yesterday", destination: "file" },
        // A stored NaN would make pruneClipMemory's comparator answer NaN, so
        // the eviction order would be unspecified and junk could outlive a
        // live entry.
        "nan-at": { at: Number.NaN, destination: "file" },
        "nan-verified": { at: 1, destination: "file", verifiedAt: Number.NaN },
        "": { at: 1, destination: "file" },
        nested: null,
      }),
    ).toEqual({ good: { at: 1, destination: "obsidian" } });
  });

  test("answers an empty map for anything that is not one", () => {
    expect(parseClipMemory(undefined)).toEqual({});
    expect(parseClipMemory([{ at: 1, destination: "file" }])).toEqual({});
    expect(parseClipMemory("clipMemory")).toEqual({});
  });
});
