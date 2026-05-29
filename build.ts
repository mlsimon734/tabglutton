#!/usr/bin/env bun
import { rmSync, mkdirSync, cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { $ } from "bun";

type Target = "firefox" | "chrome";

const VALID_TARGETS: ReadonlyArray<Target> = ["firefox", "chrome"];

// Scratch dir (under each dist) for generated Chrome bundle entries; removed
// after the Chrome bundles are built.
const CHROME_BUILD_DIR = ".chrome-build";

function parseTargets(argv: ReadonlyArray<string>): Target[] {
  if (argv.includes("--target")) {
    console.error("[build] use --target=<value> (with =), e.g. --target=chrome");
    process.exit(1);
  }
  const flag = argv.find((a) => a.startsWith("--target="));
  const value = flag?.split("=")[1] ?? "firefox";
  if (value === "all") return [...VALID_TARGETS];
  if (!VALID_TARGETS.includes(value as Target)) {
    console.error(`[build] unknown --target=${value}; expected one of: firefox, chrome, all`);
    process.exit(1);
  }
  return [value as Target];
}

const targets = parseTargets(Bun.argv);

for (const target of targets) {
  await buildOne(target);
}

console.log(`[build] done (${targets.join(", ")})`);

async function buildOne(target: Target): Promise<void> {
  const DIST = `dist-${target}`;
  console.log(`[build] ${target} → ${DIST}/`);

  if (existsSync(DIST)) rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  await $`bunx tsc --outDir ${DIST}`;

  // Chrome: overwrite the compiled target.js so IS_CHROME is true at runtime
  // without ever mutating the checked-in source.
  if (target === "chrome") {
    writeFileSync(
      `${DIST}/src/target.js`,
      `export const TARGET = "chrome";\nexport const IS_CHROME = true;\nexport const IS_FIREFOX = false;\n`,
    );
  }

  // Chrome bundles get `browser` from a generated polyfill-global module
  // (see writePolyfillGlobal); each entry below imports it ahead of app code.
  if (target === "chrome") writePolyfillGlobal(DIST);

  const clipEntry =
    target === "chrome"
      ? chromeBundleEntry(DIST, "clip-current", "../src/clip-current.js")
      : "src/clip-current.ts";
  const clipBuild = await Bun.build({
    entrypoints: [clipEntry],
    outdir: `${DIST}/src`,
    target: "browser",
    format: "iife",
    minify: true,
    sourcemap: "external",
  });
  if (!clipBuild.success) {
    for (const log of clipBuild.logs) console.error(log);
    process.exit(1);
  }

  // clip-current.js is injected as a content script via
  // scripting.executeScript({files}); Chrome rejects unsafe code points in it
  // (see escapeChromeUnsafeCodePoints). Firefox doesn't, but the escape is a
  // no-op for valid content so we apply it to both builds.
  const clipJsPath = `${DIST}/src/clip-current.js`;
  writeFileSync(clipJsPath, escapeChromeUnsafeCodePoints(readFileSync(clipJsPath, "utf8")));

  const onboardingEntry =
    target === "chrome"
      ? chromeBundleEntry(DIST, "onboarding", "../onboarding/onboarding.js")
      : undefined;
  const onboardingBuild = await Bun.build({
    entrypoints: [onboardingEntry ?? "onboarding/onboarding.ts"],
    outdir: `${DIST}/onboarding`,
    target: "browser",
    format: "esm",
    minify: true,
    sourcemap: "external",
  });
  if (!onboardingBuild.success) {
    for (const log of onboardingBuild.logs) console.error(log);
    process.exit(1);
  }

  // Chrome: bundle the service worker into a single ESM file so the polyfill
  // resolves via node_modules and we sidestep MV3 SW module-resolution quirks.
  if (target === "chrome") {
    const backgroundEntry = chromeBundleEntry(DIST, "background", "../src/background.js");
    const swBuild = await Bun.build({
      entrypoints: [backgroundEntry],
      outdir: `${DIST}/src`,
      target: "browser",
      format: "esm",
      minify: true,
      sourcemap: "external",
    });
    if (!swBuild.success) {
      for (const log of swBuild.logs) console.error(log);
      process.exit(1);
    }
    rmSync(`${DIST}/${CHROME_BUILD_DIR}`, { recursive: true, force: true });
  }

  writeManifest(target, DIST);

  cpSync("icons", `${DIST}/icons`, { recursive: true });

  mkdirSync(`${DIST}/popup`, { recursive: true });
  cpSync("popup/popup.html", `${DIST}/popup/popup.html`);
  cpSync("popup/popup.css", `${DIST}/popup/popup.css`);
  cpSync("popup/devour.html", `${DIST}/popup/devour.html`);
  cpSync("popup/devour.css", `${DIST}/popup/devour.css`);
  cpSync("popup/tokens.css", `${DIST}/popup/tokens.css`);
  cpSync("popup/fonts", `${DIST}/popup/fonts`, { recursive: true });

  mkdirSync(`${DIST}/options`, { recursive: true });
  cpSync("options/options.html", `${DIST}/options/options.html`);
  cpSync("options/options.css", `${DIST}/options/options.css`);

  cpSync("onboarding/onboarding.html", `${DIST}/onboarding/onboarding.html`);
  cpSync("onboarding/onboarding.css", `${DIST}/onboarding/onboarding.css`);

  // obsidian-redirect.{html,js} — the extension-origin launch page used by
  // openObsidianUrl on Chrome. The .js is emitted by tsc; copy the HTML shell.
  mkdirSync(`${DIST}/redirect`, { recursive: true });
  cpSync("redirect/obsidian-redirect.html", `${DIST}/redirect/obsidian-redirect.html`);

  mkdirSync(`${DIST}/THIRD_PARTY_LICENSES`, { recursive: true });
  cpSync("node_modules/defuddle/LICENSE", `${DIST}/THIRD_PARTY_LICENSES/defuddle-LICENSE.txt`);

  if (target === "chrome") {
    mkdirSync(`${DIST}/vendor`, { recursive: true });
    cpSync(
      "node_modules/webextension-polyfill/dist/browser-polyfill.min.js",
      `${DIST}/vendor/browser-polyfill.js`,
    );
    cpSync(
      "node_modules/webextension-polyfill/LICENSE",
      `${DIST}/THIRD_PARTY_LICENSES/webextension-polyfill-LICENSE.txt`,
    );
    injectPolyfillScript(`${DIST}/popup/popup.html`);
    injectPolyfillScript(`${DIST}/popup/devour.html`);
    injectPolyfillScript(`${DIST}/options/options.html`);
  }
}

// Chrome validates injected content-script files with base::IsStringUTF8,
// which — unlike plain UTF-8 validity — rejects Unicode noncharacters
// (U+FDD0–FDEF, U+FFFE/U+FFFF and their per-plane twins) and unpaired
// surrogates, reporting "It isn't UTF-8 encoded." The minifier can emit such a
// char raw (e.g. a U+FFFF upper bound in a Defuddle regex range). Escape ONLY
// those code points to \uXXXX — they only ever occur in string/regex literals,
// never identifiers, so the escape is always legal. Ordinary non-ASCII
// (accented letters, CJK, valid surrogate pairs used as object keys) is left
// raw, since escaping a surrogate pair would be an illegal identifier escape.
function escapeChromeUnsafeCodePoints(src: string): string {
  const esc = (u: number): string => `\\u${u.toString(16).padStart(4, "0")}`;
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    const isHigh = c >= 0xd800 && c <= 0xdbff;
    if (isHigh && i + 1 < src.length) {
      const lo = src.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        const cp = (c - 0xd800) * 0x400 + (lo - 0xdc00) + 0x10000;
        // Valid surrogate pair: leave raw unless it encodes an astral noncharacter.
        out += (cp & 0xfffe) === 0xfffe ? esc(c) + esc(lo) : src.charAt(i) + src.charAt(i + 1);
        i++;
        continue;
      }
    }
    const isSurrogate = c >= 0xd800 && c <= 0xdfff; // here: unpaired
    const isNoncharacter = (c >= 0xfdd0 && c <= 0xfdef) || (c & 0xfffe) === 0xfffe;
    out += isSurrogate || isNoncharacter ? esc(c) : src.charAt(i);
  }
  return out;
}

