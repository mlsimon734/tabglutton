// The one thing standing between an upgrade and a stale hub serving it.
//
// `GULLET_VERSION` is a hand-written constant because the published executable
// is a single bundled file with no package.json beside it to read. It was
// cosmetic for as long as it only appeared in the MCP `initialize` response, and
// it duly drifted — sitting at 0.1.0 against a 0.3.1 package. It is not cosmetic
// any more: a detached hub outlives releases, and it only stands aside for a peer
// that can say it is newer. A lagging constant means the upgraded session
// attaches to the old hub and gets the old code, for up to six idle hours,
// which is precisely the failure the retirement path was added to prevent.
//
// `scripts/sync-gullet-version.ts` keeps them in step on release; this is what
// catches it if that ever stops running.

import { test, expect } from "bun:test";
import { GULLET_VERSION } from "../src/version.js";

test("GULLET_VERSION matches gullet/package.json", async () => {
  const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
    version: string;
  };
  expect(GULLET_VERSION).toBe(pkg.version);
});
