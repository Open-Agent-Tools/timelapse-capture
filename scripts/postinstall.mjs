#!/usr/bin/env node

import { execFileSync } from "node:child_process";

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    stdio: options.stdio || "ignore",
    shell: options.shell || false,
  });
}

function shouldInstallChromium() {
  return (
    process.env.CI !== "true" &&
    process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD !== "1" &&
    process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD !== "true" &&
    process.env.TIMELAPSE_SKIP_BROWSER_INSTALL !== "1"
  );
}

function installChromium() {
  if (!shouldInstallChromium()) return;

  try {
    run("npx", ["playwright", "install", "chromium"], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
  } catch (error) {
    console.error(
      `Failed to install Playwright Chromium: ${error?.message || String(error)}`,
    );
    console.error("Run: npx playwright install chromium");
    process.exitCode = 1;
  }
}

installChromium();