// Write the generated module that publishes the polyfill as the global
// `browser` for the Chrome bundles. We can't rely on a side-effect
// `import "webextension-polyfill"`: the bundler routes the polyfill's UMD
// through its CommonJS branch (Bun synthesizes `exports`/`module`), which sets
// the module's exports but NEVER assigns the global `browser` that every
// `browser.*` call site reads. So bind the default export and assign it here.
// This lives in its own module, imported first by each entry, so the
// assignment runs before any app code is evaluated. Firefox doesn't use this —
// it has a native `browser` and ships these modules unbundled.
function writePolyfillGlobal(dist: string): void {
  const dir = `${dist}/${CHROME_BUILD_DIR}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    `${dir}/_polyfill-global.js`,
    `import browser from "webextension-polyfill";\nglobalThis.browser = browser;\n`,
  );
}

// Generate a Chrome bundle entry that loads the polyfill global first, then the
// app module. `importPath` is relative to the .chrome-build dir. Requires
// writePolyfillGlobal(dist) to have run first.
function chromeBundleEntry(dist: string, name: string, importPath: string): string {
  const dir = `${dist}/${CHROME_BUILD_DIR}`;
  mkdirSync(dir, { recursive: true });
  const entryPath = `${dir}/${name}.js`;
  writeFileSync(entryPath, `import "./_polyfill-global.js";\nimport "${importPath}";\n`);
  return entryPath;
}

function writeManifest(target: Target, dist: string): void {
  const raw = JSON.parse(readFileSync("manifest.json", "utf8")) as Record<string, unknown>;
  if (target === "chrome") {
    delete raw.browser_specific_settings;
    raw.background = { service_worker: "src/background.js", type: "module" };
    const action = raw.action as Record<string, unknown> | undefined;
    if (action) {
      action.default_icon = {
        "16": "icons/icon-chomp-16.png",
        "32": "icons/icon-chomp-32.png",
      };
    }
    raw.icons = {
      "16": "icons/icon-chomp-16.png",
      "32": "icons/icon-chomp-32.png",
      "48": "icons/icon-chomp-48.png",
      "128": "icons/icon-chomp-128.png",
    };
    raw.minimum_chrome_version = "116";
  }
  writeFileSync(`${dist}/manifest.json`, `${JSON.stringify(raw, null, 2)}\n`);
}

// Inject `<script src="${prefix}/vendor/browser-polyfill.js"></script>` immediately
// before the existing `<script type="module" ...>` tag. The plain script runs
// synchronously before the deferred module, so `browser.*` is defined by the
// time the page's module entry executes.
function injectPolyfillScript(htmlPath: string, prefix = ".."): void {
  const html = readFileSync(htmlPath, "utf8");
  const polyfillTag = `<script src="${prefix}/vendor/browser-polyfill.js"></script>`;
  if (html.includes(polyfillTag)) return;
  const moduleScriptRegex = /(\s*)(<script type="module"[^>]*><\/script>)/;
  const updated = html.replace(moduleScriptRegex, (_match, indent, tag) => {
    return `${indent}${polyfillTag}${indent}${tag}`;
  });
  if (updated === html) {
    console.error(
      `[build] could not find a <script type="module"> tag to inject the polyfill before in ${htmlPath}; ` +
        "the Chrome page would load with `browser` undefined. Failing the build.",
    );
    process.exit(1);
  }
  writeFileSync(htmlPath, updated);
}
