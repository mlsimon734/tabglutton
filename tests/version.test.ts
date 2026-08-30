import { expect, test } from "bun:test";

/**
 * One release version exists in four places and no build step reconciles them.
 *
 * `scripts/sync-gullet-version.ts` keeps `GULLET_VERSION` level with
 * `gullet/package.json` and `gullet/tests/version.test.ts` catches it if that
 * stops running — but nothing has ever checked the three package manifests
 * against each other, or any of them against the CHANGELOG heading
 * `scripts/release-notes.ts` extracts. Both have gone wrong: `release.yml`
 * verifies the tag against `package.json` alone, so a `manifest.json` left
 * behind ships a store package whose version disagrees with its own release,
 * and a heading never dated leaves `release-notes.ts` extracting a section
 * that still says `(unreleased)`.
 *
 * The four-part assertion pins a bug that actually happened (`ebbb933 Release
 * 0.1.2.1`). The fourth position belongs to `bun run sign:dev`, which writes it
 * into an artifact and a local tag and then restores both files; committed, it
 * breaks the invariant that `commit-and-tag-version` needs semver to work at
 * all. See AGENTS.md §Versioning.
 */

const root = new URL("..", import.meta.url).pathname;

async function versionOf(path: string): Promise<string> {
  const { version } = (await Bun.file(`${root}${path}`).json()) as { version?: unknown };
  if (typeof version !== "string") throw new Error(`${path} has no version string`);
  return version;
}

test("the three package manifests carry one version", async () => {
  const [pkg, manifest, gullet] = await Promise.all([
    versionOf("package.json"),
    versionOf("manifest.json"),
    versionOf("gullet/package.json"),
  ]);
  expect(manifest).toBe(pkg);
  expect(gullet).toBe(pkg);
});

test("the release version is three parts, never the sign:dev build counter", async () => {
  expect(await versionOf("package.json")).toMatch(/^\d+\.\d+\.\d+$/);
});

/**
 * The top heading is either this version, dated — the released state — or a
 * later one still marked `(unreleased)`, which is the state every merge into
 * `main` between releases leaves behind. What it may never be is a dated
 * heading that disagrees with `package.json`: that is a release whose notes
 * describe a different version.
 */
test("the top CHANGELOG heading agrees with package.json", async () => {
  const pkg = await versionOf("package.json");
  const changelog = await Bun.file(`${root}CHANGELOG.md`).text();
  const heading = changelog.match(/^## \[?(\d+\.\d+\.\d+)\]?.*$/m);
  expect(heading).not.toBeNull();
  const [line, version] = heading as RegExpMatchArray;

  if (line.includes("(unreleased)")) {
    expect(Bun.semver.order(version, pkg)).toBe(1);
  } else {
    expect(version).toBe(pkg);
    expect(line).toMatch(/\(\d{4}-\d{2}-\d{2}\)/);
  }
});
