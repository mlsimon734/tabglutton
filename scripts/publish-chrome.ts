#!/usr/bin/env bun
// Chrome Web Store publishing, the counterpart to `bun run sign` for AMO.
//
// This targets the **V2** API at chromewebstore.googleapis.com. V1 (`www.googleapis.com/
// chromewebstore/v1.1`) is deprecated and supported only until 15 October 2026, so nothing
// new should be built on it. V2 paths are named `publishers/{publisherId}/items/{itemId}`,
// which is the one shape change that bites: V1 needed only the item id, so a V1 recipe
// ported across will 404 without CWS_PUBLISHER_ID. Setup: docs/STORE.md 6.
//
// Uploading and publishing are separate acts on purpose. An upload only replaces the draft
// package; nothing reaches users, and nothing is queued for review, until --publish.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { loadEnv, requireEnv } from "./sign-env.js";

const ITEM_ID = "dlploljcggbdcjcaiigmoagonmehglhi";
const API = "https://chromewebstore.googleapis.com";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const UPLOAD_POLL_TIMEOUT_MS = 5 * 60_000;
const PUBLISH_POLL_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 3_000;

type UploadState =
  | "UPLOAD_STATE_UNSPECIFIED"
  | "SUCCEEDED"
  | "IN_PROGRESS"
  | "FAILED"
  | "NOT_FOUND";
type ItemState =
  | "ITEM_STATE_UNSPECIFIED"
  | "PENDING_REVIEW"
  | "STAGED"
  | "PUBLISHED"
  | "PUBLISHED_TO_TESTERS"
  | "REJECTED"
  | "CANCELLED";

interface UploadItemPackageResponse {
  name: string;
  itemId: string;
  crxVersion?: string;
  uploadState: UploadState;
}

interface RevisionStatus {
  state?: ItemState;
  distributionChannels?: { deployPercentage?: number; crxVersion?: string }[];
}

interface FetchItemStatusResponse {
  name: string;
  itemId: string;
  publishedItemRevisionStatus?: RevisionStatus;
  submittedItemRevisionStatus?: RevisionStatus;
  lastAsyncUploadState?: UploadState;
  takenDown?: boolean;
  warned?: boolean;
}

interface PublishItemResponse {
  name: string;
  itemId: string;
  state?: ItemState;
  warningInfo?: { warnings?: { reason: string; description: string }[] };
}

const USAGE = `Usage: bun scripts/publish-chrome.ts [options]

Packages the Chrome build and uploads it as a draft. Nothing is submitted for review
and nothing reaches users until --publish.

  --publish       submit the uploaded draft for review; it publishes when it passes
  --staged=N      with --publish: staged rollout, holding the release at N% of users
  --skip-build    upload the existing zip instead of repackaging
  --publish-only  publish the draft already in the store; no build, no upload
  --zip=PATH      package to upload (default: web-ext-artifacts/tabglutton-chrome-<version>.zip)
  --status        print the item's current status and exit
  --cancel        cancel the active submission and exit
  --deploy=N      raise the published revision's rollout to N% and exit
  --help          print this

Credentials come from .env: CWS_PUBLISHER_ID, CWS_CLIENT_ID, CWS_CLIENT_SECRET,
CWS_REFRESH_TOKEN. Run scripts/cws-auth.ts once to mint the refresh token.`;

const FLAGS = ["publish", "skip-build", "publish-only", "status", "cancel", "help"];
const VALUES = ["staged", "zip", "deploy"];

const args = process.argv.slice(2);
for (const arg of args) {
  const name = arg.startsWith("--") ? arg.slice(2).split("=")[0] : "";
  const known = arg.includes("=") ? VALUES.includes(name) : FLAGS.includes(name);
  if (!known) {
    console.error(`Unrecognized argument: ${arg}\n\n${USAGE}`);
    process.exit(1);
  }
}

const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.slice(name.length + 3);
};

if (flag("help")) {
  console.log(USAGE);
  process.exit(0);
}

