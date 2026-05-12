import { execFileSync as nodeExecFileSync } from "node:child_process";
import { createRequire } from "node:module";

const MIN_NODE_VERSION = "20.0.0";
const localRequire = createRequire(import.meta.url);

function checkResult({
  name,
  status,
  message,
  details = {},
  error = null,
  fix = null,
}) {
  return { name, status, message, details, error, fix };
}

function normalizeCheckResult(check) {
  const raw = check || {};
  return {
    name: typeof raw.name === "string" && raw.name ? raw.name : "unknown",
    status:
      raw.status === "pass" || raw.status === "fail" ? raw.status : "fail",
    message:
      typeof raw.message === "string" && raw.message
        ? raw.message
        : "check returned no message",
    details: raw.details ?? {},
    error: raw.error ?? null,
    fix: raw.fix ?? null,
  };
}

export function compareVersions(actual, minimum) {
  const actualParts = String(actual)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const minimumParts = String(minimum)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(actualParts.length, minimumParts.length);
  for (let index = 0; index < length; index += 1) {
    const a = actualParts[index] || 0;
    const m = minimumParts[index] || 0;
    if (a > m) return 1;
    if (a < m) return -1;
  }
  return 0;
}

export async function checkNode({ version = process.versions.node } = {}) {
  const details = {
    version,
    minimumVersion: MIN_NODE_VERSION,
    executable: process.execPath,
  };

  if (compareVersions(version, MIN_NODE_VERSION) >= 0) {
    return checkResult({
      name: "node",
      status: "pass",
      message: `Node.js ${version} satisfies >= ${MIN_NODE_VERSION}`,
      details,
    });
  }

  return checkResult({
    name: "node",
    status: "fail",
    message: `Node.js ${version} is below required version ${MIN_NODE_VERSION}`,
    details,
    error: "Node.js 20 or newer is required.",
    fix: "Install Node.js 20 or newer, then run doctor again.",
  });
}

export async function checkPlaywright({ requireFn = localRequire } = {}) {
  try {
    const resolvedPath = requireFn.resolve("playwright");
    requireFn("playwright");
    return checkResult({
      name: "playwright",
      status: "pass",
      message: "Playwright package can be imported",
      details: { resolvedPath },
    });
  } catch (error) {
    return checkResult({
      name: "playwright",
      status: "fail",
      message: "Playwright package cannot be imported",
      details: {},
      error: error?.message || String(error),
      fix: "Run npm install in this project. Do not rely on doctor to install dependencies.",
    });
  }
}

export async function checkChromium({ requireFn = localRequire } = {}) {
  let browser;
  let result;
  try {
    const { chromium } = requireFn("playwright");
    browser = await chromium.launch({ headless: true });
    result = checkResult({
      name: "chromium",
      status: "pass",
      message: "Chromium can be launched by Playwright",
      details: {},
    });
  } catch (error) {
    result = checkResult({
      name: "chromium",
      status: "fail",
      message: "Chromium cannot be launched by Playwright",
      details: {},
      error: error?.message || String(error),
      fix: "Run npx playwright install chromium, then run doctor again.",
    });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (error) {
        result = checkResult({
          name: "chromium",
          status: "fail",
          message: "Chromium launched but could not close cleanly",
          details: {},
          error: error?.message || String(error),
          fix: "Check for stuck browser processes, then run doctor again.",
        });
      }
    }
  }
  return result;
}

function parseBinaryVersion(binary, output) {
  const firstLine = String(output).split(/\r?\n/).find(Boolean) || "";
  const escaped = binary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = firstLine.match(
    new RegExp(`${escaped}\\s+version\\s+([^\\s]+)`, "i"),
  );
  return { version: match ? match[1] : null, firstLine };
}

export async function checkBinary(
  binary,
  { execFileSync = nodeExecFileSync } = {},
) {
  try {
    const stdout = execFileSync(binary, ["-version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    });
    const parsed = parseBinaryVersion(binary, stdout);
    return checkResult({
      name: binary,
      status: "pass",
      message: parsed.version
        ? `${binary} ${parsed.version} is available`
        : `${binary} is available`,
      details: parsed,
    });
  } catch (error) {
    const skipHint = `${binary} is missing from PATH; real tests and captures that require ${binary} should be skipped until it is installed`;
    return checkResult({
      name: binary,
      status: "fail",
      message: skipHint,
      details: {},
      error: `${binary} was not found or could not run: ${error?.message || String(error)}`,
      fix: `Install FFmpeg and ensure ${binary} is available on PATH.`,
    });
  }
}

export async function checkFfmpeg(options) {
  return checkBinary("ffmpeg", options);
}

export async function checkFfprobe(options) {
  return checkBinary("ffprobe", options);
}

export const DEFAULT_CHECKS = [
  checkNode,
  checkPlaywright,
  checkChromium,
  checkFfmpeg,
  checkFfprobe,
];

export async function runAllChecks({ checks } = {}) {
  const checkFns = checks || DEFAULT_CHECKS;
  const results = [];
  for (const check of checkFns) {
    results.push(normalizeCheckResult(await check()));
  }

  const summary = {
    pass: results.filter((result) => result.status === "pass").length,
    fail: results.filter((result) => result.status === "fail").length,
    total: results.length,
  };

  return {
    ok: summary.fail === 0,
    summary,
    checks: results,
    exitCode: summary.fail === 0 ? 0 : 1,
  };
}

export async function commandDoctor(options) {
  return runAllChecks(options);
}

export function formatDoctorHuman(result) {
  const lines = result.checks.flatMap((check) => {
    const status = check.status === "pass" ? "PASS" : "FAIL";
    const output = [`[${status}] ${check.name}: ${check.message}`];
    if (check.error) output.push(`  error: ${check.error}`);
    if (check.fix) output.push(`  fix: ${check.fix}`);
    return output;
  });

  lines.push(
    `summary: ${result.summary.pass} passed, ${result.summary.fail} failed, ${result.summary.total} total`,
  );
  return lines.join("\n");
}
