/**
 * The sidecar's version, reported to the MCP client on initialize and — since
 * hubs began outliving the sessions that spawn them — offered to a hub as
 * grounds for it to retire in our favour. Keep in step with
 * `gullet/package.json`; a value that lags is now more than cosmetic, because a
 * detached hub started before an upgrade only stands aside for a peer that says
 * it is newer.
 *
 * Its own module so `backend.ts` can read it without importing `main.ts`, which
 * imports `backend.ts`.
 */
export const GULLET_VERSION = "0.4.1";
