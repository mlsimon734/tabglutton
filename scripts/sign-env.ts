import { existsSync, readFileSync } from "node:fs";

const ENV_FILE = ".env";

/** Parse `.env` into `process.env`. Every store credential this repo holds lives there. */
export function loadEnv() {
  if (!existsSync(ENV_FILE)) {
    console.error(`Missing ${ENV_FILE}. Create it from .env.sample with your store credentials.`);
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
}

/** Read `keys` back in order, naming every missing one at once rather than the first. */
export function requireEnv(...keys: string[]): string[] {
  const missing = keys.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(`${ENV_FILE} is missing ${missing.join(", ")}.`);
    process.exit(1);
  }
  return keys.map((key) => process.env[key] as string);
}

export function loadSigningEnv() {
  loadEnv();
  requireEnv("WEB_EXT_API_KEY", "WEB_EXT_API_SECRET");
}