const publishOnly = flag("publish-only");
const wantsPublish = flag("publish") || publishOnly;
const staged = value("staged");
const deploy = value("deploy");

function percentage(raw: string, label: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
    console.error(`${label} takes a whole number between 0 and 100; got "${raw}".`);
    process.exit(1);
  }
  return parsed;
}

loadEnv();
const [publisherId, clientId, clientSecret, refreshToken] = requireEnv(
  "CWS_PUBLISHER_ID",
  "CWS_CLIENT_ID",
  "CWS_CLIENT_SECRET",
  "CWS_REFRESH_TOKEN",
);
const item = `publishers/${publisherId}/items/${ITEM_ID}`;

async function accessToken(): Promise<string> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = (await response.json()) as { access_token?: string; error?: string };
  if (!response.ok || !body.access_token) {
    console.error(`Could not refresh the access token (HTTP ${response.status}: ${body.error}).`);
    if (body.error === "invalid_grant") {
      console.error(
        "A refresh token also dies after six months unused, or when the Google account's" +
          "\npassword changes. Re-run `bun scripts/cws-auth.ts` and paste the new one into .env.",
      );
    }
    process.exit(1);
  }
  return body.access_token;
}

const token = await accessToken();

async function call<T>(method: string, action: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API}/v2/${item}:${action}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) {
    const message = (JSON.parse(text || "{}") as { error?: { message?: string } }).error?.message;
    console.error(`\n${action} failed (HTTP ${response.status}): ${message ?? text}`);
    process.exit(1);
  }
  // cancelSubmission and setPublishedDeployPercentage answer with an empty body.
  return (text ? JSON.parse(text) : {}) as T;
}

const fetchStatus = () => call<FetchItemStatusResponse>("GET", "fetchStatus");

function describe(label: string, revision: RevisionStatus | undefined) {
  if (!revision) {
    console.log(`  ${label}: none`);
    return;
  }
  const channels = (revision.distributionChannels ?? [])
    .map(
      (c) =>
        `${c.crxVersion ?? "?"}${c.deployPercentage === undefined ? "" : ` @ ${c.deployPercentage}%`}`,
    )
    .join(", ");
  console.log(`  ${label}: ${revision.state ?? "?"}${channels ? ` (${channels})` : ""}`);
}

function report(status: FetchItemStatusResponse) {
  console.log(`\nItem ${status.itemId}:`);
  describe("published", status.publishedItemRevisionStatus);
  describe("submitted", status.submittedItemRevisionStatus);
  if (status.lastAsyncUploadState) console.log(`  last upload: ${status.lastAsyncUploadState}`);
  if (status.takenDown) console.log("  TAKEN DOWN");
  if (status.warned) console.log("  WARNED");
}

/** Every crx version the store will admit to holding, in either revision slot. */
function versionsIn(status: FetchItemStatusResponse): string[] {
  return [status.publishedItemRevisionStatus, status.submittedItemRevisionStatus]
    .flatMap((revision) => revision?.distributionChannels ?? [])
    .map((channel) => channel.crxVersion)
    .filter((version): version is string => version !== undefined);
}

