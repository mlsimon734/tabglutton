import { describe, expect, test } from "bun:test";
import { releaseNotes } from "../scripts/release-notes.js";

const CHANGELOG = `# Changelog

All notable changes to Tabglutton are documented here.

## [0.2.0](https://example.invalid/compare/v0.1.2...v0.2.0) (2026-08-01)

First public release.

### Features

- Dedup.

## [0.1.2](https://example.invalid/compare/v0.1.1...v0.1.2) (2026-05-18)

Signing update.

## 0.1.1-alpha.1 (2026-05-16)

The oldest entry.
`;

describe("releaseNotes", () => {
  test("returns a section without its heading, stopping at the next version", () => {
    expect(releaseNotes(CHANGELOG, "0.2.0")).toBe(
      "First public release.\n\n### Features\n\n- Dedup.",
    );
  });

  test("reads the last section to the end of the file", () => {
    expect(releaseNotes(CHANGELOG, "0.1.1-alpha.1")).toBe("The oldest entry.");
  });

  test("returns null for a version with no section", () => {
    expect(releaseNotes(CHANGELOG, "0.3.0")).toBeNull();
  });

  test("does not match a version that merely shares a prefix", () => {
    expect(releaseNotes(CHANGELOG, "0.1")).toBeNull();
  });
});
