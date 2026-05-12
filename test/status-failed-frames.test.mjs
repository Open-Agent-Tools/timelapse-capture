import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const CLI = path.join(path.dirname(__filename), "..", "src", "timelapse-capture.mjs");

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForCompletedStatus(runDir, { timeoutMs = 5000 } = {}) {
  const started = Date.now();
  let status;
  while (Date.now() - started < timeoutMs) {
    status = JSON.parse(await fs.readFile(path.join(runDir, "status.json"), "utf8"));
    const job = JSON.parse(await fs.readFile(path.join(runDir, "job.json"), "utf8"));
    if (status.state === "completed" && job.state === "completed") {
      return status;
    }
    await sleep(25);
  }
  assert.fail(`Timed out waiting for completed status. Last status: ${JSON.stringify(status)}`);
}

test("failed frame attempts preserve prior successful latestFrame", async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "tlc-status-failed-"));
  try {
    const result = runCli(
      ["start", "http://example.test", "--duration", "3s", "--interval", "1s", "--out", outDir, "--json"],
      {
        TIMELAPSE_SIMULATE_FRAMES: "3",
        // This test hook fails only the second simulated frame. The third frame
        // still captures, proving a failed attempt does not poison latestFrame.
        TIMELAPSE_SIMULATE_FRAME_FAILURE: "1"
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const startPayload = JSON.parse(result.stdout);
    const runDir = startPayload.runDir;

    const status = await waitForCompletedStatus(runDir);
    assert.equal(status.state, "completed");
    assert.equal(status.frames.captured, 2);
    assert.equal(status.frames.failed, 1);
    assert.equal(typeof status.latestFrame, "string");
    assert.equal(path.basename(status.latestFrame), "frame-0003.png");

    const latestFrame = JSON.parse(
      await fs.readFile(path.join(runDir, "latest-frame.json"), "utf8")
    );
    assert.equal(latestFrame.status, "captured");
    assert.equal(path.basename(latestFrame.path), "frame-0003.png");

    const manifestPath = path.join(runDir, "manifest.jsonl");
    const manifestLines = (await fs.readFile(manifestPath, "utf8"))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(manifestLines.filter((record) => record.status === "captured").length, 2);
    assert.equal(manifestLines.filter((record) => record.status === "failed").length, 1);
    // TIMELAPSE_SIMULATE_FRAME_FAILURE is intentionally fixed to index 2 so
    // the test covers a failure between successful frames.
    assert.equal(manifestLines[1].index, 2);
    assert.equal(manifestLines[1].status, "failed");
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});
