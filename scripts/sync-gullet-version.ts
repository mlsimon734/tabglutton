// Copies gullet/package.json's version into the constant the sidecar reports.
//
// Runs from `.versionrc.json`'s postbump, so a release moves both in one act.
// `GULLET_VERSION` cannot be read from package.json at runtime — the published
// executable is a single bundled file with no package.json beside it — and the
// constant stopped being cosmetic when detached hubs started retiring for newer
// peers: a value that lags means an upgraded session attaching to a hub from the
// previous release cannot say it is newer, so the stale hub keeps serving.
// `tests/gullet-version.test.ts` fails if the two ever drift.

const root = new URL("..", import.meta.url).pathname;
const source = `${root}gullet/src/version.ts`;

const { version } = (await Bun.file(`${root}gullet/package.json`).json()) as { version: string };
if (typeof version !== "string" || !version) throw new Error("gullet/package.json has no version");

const text = await Bun.file(source).text();
const updated = text.replace(
  /^export const GULLET_VERSION = ".*";$/m,
  `export const GULLET_VERSION = "${version}";`,
);
if (updated === text && !text.includes(`"${version}"`)) {
  throw new Error(`could not find the GULLET_VERSION declaration in ${source}`);
}

await Bun.write(source, updated);
console.log(`[sync-gullet-version] GULLET_VERSION = ${version}`);
