// The extension half of the clip's content fingerprint. Gullet's half is
// `gullet/src/clip-verify.ts`'s `clipContentHash`, and the two are pinned
// together by `tests/clip-source.test.ts` — which imports *this* module, not a
// copy of it, because a divergence here reports every clip as unconfirmed and
// nothing else in the suite would notice.
//
// Kept out of `bridge-methods.ts` purely so it is reachable from `bun test`:
// that module's import graph reaches `browser`, this one is pure.

/**
 * Line endings are transport, not content.
 *
 * In the default clipboard clip mode the note's text goes to Obsidian through
 * the OS clipboard, and Windows carries plain text as CF_UNICODETEXT with CRLF
 * endings — so the LF the extension composed and hashed is not what Obsidian
 * writes to disk. Hashing the normalized form on both sides costs the ability
 * to tell two clips apart by their line endings alone (there is no such pair)
 * and buys back the whole Windows clipboard path, which would otherwise report
 * every successful clip as `mismatched` and leave every requested close undone.
 */
function normalizeLineEndings(text: string): string {
  return text.replaceAll("\r\n", "\n");
}

/**
 * SHA-256 of a clip's text, hex, as `TabClipResult.contentHash`.
 *
 * The extension cannot check whether Obsidian took the handoff, but it can say
 * exactly what it handed over, and that is enough for a sidecar sitting beside
 * the vault to tell this clip's note from a concurrent clip of the same page.
 * `crypto.subtle` is available in both the event page and the service worker.
 */
export async function clipContentHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalizeLineEndings(text)),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
