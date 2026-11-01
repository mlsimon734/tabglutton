import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { md5Hex } from "../src/md5.js";

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("md5Hex()", () => {
  // RFC 1321 §A.5, the reference implementation's test suite.
  test.each([
    ["", "d41d8cd98f00b204e9800998ecf8427e"],
    ["a", "0cc175b9c0f1b6a831c399e269772661"],
    ["abc", "900150983cd24fb0d6963f7d28e17f72"],
    ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
    ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
    [
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
      "d174ab98d277d9f5a5611c2c9f419d9f",
    ],
    [
      "12345678901234567890123456789012345678901234567890123456789012345678901234567890",
      "57edf4a22be3c955ac49da2e2107b67a",
    ],
  ])("RFC 1321 vector %j", (input, digest) => {
    expect(md5Hex(text(input))).toBe(digest);
  });

  // The padding boundaries are where a hand-written MD5 goes wrong: 55 bytes
  // still fits the length in one block, 56 needs a second, 64 fills one exactly.
  test.each([55, 56, 63, 64, 65, 119, 120, 1000])("matches node:crypto at %i bytes", (n) => {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff);
    expect(md5Hex(bytes)).toBe(createHash("md5").update(bytes).digest("hex"));
  });

  test("matches node:crypto on a PDF-sized buffer", () => {
    const bytes = Uint8Array.from({ length: 300_001 }, (_, i) => (i * 2654435761) >>> 24);
    expect(md5Hex(bytes)).toBe(createHash("md5").update(bytes).digest("hex"));
  });
});
