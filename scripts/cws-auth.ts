#!/usr/bin/env bun
// One-time helper: turn a Chrome Web Store OAuth client into a refresh token.
//
// Google retired `urn:ietf:wg:oauth:2.0:oob` in 2022, so the code cannot be copied off a
// success page any more — it has to come back over a redirect. A Desktop app client is the
// one type that accepts an unregistered loopback port, which is why the setup in
// docs/STORE.md 6 says Desktop app and not Web application.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { loadEnv, requireEnv } from "./sign-env.js";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/chromewebstore";
const CONSENT_TIMEOUT_MS = 5 * 60_000;

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

const b64url = (bytes: Buffer) => bytes.toString("base64url");

loadEnv();
const [clientId, clientSecret] = requireEnv("CWS_CLIENT_ID", "CWS_CLIENT_SECRET");

// PKCE. A Desktop app's client secret is shipped to users and is not a secret, so the
// verifier is what actually binds this code to this process.
const verifier = b64url(randomBytes(64));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const state = b64url(randomBytes(16));

let settle!: (code: string) => void;
let fail!: (error: Error) => void;
const redirected = new Promise<string>((resolve, reject) => {
  settle = resolve;
  fail = reject;
});

const page = (message: string) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>Tabglutton</title>` +
      `<body style="font:16px/1.5 system-ui;margin:4rem auto;max-width:32rem">${message}</body>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/") return new Response("Not found", { status: 404 });

    const error = url.searchParams.get("error");
    if (error) {
      fail(new Error(`Google refused the authorization: ${error}`));
      return page("Authorization was refused. Back to the terminal.");
    }
    // A stray request to the loopback port must not be able to feed us a code.
    if (url.searchParams.get("state") !== state) {
      return new Response("Unexpected state", { status: 400 });
    }
    const code = url.searchParams.get("code");
    if (!code) {
      fail(new Error("The redirect carried no authorization code."));
      return page("No authorization code in the redirect. Back to the terminal.");
    }
    settle(code);
    return page("Authorized. You can close this tab.");
  },
});

const redirectUri = `http://127.0.0.1:${server.port}/`;
const consentUrl = `${AUTH_ENDPOINT}?${new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: "code",
  scope: SCOPE,
  code_challenge: challenge,
  code_challenge_method: "S256",
  state,
  // Together these are what produce a refresh token at all: offline access asks for one,
  // and forcing the consent screen makes Google re-issue it on a repeat authorization
  // instead of returning an access token alone.
  access_type: "offline",
  prompt: "consent",
})}`;

console.log("Opening the Google consent screen. If it does not open, visit:\n");
console.log(`  ${consentUrl}\n`);
const opener = process.platform === "darwin" ? "open" : "xdg-open";
// ENOENT arrives as an unhandled 'error' event, which would kill the process and defeat
// the URL printed just above. An absent opener just means the user pastes it.
spawn(opener, [consentUrl], { stdio: "ignore", detached: true })
  .on("error", () => {})
  .unref();

const timer = setTimeout(
  () => fail(new Error(`No redirect arrived within ${CONSENT_TIMEOUT_MS / 1000}s.`)),
  CONSENT_TIMEOUT_MS,
);

let code: string;
try {
  code = await redirected;
} catch (error) {
  console.error(`\n${(error as Error).message}`);
  process.exit(1);
} finally {
  clearTimeout(timer);
  // Graceful, not `stop(true)`: the browser is still waiting on the response to the
  // redirect, and force-closing here resets that connection instead of rendering the
  // page that tells the user they are done. The token exchange below outlasts the flush,
  // and the explicit exit at the end covers a keep-alive connection holding the loop open.
  server.stop();
}

const response = await fetch(TOKEN_ENDPOINT, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  }),
});
const token = (await response.json()) as TokenResponse;

if (!response.ok || token.error) {
  console.error(`\nToken exchange failed (HTTP ${response.status}).`);
  console.error(`  ${token.error ?? "unknown error"}: ${token.error_description ?? ""}`.trimEnd());
  process.exit(1);
}
if (!token.refresh_token) {
  console.error(
    "\nGoogle returned an access token but no refresh token. That happens when the client" +
      "\nalready holds a live grant; revoke Tabglutton at https://myaccount.google.com/permissions" +
      "\nand run this again.",
  );
  process.exit(1);
}

console.log("\n✓ Refresh token:\n");
console.log(`  ${token.refresh_token}\n`);
console.log("Paste it into .env as:\n");
console.log(`  CWS_REFRESH_TOKEN=${token.refresh_token}\n`);
console.log(".env is gitignored. The token stops working after six months unused.");
process.exit(0);
