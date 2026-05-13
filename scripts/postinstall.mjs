#!/usr/bin/env node
import { execSync } from "node:child_process";

// Only run automatically during global installs; skip in local dev and CI.
if (process.env.npm_config_global !== "true" || process.env.CI) {
  process.exit(0);
}

console.log("\ntimelapse-capture: installing Playwright Chromium…\n");

try {
  execSync("npx playwright install chromium", { stdio: "inherit" });
} catch {
  console.error("\nPlaywright Chromium install failed. Run manually:");
  console.error("  npx playwright install chromium\n");
}

function hasCmd(cmd) {
  const check = process.platform === "win32" ? `where ${cmd}` : `which ${cmd}`;
  try {
    execSync(check, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (!hasCmd("ffmpeg") || !hasCmd("ffprobe")) {
  const fix =
    process.platform === "darwin"
      ? "brew install ffmpeg"
      : process.platform === "linux"
        ? "sudo apt-get install ffmpeg"
        : "https://ffmpeg.org/download.html";
  console.log("\nffmpeg/ffprobe not found — required for render:");
  console.log(`  ${fix}`);
  console.log("\nRun `timelapse-capture doctor` after installing.\n");
}
