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

test("failed frame attempts preserve prior successful latestFrame", async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "tlc-status-failed-"));
  try {
    const result = runCli(
      ["start", "http://example.test", "--duration", "3s", "--interval", "1s", "--out", outDir, "--json"],
      {
        TIMELAPSE_SIMULATE_FRAMES: "3",
        // "1" enables the fixture mode that fails frame index 2, the second capture attempt.
        TIMELAPSE_SIMULATE_FRAME_FAILURE: "1"
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const startPayload = JSON.parse(result.stdout);
    const runDir = startPayload.runDir;

    const statusPath = path.join(runDir, "status.json");
    const status = JSON.parse(await fs.readFile(statusPath, "utf8"));
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
    const failedRecord = manifestLines.find((record) => record.status === "failed");
    assert.ok(failedRecord, "failed manifest record exists");
    assert.equal(failedRecord.index, 2);
    assert.equal(failedRecord.status, "failed");
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});
