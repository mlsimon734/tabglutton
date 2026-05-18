import { existsSync, readFileSync } from "node:fs";

const ENV_FILE = ".env";

export function loadSigningEnv() {
  if (!existsSync(ENV_FILE)) {
    console.error(`Missing ${ENV_FILE}. Create it from .env.sample with your AMO credentials.`);
    process.exit(1);
  }

  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[m[1]] = value;
  }

  if (!process.env.WEB_EXT_API_KEY || !process.env.WEB_EXT_API_SECRET) {
    console.error(`${ENV_FILE} is missing WEB_EXT_API_KEY or WEB_EXT_API_SECRET.`);
    process.exit(1);
  }
}
