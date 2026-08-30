// Where each half of a release actually is, read from the three services rather
// than from a sentence someone has to remember to update.
//
// docs/STORE.md used to open with the answer written down. It said both stores
// served 0.3.1 and that `tabglutton-gullet` had never been published, for eight
// days after both stopped being true — in a file whose own first paragraph calls
// it "reference material, not a tracker". A fact with an expiry date does not
// belong in a reference document, and the fix is not to update it more often.
//
// Public endpoints only: no credentials, no .env, and nothing here changes
// anything. `bun run status`.

const ADDON = "tabglutton"; // scripts/amo-listing-images.ts
const ITEM_ID = "dlploljcggbdcjcaiigmoagonmehglhi"; // scripts/publish-chrome.ts
const PACKAGE = "tabglutton-gullet";

type Reading = { where: string; version: string; note?: string };

async function local(): Promise<Reading> {
  const { version } = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
    version: string;
  };
  return { where: "local", version };
}

async function amo(): Promise<Reading> {
  const res = await fetch(`https://addons.mozilla.org/api/v5/addons/addon/${ADDON}/`);
  if (!res.ok) return { where: "AMO", version: "?", note: `HTTP ${res.status}` };
  const body = (await res.json()) as {
    current_version?: { version?: string };
    status?: string;
    average_daily_users?: number;
  };
  return {
    where: "AMO",
    version: body.current_version?.version ?? "?",
    note: `${body.status ?? "?"}, ${body.average_daily_users ?? 0} daily users`,
  };
}

/**
 * The Chrome Web Store has no public read API — the V2 endpoints
 * `scripts/publish-chrome.ts` uses all need the publisher credentials. The
 * listing page carries the version in a labelled cell, so it is scraped, and a
 * layout change here is a missing answer rather than a wrong one.
 */
async function cws(): Promise<Reading> {
  const res = await fetch(`https://chromewebstore.google.com/detail/${ITEM_ID}`, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) return { where: "Chrome Web Store", version: "?", note: `HTTP ${res.status}` };
  const found = /Version<\/div><div[^>]*>([^<]{1,20})</.exec(await res.text());
  return {
    where: "Chrome Web Store",
    version: found?.[1] ?? "?",
    note: found ? undefined : "listing markup changed; check by hand",
  };
}

async function npm(): Promise<Reading> {
  const res = await fetch(`https://registry.npmjs.org/${PACKAGE}`);
  if (res.status === 404) return { where: "npm", version: "—", note: "never published" };
  if (!res.ok) return { where: "npm", version: "?", note: `HTTP ${res.status}` };
  const body = (await res.json()) as { "dist-tags"?: { latest?: string } };
  return { where: "npm", version: body["dist-tags"]?.latest ?? "?" };
}

const readings = await Promise.all([local(), amo(), cws(), npm()]);
const width = Math.max(...readings.map((r) => r.where.length));
for (const { where, version, note } of readings) {
  console.log(`${where.padEnd(width)}  ${version.padEnd(8)}${note ? `  ${note}` : ""}`);
}

const behind = readings.filter((r) => r.where !== "local" && r.version !== readings[0]?.version);
if (behind.length > 0) {
  console.log(`\nbehind local: ${behind.map((r) => r.where).join(", ")}`);
}
