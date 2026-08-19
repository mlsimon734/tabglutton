/**
 * Runtime host-permission grants.
 *
 * Chrome's build declares no `host_permissions` at all — `build.ts` moves them
 * to `optional_host_permissions` — so the install prompt says nothing about
 * reading websites and the two features that genuinely need site access ask for
 * it when they are first used. Firefox keeps them in `host_permissions`, where
 * MV3 already treats them as optional-at-install and grants them through the
 * post-install doorhanger; `request()` there resolves `true` without prompting,
 * which is why none of the call sites branch on the target.
 *
 * Dedup — the default flow — needs neither grant. Closing a tab and reading its
 * title and URL come from the `tabs` permission, so someone who only ever
 * devours duplicates is never asked for anything.
 */

/**
 * Every site, because the Defuddle extractor is injected into whichever tabs are
 * being clipped and a tab list is not knowable in advance.
 */
export const CLIP_ORIGINS = ["*://*/*"];

/**
 * The bridge sidecar. Match patterns carry no port, so this one covers every
 * `bridgePort` the user could pick.
 */
export const BRIDGE_ORIGINS = ["http://127.0.0.1/*"];

/**
 * Safe to call anywhere, including the background page. Answers only what has
 * already been granted — it never prompts, so it cannot substitute for
 * `requestOrigins` in a flow that needs the access.
 */
export async function hasOrigins(origins: string[]): Promise<boolean> {
  try {
    return await browser.permissions.contains({ origins });
  } catch {
    return false;
  }
}

/**
 * Whether the `downloads` permission is held. Never prompts; safe from the
 * background page, for the same reason as `hasOrigins`.
 *
 * The file destination writes through `downloads`, which is optional on both
 * engines rather than required — Firefox renders it as "Download files and read
 * and modify the browser's download history", and a *newly* required permission
 * disables an existing Chrome install until the user re-approves it. Neither
 * cost is worth charging every user for a destination most will never pick.
 */
export async function hasDownloads(): Promise<boolean> {
  try {
    return await browser.permissions.contains({ permissions: ["downloads"] });
  } catch {
    return false;
  }
}

/**
 * What a surface that *has* a gesture says when the file destination has no
 * grant behind it. Shared by onboarding and the options page because both do
 * the same thing about it: revert the destination to Obsidian. Reverting is
 * what makes the remedy performable at all — re-selecting an already-checked
 * radio fires no `change`, so a file radio left checked can never ask again.
 */
export const DOWNLOADS_REFUSED =
  "Download access was declined, so files would have nowhere to go — the destination is back on Obsidian. Choose Markdown files again to ask once more.";
export const DOWNLOADS_REVOKED =
  "Tabglutton no longer has permission to save downloads, so the destination is back on Obsidian. Choose Markdown files to grant it again.";

/**
 * What the surfaces with no gesture say instead. Neither the background page
 * nor the bridge can ask for anything, so both name the one place that can —
 * and that name is only truthful because the options page reverts the
 * destination when it finds the grant gone, leaving the radio clickable.
 */
export const DOWNLOADS_REMEDY =
  "The destination in Tabglutton's settings reverts to Obsidian while the permission is missing, so choosing Markdown files there again is what asks the browser for it.";

/** The fact and the remedy in one sentence, for every surface that just reports. */
export const DOWNLOADS_GONE = `Tabglutton no longer has permission to save downloads. ${DOWNLOADS_REMEDY}`;

/**
 * Prompt if needed, and report whether the access is now held.
 *
 * **Must be the first `await` inside a click handler**, for the transient
 * activation reason spelled out on `requestOrigins`.
 */
export async function requestDownloads(): Promise<boolean> {
  let granted = false;
  try {
    granted = await browser.permissions.request({ permissions: ["downloads"] });
  } catch (err) {
    console.warn("[tabglutton] downloads permission request failed", err);
  }
  return granted || (await hasDownloads());
}

/**
 * Prompt if needed, and report whether the access is now held.
 *
 * **Must be the first `await` inside a click handler.** Chrome gates
 * `permissions.request` on transient user activation, and awaiting any other
 * extension API first drops the activation off the callstack — the request then
 * rejects with "may only be called from a user gesture" even though a real
 * click is what got us here. That is also why there is no `hasOrigins` check in
 * front of it: `request()` already resolves `true` without showing anything when
 * the permission is held, so the pre-check would buy nothing and cost the
 * gesture.
 */
export async function requestOrigins(origins: string[]): Promise<boolean> {
  let granted = false;
  try {
    granted = await browser.permissions.request({ origins });
  } catch (err) {
    console.warn("[tabglutton] permission request failed", err);
  }
  if (granted) return true;
  // A refusal and "that request was not legal here" are the same `false` from
  // the caller's side, and they want opposite outcomes. Firefox declares these
  // origins in `host_permissions` rather than `optional_host_permissions` — the
  // engines disagree about whether those may be re-requested at runtime — so ask
  // what we actually hold before reporting a denial. On Chrome a real refusal
  // still answers false here, because nothing was granted.
  return await hasOrigins(origins);
}
