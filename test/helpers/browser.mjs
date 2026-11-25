import fsSync from "node:fs";

let cachedReason;

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
