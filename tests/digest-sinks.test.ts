import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Agent-written digest text reaches these pages. They render it through
// `textContent` and `createElement` only; an HTML sink in any of them would be
// one refactor away from executing a hostile page's markup. Comments are
// stripped first so the reason for the rule can be written down beside it.
const SINKS =
  /\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment)\b/;
const FILES = ["popup/digest-panel.ts", "popup/devour.ts", "popup/popup.ts"];

function code(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("pages that render digests use no HTML sinks", () => {
  for (const file of FILES) {
    test(file, () => {
      expect(code(file)).not.toMatch(SINKS);
    });
  }

  test("no link is built from agent text", () => {
    expect(code("popup/digest-panel.ts")).not.toMatch(
      /\.href\s*=|createElement\(\s*"a"|el\(\s*"a"/,
    );
  });
});
