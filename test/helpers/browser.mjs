import fsSync from "node:fs";

let cachedReason;

// Returns a non-empty skip reason when browser-dependent tests should be
// skipped, or false when a real Chromium is available and they should run.
// (node:test treats `{ skip: null }` as skipped, so the run case must be a
// falsy non-null value — false — not null.)
//
// CI environments (and other hosts without a usable browser) set
// TIMELAPSE_SKIP_BROWSER_TESTS=1 to skip explicitly; otherwise we fall back to
// probing whether Playwright's Chromium executable is actually present on disk.
// The result is cached so each test file resolves it at most once.
export async function browserTestSkip() {
  if (cachedReason !== undefined) return cachedReason;

  if (process.env.TIMELAPSE_SKIP_BROWSER_TESTS === "1") {
    cachedReason =
      "TIMELAPSE_SKIP_BROWSER_TESTS=1 (browser-dependent tests disabled in this environment)";
    return cachedReason;
  }

  try {
    const playwright = await import("playwright");
    const executablePath = playwright.chromium.executablePath();
    cachedReason =
      executablePath && fsSync.existsSync(executablePath)
        ? false
        : "Chromium executable is not available";
  } catch (error) {
    cachedReason = `playwright unavailable: ${error?.message || String(error)}`;
  }

  return cachedReason;
}
