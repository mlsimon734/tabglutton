// Connection fixtures shared by the sidecar tests. Kept in one place so a
// change to ConnectionSummary lands once rather than in every test file.

import type { ConnectionSummary } from "../src/select.js";

export const EXT_VERSION = "0.1.2.1";

export const zen: ConnectionSummary = {
  connectionId: "conn-1",
  browser: "firefox",
  label: "Zen",
  extVersion: EXT_VERSION,
};

export const chrome: ConnectionSummary = {
  connectionId: "conn-2",
  browser: "chrome",
  label: "Chrome",
  extVersion: EXT_VERSION,
};
