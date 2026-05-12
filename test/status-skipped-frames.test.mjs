import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runCli } from "./helpers/cli.mjs";
import { waitForCompletedStatus } from "./helpers/status-waiters.mjs";

test("status output includes attempted and skipped frame counters", async () => {
  const outDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "tlc-status-skipped-"),
  );
  try {
    const result = runCli(
      [
        "start",
        "http://example.test",
        "--duration",
        "3s",
        "--interval",
        "1s",
        "--out",
        outDir,
        "--json",
      ],
      {
        TIMELAPSE_SIMULATE_FRAMES: "3",
        TIMELAPSE_SIMULATE_FRAME_FAILURE: "1", // fails index 2
        TIMELAPSE_SIMULATE_FRAME_SKIP: "1", // skips index 3
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const startPayload = JSON.parse(result.stdout);
    const runDir = startPayload.runDir;

    const status = await waitForCompletedStatus(runDir);
    assert.equal(status.state, "completed");

    // index 1: captured
    // index 2: failed
    // index 3: skipped
    assert.equal(status.frames.captured, 1);
    assert.equal(status.frames.failed, 1);
    assert.equal(status.frames.skipped, 1);
    assert.equal(status.frames.attempted, 3);
    assert.equal(status.frames.totalExpected, 3);

    // Verify human output also contains the counters
    const humanResult = runCli(["status", runDir]);
    assert.equal(humanResult.status, 0);
    assert.ok(humanResult.stdout.includes("3 attempted"));
    assert.ok(humanResult.stdout.includes("1 captured"));
    assert.ok(humanResult.stdout.includes("1 failed"));
    assert.ok(humanResult.stdout.includes("1 skipped"));
    assert.ok(humanResult.stdout.includes("3 expected"));

    // Verify manifest contains the skipped record
    const manifestPath = path.join(runDir, "manifest.jsonl");
    const manifestLines = (await fs.readFile(manifestPath, "utf8"))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    assert.equal(manifestLines.length, 3);
    assert.equal(manifestLines[0].status, "captured");
    assert.equal(manifestLines[1].status, "failed");
    assert.equal(manifestLines[2].status, "skipped");
    assert.equal(manifestLines[2].index, 3);
    assert.equal(manifestLines[2].error, "simulated skip");
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});
