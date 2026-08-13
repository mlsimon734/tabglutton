/**
 * Upload the AMO listing icon and screenshots.
 *
 * AMO's listing icon and screenshots are Developer Hub fields, not package contents —
 * nothing in `manifest.json` reaches them (see docs/STORE.md §5). This script pushes both
 * through the AMO external API so the listing can be rebuilt from the repo rather than
 * from memory of which file went in which slot.
 *
 * Credentials are WEB_EXT_API_KEY / WEB_EXT_API_SECRET — the pair `bun run sign:dev` already
 * uses, since an AMO API key is one credential per account rather than one per purpose. Bun
 * loads ./.env automatically, so a checkout that can sign can also do this with no argument:
 *
 *   bun scripts/amo-listing-images.ts
 *
 * Flags:
 *   --dry-run    show what would be sent, contact nobody
 *   --verify     authenticate and report current listing state, change nothing
 *   --replace    delete existing previews first (default is to refuse if any exist)
 *   --icon-only / --previews-only
 *
 * Two AMO details worth keeping: the JWT expiry may be at most five minutes past `iat`, so
 * a token is minted per request rather than once per run; and previews are ordered by an
 * explicit `position`, so the shot order in docs/STORE.md §5 is passed rather than implied
 * by upload sequence.
 */

const ADDON = "tabglutton";
const API = "https://addons.mozilla.org/api/v5";
const MEDIA = Bun.fileURLToPath(new URL("../docs/media/store/", import.meta.url));

/** Listing order, per docs/STORE.md §5: light theme first, dark grouped at the end. */
const PREVIEWS = [
  "cockpit-light-1280x800.png",
  "popup-light.png",
  "cockpit-inspector-light-1280x800.png",
  "obsidian-note-1280x800.png",
  "cockpit-dark-1280x800.png",
  "popup-dark.png",
  "cockpit-inspector-dark-1280x800.png",
] as const;

const ICON = "amo-icon-512.png";

const THROTTLE_RETRIES = 12;

/**
 * AMO throttles on two clocks: a burst limit that clears in under a minute, and an hourly
 * one that answers "available in 3475 seconds". Waiting out the first is what makes a run
 * unattended; waiting out the second is a script that looks hung for an hour, so it stops
 * instead and says when to resume. Nothing is lost — the run picks up from the listing.
 */
const MAX_THROTTLE_WAIT_S = 180;

interface Preview {
  id: number;
  position: number;
}

interface Listing {
  slug: string;
  icon_url?: string;
  previews: Preview[];
}

/**
 * The `previews/` collection is POST-only — a GET answers 405 — so the current set is read
 * from the add-on detail, which embeds it. Shape is checked rather than asserted: reading a
 * missing `previews` as an array would leave `length` undefined, silently passing the
 * "already has previews" guard and appending a second set to the live listing.
 */
function parseListing(payload: unknown): Listing {
  if (payload && typeof payload === "object") {
    const { slug, icon_url: iconUrl, previews } = payload as Partial<Listing>;
    if (typeof slug === "string" && Array.isArray(previews)) {
      return { slug, icon_url: iconUrl, previews };
    }
  }
  throw new Error(`unexpected add-on detail: ${JSON.stringify(payload).slice(0, 200)}`);
}

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

async function mintToken(issuer: string, secret: string): Promise<string> {
  const issued = Math.floor(Date.now() / 1000);
  const header = base64url(utf8(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = base64url(
    utf8(
      JSON.stringify({
        iss: issuer,
        jti: crypto.randomUUID(),
        iat: issued,
        exp: issued + 240, // AMO's ceiling is 300; leave slack for clock skew.
      }),
    ),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    utf8(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, utf8(`${header}.${payload}`));
  return `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
}

/**
 * AMO throttles writes hard — a full run is nine of them and it starts refusing after three,
 * answering 429 with `{"detail":"Request was throttled. Expected available in 57 seconds."}`.
 * That wait is the server's own number, so it is obeyed rather than guessed at; a fresh JWT
 * is minted on each attempt because the five-minute expiry is shorter than a few backoffs.
 */
async function call(
  issuer: string,
  secret: string,
  method: string,
  path: string,
  body?: FormData,
): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `JWT ${await mintToken(issuer, secret)}` },
      body,
    });
    const text = await response.text();
    if (response.ok) return text ? (JSON.parse(text) as unknown) : null;

    if (response.status === 429 && attempt < THROTTLE_RETRIES) {
      const stated = /available in (\d+) second/.exec(text)?.[1];
      const wait = (stated ? Number(stated) : 60) + 2; // slack for clock skew
      if (wait > MAX_THROTTLE_WAIT_S) {
        throw new Error(
          `AMO's hourly write limit is in force — it will accept more in ${Math.ceil(wait / 60)} ` +
            `minutes. Re-run this script then; it resumes from what the listing already has.`,
        );
      }
      console.log(`  throttled; waiting ${wait}s`);
      await Bun.sleep(wait * 1000);
      continue;
    }
    throw new Error(`${method} ${path} -> ${response.status} ${response.statusText}\n${text}`);
  }
}

