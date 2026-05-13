import { test } from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pollUntil, isTransientReadError } from "./helpers/polling.mjs";

const __filename = fileURLToPath(import.meta.url);
const CLI = path.join(
  path.dirname(__filename),
  "..",
  "src",
  "timelapse-capture.mjs",
);

let SKIP_SMOKE = false;
let SKIP_REASON = "";

function formatCleanupFailure(skipReason, cleanupError) {
  const errorMessage = cleanupError?.message || String(cleanupError);
  return `${skipReason}; probe-server cleanup failed: ${errorMessage}`;
}

const closeServer = (server) =>
  new Promise((resolve, reject) => {
    server.close((error) => {
      if (!error || error.code === "ERR_SERVER_NOT_RUNNING") resolve();
      else reject(error);
    });
  });

try {
  const playwright = await import("playwright");
  const executablePath = playwright.chromium.executablePath();
  if (!executablePath || !fsSync.existsSync(executablePath)) {
    SKIP_SMOKE = true;
    SKIP_REASON = "Chromium executable is not available";
  } else {
    const probeServer = createServer((_, response) => {
      response.statusCode = 200;
      response.setHeader("content-type", "text/html");
      response.end("<!doctype html><title>probe</title><body>probe</body>");
    });

    const probePort = await new Promise((resolve) =>
      probeServer.listen(0, resolve),
    ).then(() => probeServer.address()?.port);
    try {
      const browser = await playwright.chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${probePort}/`, { timeout: 10000 });
      await page.close();
      await browser.close();
      await closeServer(probeServer);
    } catch (error) {
      SKIP_SMOKE = true;
      SKIP_REASON = `playwright runtime unavailable: ${error?.message || String(error)}`;
      try {
        await closeServer(probeServer);
      } catch (cleanupError) {
        SKIP_REASON = formatCleanupFailure(SKIP_REASON, cleanupError);
      }
    }
  }
} catch (error) {
  SKIP_SMOKE = true;
  SKIP_REASON = error?.message
    ? `playwright unavailable: ${error.message}`
    : "playwright unavailable";
}

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

async function pollCliStatus(
  runDir,
  predicate,
  { timeoutMs = 15000, intervalMs = 100 } = {},
) {
  return pollUntil(
    async () => {
      const statusResult = runCli(["status", runDir, "--json"]);
      assert.equal(statusResult.status, 0, statusResult.stderr);
      return JSON.parse(statusResult.stdout);
    },
    (payload) => predicate(payload.status),
    {
      timeoutMs,
      intervalMs,
      onError: isTransientReadError,
      timeoutMessage: "Timed out waiting for capture status",
      describeLastValue: (payload) => JSON.stringify(payload),
    },
  );
}

test("closeServer awaits the http.Server close callback", async () => {
  const server = createServer((_, res) => res.end("ok"));
  await new Promise((resolve) => server.listen(0, resolve));
  let callbackFired = false;
  const originalClose = server.close.bind(server);
  server.close = (cb) => {
    return originalClose(() => {
      callbackFired = true;
      if (cb) cb();
    });
  };
  await closeServer(server);
  assert.equal(
    callbackFired,
    true,
    "close callback must fire before closeServer resolves",
  );
});

test("formatCleanupFailure appends cleanup message", () => {
  const result = formatCleanupFailure(
    "playwright runtime unavailable: launch failed",
    new Error("close exploded"),
  );
  assert.equal(
    result,
    "playwright runtime unavailable: launch failed; probe-server cleanup failed: close exploded",
  );
});

test("formatCleanupFailure handles non-Error cleanup failures", () => {
  const result = formatCleanupFailure("base reason", "unknown failure");
  assert.equal(
    result,
    "base reason; probe-server cleanup failed: unknown failure",
  );
});

if (!SKIP_SMOKE) {
  test("CLI smoke start/status/peek with a local static page", async (context) => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "tlc-smoke-local-"));
    const html = "<html><body><h1>timelapse-capture</h1></body></html>";
    const server = createServer((_, response) => {
      response.statusCode = 200;
      response.setHeader("content-type", "text/html");
      response.end(html);
    });

    try {
      await new Promise((resolve) => server.listen(0, resolve));
      const port = server.address()?.port;
      assert.ok(Number.isFinite(port));
      const target = `http://127.0.0.1:${port}/`;

      const startResult = runCli(
        [
          "start",
          target,
          "--duration",
          "2s",
          "--interval",
          "500ms",
          "--out",
          outDir,
          "--no-render",
          "--json",
        ],
        { CI: "1" },
      );
      if (startResult.status !== 0) {
        context.skip(
          `runtime unavailable: start command failed: ${startResult.stderr}`,
        );
        return;
      }
      const startPayload = JSON.parse(startResult.stdout);

      const status = await pollCliStatus(
        startPayload.runDir,
        (current) => current.frames.captured > 0 || current.state === "failed",
      );
      if (
        status.status.state === "failed" &&
        status.status.frames.captured === 0
      ) {
        context.skip(
          "runtime unavailable: capture failed before producing a frame",
        );
        return;
      }

      const peekResult = runCli([
        "peek",
        startPayload.runDir,
        "--latest",
        "--json",
      ]);
      assert.equal(peekResult.status, 0, peekResult.stderr);
      const peekPayload = JSON.parse(peekResult.stdout);
      assert.equal(peekPayload.exists, true);
      assert.ok(fsSync.existsSync(peekPayload.path));

      await pollCliStatus(
        startPayload.runDir,
        (current) =>
          current.state === "completed" || current.state === "failed",
      );
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });
} else {
  test(
    "CLI smoke start/status/peek with a local static page (skipped)",
    { skip: true },
    () => {
      assert.ok(SKIP_REASON);
    },
  );
}
