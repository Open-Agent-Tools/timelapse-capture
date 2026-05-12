import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { withFakeFFmpeg } from "./helpers/fake-ffmpeg.mjs";
import { cleanupFrames, commandCleanup, renderFrames, __test__ } from "../src/timelapse-capture.mjs";

async function runWithFakeFFmpeg(callback, mode = "success") {
  return withFakeFFmpeg(async (manager) => {
    const originalPath = process.env.PATH;
    process.env.PATH = manager.getPATHEnv();
    try {
      return await callback();
    } finally {
      process.env.PATH = originalPath;
    }
  }, mode);
}

const FRAME_PNG_1x1 = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000b49444154789c636060000000020001d75edeb0000000049454e44ae426082",
  "hex"
);

async function makeRun({ frameCount = 1 } = {}) {
  const runDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tlc-cleanup-errors-"));
  const framesDir = path.join(runDir, "frames");
  await fsp.mkdir(framesDir);
  for (let index = 1; index <= frameCount; index += 1) {
    await fsp.writeFile(path.join(framesDir, `frame-${String(index).padStart(4, "0")}.png`), FRAME_PNG_1x1);
  }
  await fsp.writeFile(path.join(runDir, "output.mp4"), "placeholder");
  return { runDir, framesDir };
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

    const result = cleanupFrames(runDir);
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
    await fsp.writeFile(path.join(stagingDir, "frame-0001.png"), FRAME_PNG_1x1);

    const result = cleanupFrames(runDir);
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
    await fsp.writeFile(path.join(stagingDir, "frame-0001.png"), FRAME_PNG_1x1);

    const result = cleanupFrames(runDir);
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
      assert.equal(result.removed, 1);
      assert.equal(result.retained, 1);

      const summary = JSON.parse(await fsp.readFile(path.join(runDir, "run-summary.json"), "utf8"));
      assert.equal(summary.cleanup.removed, 1);
      assert.equal(summary.cleanup.retained, 1);
      assert.equal(summary.cleanup.success, true);
      assert.equal(fs.existsSync(framesDir), false);
      assert.deepEqual((await fsp.readdir(path.join(runDir, "samples"))).sort(), ["sample-000001.png"]);
    });
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test("cleanup refusal surfaces validateMP4 error reason", async () => {
  const { runDir } = await makeRun({ frameCount: 1 });
  const outputPath = path.join(runDir, "output.mp4");
  try {
    await fsp.rm(outputPath, { force: true });

    await runWithFakeFFmpeg(async () => {
      await assert.rejects(
        commandCleanup({ runDir, options: {} }),
        (error) =>
          error.message.includes("Refusing to delete frames: Output file does not exist") &&
          error.message.includes(`(at ${outputPath})`) &&
          error.message.includes("Pass --force to override.")
      );
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

test("cleanup surfaces validateMP4 failure reason", async () => {
  const { runDir, framesDir } = await makeRun({ frameCount: 1 });
  try {
    await fsp.rm(path.join(runDir, "output.mp4"), { force: true });

    await assert.rejects(
      () => commandCleanup({ runDir, options: {} }),
      /Refusing to delete frames: Output file does not exist \(at .*output\.mp4\)\. Pass --force to override\./
    );

    assert.equal(await exists(path.join(framesDir, "frame-0001.png")), true);
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test("cleanup --keep-samples keeps distinct first and last frames", async () => {
  const { runDir, framesDir } = await makeRun({ frameCount: 3 });
  try {
    await runWithFakeFFmpeg(async () => {
      const result = await commandCleanup({ runDir, options: { "keep-samples": 2 } });
      assert.equal(result.removed, 3);
      assert.equal(result.retained, 2);

      const summary = JSON.parse(await fsp.readFile(path.join(runDir, "run-summary.json"), "utf8"));
      assert.equal(summary.cleanup.removed, 3);
      assert.equal(summary.cleanup.retained, 2);
      assert.equal(summary.cleanup.success, true);
      assert.equal(fs.existsSync(framesDir), false);
      assert.deepEqual((await fsp.readdir(path.join(runDir, "samples"))).sort(), ["sample-000001.png", "sample-000002.png"]);
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

test("cleanup --keep-latest keeps the last frame in the frames directory", async () => {
  const { runDir, framesDir } = await makeRun({ frameCount: 2 });
  try {
    await runWithFakeFFmpeg(async () => {
      const result = await commandCleanup({ runDir, options: { "keep-latest": true } });
      assert.equal(result.message, "Frames cleaned up (kept latest)");
      assert.equal(result.removed, 1);
      assert.equal(result.retained, 1);

      const remaining = await fsp.readdir(framesDir);
      assert.deepEqual(remaining.sort(), ["frame-0002.png"], "only last frame should remain");
      assert.equal(fs.existsSync(path.join(runDir, "latest-retained.png")), false,
        "latest-retained.png should not be created");
    });
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

    await runWithFakeFFmpeg(async () => {
      const result = renderFrames(runDir, { ffmpegPath: "definitely-not-ffmpeg" });
      assert.equal(result.success, false);
      assert.match(result.error, /ffmpeg failed/);
      assert.match(result.error, /failed to update render summary: summary volume is read-only/);
    });
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test("renderFrames records lastRenderAttempt metadata on ffmpeg failure", async () => {
  const { runDir } = await makeRun({ frameCount: 1 });
  try {
    await runWithFakeFFmpeg(async () => {
      const result = renderFrames(runDir, { ffmpegPath: "definitely-not-ffmpeg" });
      assert.equal(result.success, false);
      assert.match(result.error, /ffmpeg failed/);
      assert.equal(result.errorCode, "FFMPEG_FAILED");

      const summary = JSON.parse(await fsp.readFile(path.join(runDir, "run-summary.json"), "utf8"));
      assert.deepEqual(summary.lastRenderAttempt.outputPath, path.join(runDir, "output.mp4"));
      assert.equal(summary.lastRenderAttempt.sourceFrameCount, 1);
      assert.equal(Array.isArray(summary.lastRenderAttempt.ffmpegCommand), true);
      assert.ok(summary.lastRenderAttempt.ffmpegCommand.includes("definitely-not-ffmpeg"));
      assert.match(summary.lastRenderAttempt.error, /ffmpeg failed/);
      assert.equal(summary.cleanup.success, false);
      assert.equal(summary.cleanup.reason, "render-or-validation-failed");
      assert.equal(summary.cleanup.removed, 0);
    });
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test("renderFrames records configured output path on ffmpeg failure", async () => {
  const { runDir } = await makeRun({ frameCount: 1 });
  try {
    const customRelativePath = path.join("custom", "output.mp4");
    const expectedOutputPath = path.join(runDir, customRelativePath);

    await runWithFakeFFmpeg(async () => {
      const result = await renderFrames(runDir, {
        ffmpegPath: "definitely-not-ffmpeg",
        config: { output: { path: customRelativePath } }
      });
      assert.equal(result.success, false);
      assert.match(result.error, /ffmpeg failed/);

      const summary = JSON.parse(await fsp.readFile(path.join(runDir, "run-summary.json"), "utf8"));
      assert.equal(summary.lastRenderAttempt.outputPath, expectedOutputPath);
      assert.equal(summary.lastRenderAttempt.sourceFrameCount, 1);
      assert.equal(summary.cleanup.success, false);
      assert.equal(summary.cleanup.reason, "render-or-validation-failed");
      assert.equal(summary.cleanup.removed, 0);
    });
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test("renderFrames renders configured custom output path before cleanup", async () => {
  const { runDir, framesDir } = await makeRun({ frameCount: 1 });
  try {
    const customRelativePath = path.join("custom", "output.mp4");
    const expectedOutputPath = path.join(runDir, customRelativePath);
    const sourceFramePath = path.join(framesDir, "frame-0001.png");
    await fsp.rm(path.join(runDir, "output.mp4"), { force: true });

    await runWithFakeFFmpeg(async () => {
      const result = await renderFrames(runDir, {
        config: { output: { path: customRelativePath } }
      });

      assert.equal(result.success, true, `Render should succeed, but failed with: ${result.error}`);
      assert.equal(result.outputPath, expectedOutputPath);
      assert.equal(fs.existsSync(result.outputPath), true, "Output file should exist");

      const summary = JSON.parse(await fsp.readFile(path.join(runDir, "run-summary.json"), "utf8"));
      assert.equal(summary.render.outputPath, result.outputPath);
      assert.equal(summary.render.sourceFrameCount, 1);
      assert.equal(summary.cleanup.success, true);
      assert.equal(summary.cleanup.removed, 1);
      assert.equal(summary.cleanup.reason, "post-render-cleanup");
      assert.equal(await exists(sourceFramePath), false, "Source frame should be removed by post-render cleanup");
    });
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test("renderFrames rejects configured output paths that escape runDir", async () => {
  const { runDir } = await makeRun({ frameCount: 1 });
  try {
    const escapePath = path.join("..", "escape.mp4");
    const result = renderFrames(runDir, {
      config: { output: { path: escapePath } }
    });

    assert.equal(result.success, false);
    assert.match(result.error, /OUTPUT_PATH_OUTSIDE_RUNDIR|outside.*run directory/i);

    const escapedFile = path.resolve(runDir, escapePath);
    assert.equal(fs.existsSync(escapedFile), false, "Escaped file should not exist");
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test("renderFrames sets errorCode to VALIDATION_FAILED when output is not a valid MP4", async () => {
  const { runDir } = await makeRun({ frameCount: 1 });
  try {
    await runWithFakeFFmpeg(async () => {
      const result = await renderFrames(runDir);
      assert.equal(result.success, false);
      assert.equal(result.errorCode, "VALIDATION_FAILED");
      assert.match(result.error, /valid MP4/);
    }, "invalid-output");
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test("renderFrames sets errorCode to ENOENT when run directory does not exist", async () => {
  const result = await renderFrames("non-existent-dir");
  assert.equal(result.success, false);
  assert.equal(result.errorCode, "ENOENT");
});

test("renderFrames reports render staging cleanup failures", async () => {
  const { runDir, framesDir } = await makeRun({ frameCount: 2 });
  await fsp.rename(
    path.join(framesDir, "frame-0002.png"),
    path.join(framesDir, "frame-000005.png")
  );

  const stagingDir = path.join(framesDir, ".render-staging");
  const originalRmSync = fs.rmSync;

  try {
    fs.rmSync = (target, options) => {
      if (String(target).includes(".render-staging")) {
        const error = new Error("permission denied");
        error.code = "EACCES";
        throw error;
      }
      return originalRmSync(target, options);
    };

    await runWithFakeFFmpeg(async () => {
      const result = await renderFrames(runDir, { ffmpegPath: "definitely-not-ffmpeg" });

      assert.equal(result.success, false);
      assert.match(result.error, /\.render-staging/);
      assert.match(result.error, /permission denied/);

      const status = JSON.parse(await fsp.readFile(path.join(runDir, "status.json"), "utf8"));
      assert.equal(status.state, "render_failed");

      const summary = JSON.parse(await fsp.readFile(path.join(runDir, "run-summary.json"), "utf8"));
      assert.match(summary.lastRenderAttempt.error, /\.render-staging/);
      assert.match(summary.lastRenderAttempt.error, /permission denied/);
    });
  } finally {
    fs.rmSync = originalRmSync;
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test("cleanupFrames with keep-samples should move samples to samples/", async () => {
  const { runDir, framesDir } = await makeRun({ frameCount: 10 });
  try {
    const result = cleanupFrames(runDir, { "keep-samples": 3 });
    
    const framesExist = await exists(framesDir);
    const samplesExist = await exists(path.join(runDir, "samples"));
    
    assert.equal(samplesExist, true, "Samples directory should exist");
    assert.equal(framesExist, false, "Frames directory should be removed");
    assert.equal(result.retained, 3);
    assert.ok(result.samples && result.samples.length === 3);
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});