async function poll<T>(attempt: () => Promise<T | null>, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await attempt();
    if (result !== null) return result;
    if (Date.now() >= deadline) return null;
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

if (flag("status")) {
  report(await fetchStatus());
  process.exit(0);
}

if (flag("cancel")) {
  await call("POST", "cancelSubmission");
  console.log("✓ Submission cancelled.");
  report(await fetchStatus());
  process.exit(0);
}

if (deploy !== undefined) {
  const target = percentage(deploy, "--deploy");
  await call("POST", "setPublishedDeployPercentage", { deployPercentage: target });
  console.log(`✓ Rollout raised to ${target}%.`);
  report(await fetchStatus());
  process.exit(0);
}

const { version } = (await Bun.file("package.json").json()) as { version: string };

if (!publishOnly) {
  if (!flag("skip-build")) {
    const built = spawnSync("bun", ["run", "package:chrome"], {
      stdio: "inherit",
      env: process.env,
    });
    if (built.status !== 0) {
      console.error(`\npackage:chrome failed (status ${built.status}).`);
      process.exit(built.status ?? 1);
    }
  }

  const zipPath = value("zip") ?? `web-ext-artifacts/tabglutton-chrome-${version}.zip`;
  if (!existsSync(zipPath)) {
    console.error(`No package at ${zipPath}. Run \`bun run package:chrome\` first.`);
    process.exit(1);
  }

  console.log(`\nUploading ${zipPath} to ${item}`);
  // The package goes to the media endpoint under /upload, as the raw zip body — not the
  // metadata endpoint of the same name, which takes no package at all.
  const response = await fetch(`${API}/upload/v2/${item}:upload`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/zip" },
    body: Bun.file(zipPath),
  });
  const text = await response.text();
  if (!response.ok) {
    const message = (JSON.parse(text || "{}") as { error?: { message?: string } }).error?.message;
    console.error(`\nUpload failed (HTTP ${response.status}): ${message ?? text}`);
    process.exit(1);
  }
  const uploaded = JSON.parse(text) as UploadItemPackageResponse;

  // A large package is accepted asynchronously; then the upload response is not the answer
  // and fetchStatus's lastAsyncUploadState is.
  let state = uploaded.uploadState;
  if (state === "IN_PROGRESS") {
    console.log("Upload is processing…");
    const settled = await poll(async () => {
      const seen = (await fetchStatus()).lastAsyncUploadState;
      return seen === undefined || seen === "IN_PROGRESS" ? null : seen;
    }, UPLOAD_POLL_TIMEOUT_MS);
    if (settled === null) {
      console.error(`\nUpload was still processing after ${UPLOAD_POLL_TIMEOUT_MS / 1000}s.`);
      process.exit(1);
    }
    state = settled;
  }
  if (state !== "SUCCEEDED") {
    console.error(`\nUpload did not succeed: ${state}.`);
    report(await fetchStatus());
    process.exit(1);
  }
  if (uploaded.crxVersion && uploaded.crxVersion !== version) {
    console.error(
      `\nThe store took version ${uploaded.crxVersion}, but this tree is ${version}.` +
        "\nThat is the wrong package; check web-ext-artifacts/.",
    );
    process.exit(1);
  }
  console.log(`✓ Uploaded ${uploaded.crxVersion ?? version} as a draft.`);
}

if (!wantsPublish) {
  report(await fetchStatus());
  console.log(
    "\nDraft only — nothing was submitted for review. Re-run with --publish-only when" +
      "\nthe listing is ready, or finish it by hand in the Developer Dashboard.",
  );
  process.exit(0);
}

const body =
  staged === undefined
    ? { publishType: "DEFAULT_PUBLISH" }
    : {
        publishType: "STAGED_PUBLISH",
        deployInfos: [{ deployPercentage: percentage(staged, "--staged") }],
      };

console.log(`\nPublishing (${body.publishType})…`);
const published = await call<PublishItemResponse>("POST", "publish", body);
for (const warning of published.warningInfo?.warnings ?? []) {
  console.log(`  warning — ${warning.reason}: ${warning.description}`);
}

// The point of this script: a publish that answers 200 and did not take is the failure
// mode, so the verdict is what fetchStatus says afterwards, never the publish response.
// It can lag a few seconds behind the call, hence the poll.
const confirmed = await poll(async () => {
  const status = await fetchStatus();
  return versionsIn(status).includes(version) ? status : null;
}, PUBLISH_POLL_TIMEOUT_MS);

if (confirmed === null) {
  console.error(
    `\n✗ publish answered ${published.state ?? "?"}, but ${PUBLISH_POLL_TIMEOUT_MS / 1000}s later the` +
      `\n  API still does not name ${version} in either revision. Treat the publish as` +
      "\n  unconfirmed and check the Developer Dashboard before re-running.",
  );
  report(await fetchStatus());
  process.exit(1);
}

console.log(`\n✓ Store confirms ${version} is submitted.`);
report(confirmed);