async function imageField(name: string): Promise<File> {
  const file = Bun.file(`${MEDIA}${name}`);
  if (!(await file.exists())) throw new Error(`missing image: ${MEDIA}${name}`);
  return new File([await file.arrayBuffer()], name, { type: "image/png" });
}

async function main(): Promise<void> {
  const flags = new Set(Bun.argv.slice(2));
  const dryRun = flags.has("--dry-run");
  const doIcon = !flags.has("--previews-only");
  const doPreviews = !flags.has("--icon-only");

  if (dryRun) {
    console.log(`add-on: ${ADDON}`);
    if (doIcon) console.log(`icon:     ${ICON}`);
    if (doPreviews) PREVIEWS.forEach((name, i) => console.log(`preview ${i}: ${name}`));
    for (const name of [...(doIcon ? [ICON] : []), ...(doPreviews ? PREVIEWS : [])]) {
      await imageField(name); // existence check only
    }
    console.log("\nall images present; nothing sent (--dry-run)");
    return;
  }

  // Same credentials web-ext signs with, under the names .env already uses — an AMO API key
  // is one credential per account, not one per purpose, so `sign:dev` and this share it.
  const issuer = Bun.env.WEB_EXT_API_KEY ?? Bun.env.AMO_JWT_ISSUER;
  const secret = Bun.env.WEB_EXT_API_SECRET ?? Bun.env.AMO_JWT_SECRET;
  if (!issuer || !secret) {
    throw new Error(
      "set WEB_EXT_API_KEY and WEB_EXT_API_SECRET (Bun loads ./.env automatically); " +
        "generate at https://addons.mozilla.org/en-US/developers/addon/api/key/",
    );
  }

  const listing = parseListing(await call(issuer, secret, "GET", `/addons/addon/${ADDON}/`));

  if (flags.has("--verify")) {
    console.log(`authenticated; add-on ${listing.slug}`);
    // A default icon_url points at /static/img/addon-icons/default-*.png rather than the
    // per-add-on /user-media/addon_icons/ path, which is how the placeholder is spotted.
    const placeholder = listing.icon_url?.includes("addon-icons/default") ?? true;
    console.log(`icon: ${placeholder ? "PLACEHOLDER" : "set"} — ${listing.icon_url ?? "none"}`);
    console.log(`previews: ${listing.previews.length}`);
    return;
  }

  // The run is resumable because it has to be: nine writes against a throttle that refuses
  // after three means a partial run is the normal outcome, not the exceptional one. Each
  // step asks the listing what it already has rather than tracking progress locally.
  const replace = flags.has("--replace");

  if (doIcon) {
    if (!replace && !(listing.icon_url?.includes("addon-icons/default") ?? true)) {
      console.log("icon already set; skipping (--replace to overwrite)");
    } else {
      const body = new FormData();
      body.set("icon", await imageField(ICON));
      await call(issuer, secret, "PATCH", `/addons/addon/${ADDON}/`, body);
      console.log(`icon uploaded: ${ICON}`);
    }
  }

  if (doPreviews) {
    const current = listing.previews;
    if (replace) {
      for (const preview of current) {
        await call(issuer, secret, "DELETE", `/addons/addon/${ADDON}/previews/${preview.id}/`);
      }
      if (current.length > 0) console.log(`removed ${current.length} existing preview(s)`);
    } else if (current.length >= PREVIEWS.length) {
      console.log(`all ${PREVIEWS.length} previews already on the listing; nothing to do`);
    } else if (current.length > 0) {
      console.log(`resuming: ${current.length} of ${PREVIEWS.length} previews already uploaded`);
    }

    // Resume assumes the existing previews are this list's leading entries — true because
    // they only ever got there from this script, in this order. --replace is the escape
    // hatch if the listing was ever edited by hand.
    const from = replace ? 0 : current.length;
    for (const [position, name] of PREVIEWS.entries()) {
      if (position < from) continue;
      const body = new FormData();
      body.set("image", await imageField(name));
      body.set("position", String(position));
      await call(issuer, secret, "POST", `/addons/addon/${ADDON}/previews/`, body);
      console.log(`preview ${position} uploaded: ${name}`);
    }
  }

  console.log(`\nhttps://addons.mozilla.org/en-US/firefox/addon/${ADDON}/`);
}

await main();
