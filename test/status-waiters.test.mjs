import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCli } from "./helpers/cli.mjs";
import {
  waitForCompletedStatus,
  waitForFailedStatus,
  waitForTerminalStatus,
} from "./helpers/status-waiters.mjs";

const tempDirs = [];

after(async () => {
  await Promise.all(
    tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function makeRunDir(prefix = "tlc-status-waiters-") {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(runDir);
  return runDir;
}

async function writeJson(runDir, name, value) {
  await fs.writeFile(
    path.join(runDir, name),
    JSON.stringify(value, null, 2),
    "utf8",
  );
}

test("waitForCompletedStatus waits for completed status and job state", async () => {
  const runDir = await makeRunDir();
  const pendingStatus = {
    state: "running",
    frames: { captured: 1, failed: 0, skipped: 0, attempted: 1 },
  };
  const completedStatus = {
    state: "completed",
    frames: { captured: 2, failed: 0, skipped: 0, attempted: 2 },
  };
  await writeJson(runDir, "status.json", pendingStatus);
  await writeJson(runDir, "job.json", { state: "running" });

  const waiter = waitForCompletedStatus(runDir, { timeoutMs: 500 });
  setTimeout(async () => {
    await writeJson(runDir, "status.json", completedStatus);
    await writeJson(runDir, "job.json", { state: "completed" });
  }, 40);

  const status = await waiter;
  assert.equal(status.state, "completed");
  assert.equal(status.frames.captured, 2);
});

test("waitForFailedStatus resolves when status.json reaches failed", async () => {
  const runDir = await makeRunDir();
  await writeJson(runDir, "status.json", { state: "running" });

  const waiter = waitForFailedStatus(runDir, { timeoutMs: 500 });
  setTimeout(async () => {
    await writeJson(runDir, "status.json", {
      state: "failed",
      error: "navigation failed",
    });
  }, 40);

  const status = await waiter;
  assert.equal(status.state, "failed");
  assert.match(status.error, /navigation failed/);
});

test("waitForTerminalStatus waits for expected captured, failed, and skipped attempts", async () => {
  const runDir = await makeRunDir();
  await writeJson(runDir, "status.json", {
    state: "running",
    frames: { captured: 1, failed: 1, skipped: 0, attempted: 2 },
  });
  await writeJson(runDir, "job.json", { state: "running" });

  const waiter = waitForTerminalStatus(runDir, {
    expectedAttempts: 3,
    timeoutMs: 500,
  });
  setTimeout(async () => {
    await writeJson(runDir, "status.json", {
      state: "completed",
      frames: { captured: 1, failed: 1, skipped: 1, attempted: 3 },
    });
    await writeJson(runDir, "job.json", { state: "completed" });
  }, 40);

  const status = await waiter;
  assert.equal(status.state, "completed");
  assert.equal(status.frames.skipped, 1);
});

test("runCli uses the shared CLI entrypoint", async () => {
  const missingRunDir = path.join(
    await makeRunDir("tlc-status-waiters-missing-"),
    "missing",
  );

  const result = runCli(["status", missingRunDir]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /run directory not found/i);
});
