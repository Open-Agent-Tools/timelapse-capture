import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { commandCleanup } from "../src/timelapse-capture.mjs";

const __filename = fileURLToPath(import.meta.url);

async function makeRun({ frameCount = 3 } = {}) {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "tlc-repro-279-"));
  const framesDir = path.join(runDir, "frames");
  await fs.mkdir(framesDir);
  for (let index = 1; index <= frameCount; index += 1) {
    await fs.writeFile(
      path.join(framesDir, `frame-${String(index).padStart(4, "0")}.png`),
      "fake-png-content",
    );
  }
  await fs.writeFile(path.join(runDir, "output.mp4"), "placeholder");
  return runDir;
}

test("cleanup --keep-samples moves retained frames to samples/ and removes frames/", async () => {
  const runDir = await makeRun({ frameCount: 5 });
  try {
    const result = await commandCleanup({
      runDir,
      options: { "keep-samples": true, force: true },
    });

    // Check if samples directory exists
    const samplesDir = path.join(runDir, "samples");
    const samplesExist = await fs.stat(samplesDir).then(
      () => true,
      () => false,
    );
    assert.ok(samplesExist, "samples/ directory should exist");

    const samples = await fs.readdir(samplesDir);
    assert.equal(samples.length, 2, "Should have 2 samples (first and last)");
    assert.ok(
      samples.includes("sample-000001.png"),
      "Should have sample-000001.png",
    );
    assert.ok(
      samples.includes("sample-000002.png"),
      "Should have sample-000002.png",
    );

    // Check if frames directory is gone
    const framesDir = path.join(runDir, "frames");
    const framesExist = await fs.stat(framesDir).then(
      () => true,
      () => false,
    );
    assert.ok(!framesExist, "frames/ directory should be removed");

    // Check summary
    const summaryPath = path.join(runDir, "run-summary.json");
    const summary = JSON.parse(await fs.readFile(summaryPath, "utf8"));
    assert.ok(summary.cleanup.samples, "summary should list samples");
    assert.deepEqual(summary.cleanup.samples, [
      "samples/sample-000001.png",
      "samples/sample-000002.png",
    ]);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

import { renderFrames } from "../src/timelapse-capture.mjs";
import { withFakeFFmpeg } from "./helpers/fake-ffmpeg.mjs";

test("renderFrames with keep-samples copies samples and cleans up frames", async () => {
  const runDir = await makeRun({ frameCount: 10 });
  try {
    await withFakeFFmpeg(async (manager) => {
      const originalPath = process.env.PATH;
      process.env.PATH = manager.getPATHEnv();
      try {
        const result = renderFrames(runDir, { "keep-samples": 5 });
        assert.ok(result.success, `Render should succeed: ${result.error}`);

        // Check samples
        const samplesDir = path.join(runDir, "samples");
        const samples = await fs.readdir(samplesDir);
        assert.equal(samples.length, 5, "Should have 5 samples");

        // Check frames are gone
        const framesDir = path.join(runDir, "frames");
        const framesExist = await fs.stat(framesDir).then(
          () => true,
          () => false,
        );
        assert.ok(!framesExist, "frames/ directory should be removed");

        // Check summary
        const summaryPath = path.join(runDir, "run-summary.json");
        const summary = JSON.parse(await fs.readFile(summaryPath, "utf8"));
        assert.equal(summary.cleanup.retained, 5);
        assert.deepEqual(summary.cleanup.samples, [
          "samples/sample-000001.png",
          "samples/sample-000002.png",
          "samples/sample-000003.png",
          "samples/sample-000004.png",
          "samples/sample-000005.png",
        ]);
      } finally {
        process.env.PATH = originalPath;
      }
    });
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});
