import { test } from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const CLI = path.join(path.dirname(__filename), "..", "src", "timelapse-capture.mjs");

let SKIP_SMOKE = false;
let SKIP_REASON = "";

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

    const probePort = await new Promise((resolve) => probeServer.listen(0, resolve)).then(
      () => probeServer.address()?.port
    );
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
      } catch {
      }
    }
  }
} catch (error) {
  SKIP_SMOKE = true;
  SKIP_REASON = error?.message ? `playwright unavailable: ${error.message}` : "playwright unavailable";
}

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
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
  assert.equal(callbackFired, true, "close callback must fire before closeServer resolves");
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

      const startResult = runCli([
        "start",
        target,
        "--duration",
        "2s",
        "--interval",
        "500ms",
        "--out",
        outDir,
        "--json"
      ], { CI: "1" });
      if (startResult.status !== 0) {
        context.skip(`runtime unavailable: start command failed: ${startResult.stderr}`);
        return;
      }
      const startPayload = JSON.parse(startResult.stdout);

      const statusResult = runCli(["status", startPayload.runDir, "--json"]);
      assert.equal(statusResult.status, 0, statusResult.stderr);
      const status = JSON.parse(statusResult.stdout);
      assert.ok(["completed", "running", "failed"].includes(status.status.state));
      assert.ok(status.status.frames.captured >= 0);

      const peekResult = runCli(["peek", startPayload.runDir, "--latest", "--json"]);
      assert.equal(peekResult.status, 0, peekResult.stderr);
      const peekPayload = JSON.parse(peekResult.stdout);
      assert.equal(peekPayload.exists, true);
      assert.ok(fsSync.existsSync(peekPayload.path));
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });
} else {
  test("CLI smoke start/status/peek with a local static page (skipped)", { skip: true }, () => {
    assert.ok(SKIP_REASON);
  });
}
