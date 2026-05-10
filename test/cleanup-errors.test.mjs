import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { withFakeFFmpeg } from "./helpers/fake-ffmpeg.mjs";

import { cleanupFrames, commandCleanup, renderFrames, __test__ } from "../src/timelapse-capture.mjs";

const FRAME_PNG_1x1 = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000b49444154789c636060000000020001d75edeb0000000049454e44ae426082",
  "hex"
);

async function makeRun({ frameCount = 1 } = {}) {
  const runDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tlc-cleanup-errors-"));
  const framesDir = path.join(runDir, "frames");
  await fsp.mkdir(framesDir);
  for (let index = 1; index <= frameCount; index += 1) {
    await fsp.writeFile(path.join(framesDir, `frame-${String(index).padStart(6, "0")}.png`), FRAME_PNG_1x1);
  }
  await fsp.writeFile(path.join(runDir, "output.mp4"), "placeholder");
  return { runDir, framesDir };
}

async function runWithFakeFFmpeg(callback) {
  return withFakeFFmpeg(async (manager) => {
    const originalPath = process.env.PATH;
    process.env.PATH = manager.getPATHEnv();
    try {
      return await callback();
    } finally {
      process.env.PATH = originalPath;
    }
  });
}

async function exists(pathToCheck) {
  try {
    await fsp.stat(pathToCheck);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

test("writeJsonSync writes correct JSON and leaves no tmp file", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tlc-writejson-"));
  try {
    const filePath = path.join(tmpDir, "out.json");
    __test__.writeJsonSync(filePath, { key: "val" });

    const written = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.deepEqual(written, { key: "val" });

    const leftover = fs.readdirSync(tmpDir).filter((f) => f.startsWith("out.json.tmp-"));
    assert.equal(leftover.length, 0);
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});

test("cleanupFrames reports unexpected frames directory removal failures", async () => {
  const { runDir, framesDir } = await makeRun();
  const originalRmdirSync = fs.rmdirSync;
  try {
    fs.rmdirSync = (target) => {
      if (target === framesDir) {
        const error = new Error("permission denied");
        error.code = "EACCES";
        throw error;
      }
      return originalRmdirSync(target);
    };

    const result = cleanupFrames(framesDir);
    assert.equal(result.success, false);
    assert.equal(result.removed, 1);
    assert.match(result.error, /permission denied/);
  } finally {
    fs.rmdirSync = originalRmdirSync;
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test("cleanupFrames removes leftover render staging before removing frames directory", async () => {
  const { runDir, framesDir } = await makeRun();
  try {
    const stagingDir = path.join(framesDir, ".render-staging");
    await fsp.mkdir(stagingDir);
    await fsp.writeFile(path.join(stagingDir, "frame-000001.png"), FRAME_PNG_1x1);

    const result = cleanupFrames(framesDir);
    assert.equal(result.success, true);
    assert.equal(result.removed, 1);
    assert.equal(fs.existsSync(framesDir), false);
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test("cleanupFrames removes render staging when no image files exist", async () => {
  const runDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tlc-cleanup-errors-"));
  const framesDir = path.join(runDir, "frames");
  const stagingDir = path.join(framesDir, ".render-staging");
  try {
    await fsp.mkdir(stagingDir, { recursive: true });
    await fsp.writeFile(path.join(stagingDir, "frame-000001.png"), FRAME_PNG_1x1);

    const result = cleanupFrames(framesDir);
    assert.equal(result.success, true);
    assert.equal(result.removed, 0);
    assert.equal(fs.existsSync(framesDir), true);
    assert.equal(fs.existsSync(stagingDir), false);
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test("cleanup --keep-samples reports one retained frame for one-frame runs", async () => {
  const { runDir, framesDir } = await makeRun({ frameCount: 1 });
  try {
    await runWithFakeFFmpeg(async () => {
      const result = await commandCleanup({ runDir, options: { "keep-samples": true } });
      assert.equal(result.removed, 0);
      assert.equal(result.retained, 1);

      const summary = JSON.parse(await fsp.readFile(path.join(runDir, "run-summary.json"), "utf8"));
      assert.equal(summary.cleanup.removed, 0);
      assert.equal(summary.cleanup.retained, 1);
      assert.equal(summary.cleanup.success, true);
      assert.deepEqual((await fsp.readdir(framesDir)).sort(), ["frame-000001.png"]);
    });
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test("cleanup succeeds when configured output path is present", async () => {
  const { runDir, framesDir } = await makeRun({ frameCount: 1 });
  try {
    await fsp.writeFile(path.join(runDir, "config.json"), JSON.stringify({ output: { path: "custom/output.mp4" } }));
    await fsp.mkdir(path.join(runDir, "custom"), { recursive: true });
    const outputPath = path.join(runDir, "custom", "output.mp4");
    await fsp.writeFile(outputPath, "rendered");
    await fsp.rm(path.join(runDir, "output.mp4"), { force: true });

    await runWithFakeFFmpeg(async () => {
      const result = await commandCleanup({ runDir, options: {} });
      assert.equal(result.removed, 1);
      const hasFramesDir = await exists(framesDir);
      assert.equal(hasFramesDir, false);
    });
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test("cleanup succeeds when run-summary render output path is present", async () => {
  const { runDir, framesDir } = await makeRun({ frameCount: 1 });
  try {
    const outputPath = path.join(runDir, "summary-output.mp4");
    await fsp.writeFile(outputPath, "rendered");
    await fsp.writeFile(
      path.join(runDir, "run-summary.json"),
      JSON.stringify({ render: { outputPath } }, null, 2)
    );
    await fsp.rm(path.join(runDir, "output.mp4"), { force: true });

    await runWithFakeFFmpeg(async () => {
      const result = await commandCleanup({ runDir, options: {} });
      assert.equal(result.removed, 1);
      const hasFramesDir = await exists(framesDir);
      assert.equal(hasFramesDir, false);
    });
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test("cleanup --keep-samples keeps distinct first and last frames", async () => {
  const { runDir, framesDir } = await makeRun({ frameCount: 3 });
  try {
    await runWithFakeFFmpeg(async () => {
      const result = await commandCleanup({ runDir, options: { "keep-samples": true } });
      assert.equal(result.removed, 1);
      assert.equal(result.retained, 2);
      assert.deepEqual((await fsp.readdir(framesDir)).sort(), ["frame-000001.png", "frame-000003.png"]);

      const summary = JSON.parse(await fsp.readFile(path.join(runDir, "run-summary.json"), "utf8"));
      assert.equal(summary.cleanup.removed, 1);
      assert.equal(summary.cleanup.retained, 2);
      assert.equal(summary.cleanup.success, true);
    });
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test("cleanup --frames ignores a non-empty frames directory after deleting raw frames", async () => {
  const { runDir, framesDir } = await makeRun();
  try {
    await fsp.writeFile(path.join(framesDir, "notes.txt"), "retain me");

    await runWithFakeFFmpeg(async () => {
      const result = await commandCleanup({ runDir, options: { frames: true } });
      assert.equal(result.removed, 1);
      assert.equal(await fsp.readFile(path.join(framesDir, "notes.txt"), "utf8"), "retain me");
    });
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test("cleanup --keep-latest promotes the surviving frame to latest-retained.png", async () => {
  const { runDir, framesDir } = await makeRun({ frameCount: 2 });
  await fsp.writeFile(path.join(runDir, "output.mp4"), "placeholder");
  try {
    const lastFrameSrc = path.join(framesDir, "frame-000002.png");
    const expectedBytes = await fsp.readFile(lastFrameSrc);

    const result = await commandCleanup({ runDir, options: { "keep-latest": true } });
    assert.equal(result.message, "Frames cleaned up (kept latest)");

    const retainedPath = path.join(runDir, "latest-retained.png");
    assert.ok(fs.existsSync(retainedPath), "latest-retained.png should exist");
    const actualBytes = await fsp.readFile(retainedPath);
    assert.deepEqual(actualBytes, expectedBytes, "latest-retained.png should match the last frame");

    assert.equal(fs.existsSync(framesDir), false, "frames/ directory should be removed");
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test("renderFrames includes summary write failures in render failure diagnostics", async () => {
  const { runDir } = await makeRun();
  const originalWriteFileSync = fs.writeFileSync;
  try {
    fs.writeFileSync = (target, data, options) => {
      if (String(target).includes("run-summary.json.tmp-")) {
        const error = new Error("summary volume is read-only");
        error.code = "EROFS";
        throw error;
      }
      return originalWriteFileSync(target, data, options);
    };

    const result = renderFrames(runDir, { ffmpegPath: "definitely-not-ffmpeg" });
    assert.equal(result.success, false);
    assert.match(result.error, /ffmpeg failed/);
    assert.match(result.error, /failed to update render summary: summary volume is read-only/);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test("renderFrames records lastRenderAttempt metadata on ffmpeg failure", async () => {
  const { runDir } = await makeRun({ frameCount: 1 });
  try {
    const result = renderFrames(runDir, { ffmpegPath: "definitely-not-ffmpeg" });
    assert.equal(result.success, false);
    assert.match(result.error, /ffmpeg failed/);

    const summary = JSON.parse(await fsp.readFile(path.join(runDir, "run-summary.json"), "utf8"));
    assert.deepEqual(summary.lastRenderAttempt.outputPath, path.join(runDir, "output.mp4"));
    assert.equal(summary.lastRenderAttempt.sourceFrameCount, 1);
    assert.equal(Array.isArray(summary.lastRenderAttempt.ffmpegCommand), true);
    assert.ok(summary.lastRenderAttempt.ffmpegCommand.includes("definitely-not-ffmpeg"));
    assert.match(summary.lastRenderAttempt.error, /ffmpeg failed/);
    assert.equal(summary.cleanup.success, false);
    assert.equal(summary.cleanup.reason, "render-or-validation-failed");
    assert.equal(summary.cleanup.removed, 0);
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test("renderFrames refuses custom output path before cleanup", async () => {
  const { runDir, framesDir } = await makeRun();
  try {
    const customOutputPath = path.join(runDir, "custom.mp4");
    const expectedOutputPath = path.join(runDir, "output.mp4");
    const result = renderFrames(runDir, {
      config: { output: { path: customOutputPath } },
      ffmpegPath: "definitely-not-ffmpeg"
    });

    assert.equal(result.success, false);
    assert.match(result.error, new RegExp(expectedOutputPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const status = JSON.parse(await fsp.readFile(path.join(runDir, "status.json"), "utf8"));
    assert.equal(status.state, "render_failed");

    const summary = JSON.parse(await fsp.readFile(path.join(runDir, "run-summary.json"), "utf8"));
    assert.equal(summary.cleanup.removed, 0);
    assert.equal(fs.existsSync(path.join(framesDir, "frame-000001.png")), true);
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});
