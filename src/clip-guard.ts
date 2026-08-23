/**
 * Refuses an extraction that carries too little to be worth a note.
 *
 * Devour's phase 1 reloads every discarded tab in a run, which is precisely the
 * traffic pattern a bot check answers with an interstitial served at the parked
 * URL. Nothing downstream can tell that page from the one that was there: it has
 * no translator, so it falls past the Zotero route to the note destinations, and
 * Defuddle extracting "Just a moment…" is a *successful* clip. The user then
 * loses the tab and gains junk, which is worse than failing ([#49]).
 *
 * Length is the detector rather than the signature list below, because every
 * interstitial variant is thin while no list of them stays current. The
 * disposition is the one the undo invariants already take: keep the tab, say
 * why, let the user clear the challenge and retry.
 *
 * Pure on purpose — this is the one part of the clip path that can be unit
 * tested, and it is applied at `clipTab`, the single point both the popup's
 * Devour and the bridge's `tab_read`/`tab_clip` extract through.
 *
 * [#49]: https://github.com/mlsimon734/tabglutton/issues/49
 */

/** Why an extraction was refused. One value today; a union so callers switch. */
export type ClipGuardReason = "thin-content";

/**
 * The floor, in characters of visible text (see `clipTextLength`).
 *
 * Two constraints, and 512 sits between them. It has to clear the longest
 * challenge page we know of with real margin, because a challenge above the
 * floor is clipped and has its tab closed, which is the entire failure this
 * exists to stop. Run through `clipTextLength`, the three Cloudflare variants
 * measure 58 characters (the JavaScript-disabled notice), 206 (the current
 * "Verifying you are human" page) and 225 (the classic "Checking your browser
 * before accessing…" page with its Ray ID footer), so 512 clears the longest by
 * better than 2x. Those are transcriptions of the pages' copy rather than
 * captures from a live challenge — #49 was filed unreproduced — so the margin is
 * doing real work and should not be spent.
 *
 * The other constraint is that it stay well under anything a reader would call
 * an article, because a page refused here keeps its tab and costs one manual
 * retry. #49 accepts that trade in that direction only, so when the two
 * constraints disagree the floor moves up, not down.
 *
 * Characters, not words: a word count refuses every page in a language that
 * does not space its words, whereas a character floor is merely stricter for the
 * languages that fit more meaning into one.
 */
export const MIN_CLIP_CONTENT_CHARS = 512;

/**
 * Known interstitial wording. Deliberately tiny, and deliberately unable to
 * refuse anything by itself: a match only sharpens the sentence shown for a page
 * the length check has already refused.
 *
 * #49 warns that signature lists rot, and this is the shape where rot is cheap.
 * A stale list under-explains a refusal that still happens; a false match cannot
 * cost a page that carried enough content to keep. Anything that would make a
 * match load-bearing belongs above this comment as a reason not to.
 */
const CHALLENGE_SIGNATURES: readonly RegExp[] = [
  /just a moment/i,
  /attention required/i,
  /checking (?:if the site connection is secure|your browser)/i,
  /verif(?:y|ying) you are (?:human|a human)/i,
  /enable javascript and cookies to continue/i,
  /needs to review the security of your connection/i,
  /(?:ddos protection|performance & security) by cloudflare/i,
];

/**
 * How much of an extraction is reading matter.
 *
 * Link and image targets are excluded because they are markup, not content: one
 * tracking URL can outweigh a whole interstitial's prose, and the guard must not
 * be argued out of a verdict by a page's own hrefs. Everything dropped is
 * replaced by a space rather than deleted, so stripping a marker inside a word
 * cannot shorten the text it was sitting in.
 */
export function clipTextLength(markdown: string): number {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/[#>*_`~|]/g, " ")
    .replace(/\s+/g, " ")
    .trim().length;
}

export interface ThinClipVerdict {
  reason: ClipGuardReason;
  /** Characters of visible text the extraction actually carried. */
  chars: number;
  /** A known challenge signature matched too. Wording only — never a verdict. */
  challengeSuspect: boolean;
  /** Rendered in the popup's failure row and sent as the bridge error message. */
  message: string;
}

function thinClipMessage(chars: number, challengeSuspect: boolean): string {
  const measured =
    `Only ${chars} characters of content could be extracted ` +
    `(clips need at least ${MIN_CLIP_CONTENT_CHARS}).`;
  return challengeSuspect
    ? `This looks like a bot check or CAPTCHA rather than the page that was parked here. ` +
        `${measured} Nothing was saved and the tab was kept — open it, clear the challenge, ` +
        `and clip again.`
    : `${measured} Nothing was saved and the tab was kept — the page may be a bot check, or ` +
        `may not have finished loading. Open it and clip again.`;
}

/** `null` when the extraction carries enough to be worth a note. */
export function thinClipVerdict(payload: {
  title: string;
  markdown: string;
}): ThinClipVerdict | null {
  const chars = clipTextLength(payload.markdown);
  if (chars >= MIN_CLIP_CONTENT_CHARS) return null;
  const challengeSuspect = CHALLENGE_SIGNATURES.some(
    (signature) => signature.test(payload.title) || signature.test(payload.markdown),
  );
  return {
    reason: "thin-content",
    chars,
    challengeSuspect,
    message: thinClipMessage(chars, challengeSuspect),
  };
}
