import { test } from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pollUntil, isTransientReadError } from "./helpers/polling.mjs";
import { withFakeFFmpeg } from "./helpers/fake-ffmpeg.mjs";

const __filename = fileURLToPath(import.meta.url);
const CLI = path.join(
  path.dirname(__filename),
  "..",
  "src",
  "timelapse-capture.mjs",
);

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

async function pollStatus(
  runDir,
  predicate,
  { timeoutMs = 5000, intervalMs = 50 } = {},
) {
  return pollUntil(
    async () => {
      const result = runCli(["status", runDir, "--json"]);
      if (result.status !== 0) {
        throw new Error(result.stderr || "status command failed");
      }
      return JSON.parse(result.stdout);
    },
    (payload) => predicate(payload.status),
    {
      timeoutMs,
      intervalMs,
      onError: isTransientReadError,
      timeoutMessage: "Timed out waiting for status",
      describeLastValue: (payload) => JSON.stringify(payload),
    },
  );
}

async function pollJob(
  runDir,
  predicate,
  { timeoutMs = 5000, intervalMs = 50 } = {},
) {
  return pollUntil(
    async () =>
      JSON.parse(await fs.readFile(path.join(runDir, "job.json"), "utf8")),
    (job) => predicate(job),
    {
      timeoutMs,
      intervalMs,
      onError: isTransientReadError,
      timeoutMessage: "Timed out waiting for job metadata",
      describeLastValue: (job) => JSON.stringify(job),
    },
  );
}

test("start detaches a background capture child and status observes progress", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "tlc-background-"));
  try {
    await withFakeFFmpeg(async (manager) => {
      const result = runCli(
        [
          "start",
          "http://example.test/",
          "--duration",
          "1s",
          "--interval",
          "250ms",
          "--out",
          runDir,
          "--json",
        ],
        {
          TIMELAPSE_SIMULATE_FRAMES: "4",
          TIMELAPSE_SIMULATE_FRAME_DELAY_MS: "500",
          PATH: manager.getPATHEnv(),
        },
      );

      assert.equal(result.status, 0, result.stderr);

      const startPayload = JSON.parse(result.stdout);
      assert.equal(startPayload.runDir, runDir);
      assert.equal(startPayload.status.state, "starting");

      const job = JSON.parse(
        await fs.readFile(path.join(runDir, "job.json"), "utf8"),
      );
      assert.equal(typeof job.pid, "number");
      assert.ok(job.pid > 0);
      assert.deepEqual(job.command.slice(-3), ["capture", "--run", runDir]);
      assert.equal(job.detached, true);

      await pollStatus(
        runDir,
        (status) =>
          status.state === "running" &&
          status.frames.captured > 0 &&
          status.frames.captured < status.frames.totalExpected,
      );

      const rendered = await pollStatus(
        runDir,
        (status) => status.state === "rendered",
        { timeoutMs: 12000 },
      );
      assert.equal(rendered.status.frames.failed, 0);
      assert.ok(fsSync.existsSync(path.join(runDir, "output.mp4")));
      await pollJob(runDir, (current) => current.state === "completed");
    }, "success");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("stop signals graceful exit and capture proceeds to auto-render", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "tlc-stop-graceful-"));
  try {
    await withFakeFFmpeg(async (manager) => {
      // Start an indefinite run (no --duration) so the loop wouldn't terminate
      // on its own within the test window.
      const result = runCli(
        ["start", "http://example.test/", "--out", runDir, "--json"],
        {
          TIMELAPSE_SIMULATE_FRAMES: "10000",
          TIMELAPSE_SIMULATE_FRAME_DELAY_MS: "100",
          PATH: manager.getPATHEnv(),
        },
      );
      assert.equal(result.status, 0, result.stderr);
      const startPayload = JSON.parse(result.stdout);
      assert.equal(startPayload.runDir, runDir);

      await pollStatus(
        runDir,
        (status) => status.state === "running" && status.frames.captured >= 2,
      );

      const stop = runCli(["stop", runDir, "--json"]);
      assert.equal(stop.status, 0, stop.stderr);

      const rendered = await pollStatus(
        runDir,
        (status) => status.state === "rendered",
        { timeoutMs: 12000 },
      );
      assert.ok(rendered.status.frames.captured >= 1);
      assert.ok(fsSync.existsSync(path.join(runDir, "output.mp4")));
      await pollJob(runDir, (current) => current.state === "completed");
    }, "success");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("capture --run validates missing run directories", () => {
  const missing = path.join(
    os.tmpdir(),
    `tlc-missing-${process.pid}-${Date.now()}`,
  );
  const result = runCli(["capture", "--run", missing]);
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    new RegExp(
      `No run directory at ${missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    ),
  );
});
