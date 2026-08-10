#!/usr/bin/env bun
/**
 * Print one version's CHANGELOG.md section, for use as a GitHub release body.
 *
 * Usage: bun scripts/release-notes.ts [version]
 * Defaults to the version in package.json. Exits non-zero when the section is
 * missing, so a release never publishes with an empty body.
 */

/** Matches both `## [0.2.0](compare-url) (date)` and `## 0.1.1-alpha.1 (date)`. */
const HEADING = /^## \[?([0-9][^\]\s]*)\]?/;

export function releaseNotes(changelog: string, version: string): string | null {
  const lines = changelog.split("\n");
  let start = -1;

  for (let i = 0; i < lines.length; i++) {
    const heading = HEADING.exec(lines[i] ?? "");
    if (!heading) continue;
    if (start === -1) {
      if (heading[1] === version) start = i;
      continue;
    }
    return lines
      .slice(start + 1, i)
      .join("\n")
      .trim();
  }

  return start === -1
    ? null
    : lines
        .slice(start + 1)
        .join("\n")
        .trim();
}

if (import.meta.main) {
  const { version: packageVersion } = (await Bun.file("package.json").json()) as {
    version: string;
  };
  const version = Bun.argv[2] ?? packageVersion;
  const notes = releaseNotes(await Bun.file("CHANGELOG.md").text(), version);

  if (notes === null || notes === "") {
    console.error(
      `[release-notes] no CHANGELOG.md section for ${version} — write one before releasing`,
    );
    process.exit(1);
  }

  console.log(notes);
}
