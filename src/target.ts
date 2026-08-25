// Build target sentinel. The source value is always "firefox" so the
// typechecker and Firefox build stay stable; build.ts overwrites the
// compiled dist-chrome/src/target.js with the chrome variant.
export type BuildTarget = "firefox" | "chrome";
export const TARGET: BuildTarget = "firefox";
export const IS_CHROME = (TARGET as string) === "chrome";
export const IS_FIREFOX = (TARGET as string) === "firefox";
