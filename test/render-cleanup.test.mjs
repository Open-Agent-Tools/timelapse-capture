import { test, describe, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";

import {
  commandRender,
  commandCleanup,
  commandPeek
} from "../src/timelapse-capture.mjs";
import { withFakeFFmpeg, hasRealFFmpeg } from "./helpers/fake-ffmpeg.mjs";

const FRAME_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAAC0lEQVR4nGNgYAAAAAIAAdde3rAAAAAElFTkSuQmCA==",
  "base64"
);

async function createTestFrames(runDir, count = 3) {
  const framesDir = path.join(runDir, "frames");
  await fs.mkdir(framesDir, { recursive: true });
  for (let i = 1; i <= count; i += 1) {
    const name = `frame-${String(i).padStart(4, "0")}.png`;
    await fs.writeFile(path.join(framesDir, name), FRAME_PNG);
  }
  return framesDir;
}

async function createNumericFrames(runDir, count = 3) {
  const framesDir = path.join(runDir, "frames");
  await fs.mkdir(framesDir, { recursive: true });
  for (let i = 1; i <= count; i += 1) {
    const name = `${String(i).padStart(5, "0")}.png`;
    // Append frame index byte so each frame has distinct content for poster selection tests
    await fs.writeFile(path.join(framesDir, name), Buffer.concat([FRAME_PNG, Buffer.from([i])]));
  }
  return framesDir;
}

async function createRunDir(tempDir) {
  const runDir = path.join(
    tempDir,
    `run-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  await fs.mkdir(runDir, { recursive: true });
  return runDir;
}

describe("render with fake ffmpeg", () => {
  let tempDir;

  before(async () => {
    tempDir = path.join(
      "/tmp",
      `test-render-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await fs.mkdir(tempDir, { recursive: true });
  });

  after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("valid render writes metadata summary and deletes frames", async () => {
    const runDir = await createRunDir(tempDir);
    const framesDir = await createNumericFrames(runDir, 3);

    const oldPath = process.env.PATH;
    try {
      await withFakeFFmpeg(async (manager) => {
        process.env.PATH = manager.getPATHEnv();
        const result = await commandRender({ runDir, options: {} });
        assert.strictEqual(result.path, path.join(runDir, "output.mp4"));
        assert.strictEqual(result.frameCount, 3);

        await assert.rejects(fs.readdir(framesDir), /ENOENT/);
        const summary = JSON.parse(
          await fs.readFile(path.join(runDir, "run-summary.json"), "utf8")
        );
        assert.strictEqual(summary.render.outputPath, path.join(runDir, "output.mp4"));
        assert(summary.render.bytes > 0);
        assert.strictEqual(summary.render.duration, 10);
        assert.deepStrictEqual(summary.render.dimensions, { width: 1280, height: 720 });
        assert.strictEqual(summary.render.sourceFrameCount, 3);
        assert.ok(Array.isArray(summary.render.ffmpegCommand), "render.ffmpegCommand should be an array");
        assert.strictEqual(summary.render.ffmpegCommand[0], "ffmpeg");
        assert.strictEqual(summary.duration, 10);
        assert.deepStrictEqual(summary.dimensions, { width: 1280, height: 720 });
        assert.ok(Array.isArray(summary.ffmpegCommand), "ffmpegCommand should be an array");
        assert.strictEqual(summary.ffmpegCommand[0], "ffmpeg");
        assert.ok(summary.ffmpegCommand.includes("-framerate"));
        assert.ok(summary.ffmpegCommand.includes("libx264"));
        assert.ok(summary.ffmpegCommand.includes(path.join(runDir, "output.mp4")));
        assert.strictEqual(summary.cleanup.success, true);
        assert.strictEqual(summary.cleanup.removed, 3);

        // poster assertions: middle frame of 3 is index 1 (Math.floor((3-1)/2) = 1), which is 00002.png
        const posterPath = path.join(runDir, "poster.png");
        const posterStat = await fs.stat(posterPath).catch(() => null);
        assert.ok(posterStat, "poster.png should exist after successful render");
        const posterContent = await fs.readFile(posterPath);
        const expectedMiddleContent = Buffer.concat([FRAME_PNG, Buffer.from([2])]);
        assert.deepStrictEqual(posterContent, expectedMiddleContent, "poster.png should be the middle frame (00002.png)");
        assert.strictEqual(summary.poster, "poster.png", "summary.poster should be 'poster.png'");
      }, "success");
    } finally {
      process.env.PATH = oldPath;
    }
  });

  test("render with one frame creates poster from that frame", async () => {
    const runDir = await createRunDir(tempDir);
    await createNumericFrames(runDir, 1);

    const oldPath = process.env.PATH;
    try {
      await withFakeFFmpeg(async (manager) => {
        process.env.PATH = manager.getPATHEnv();
        await commandRender({ runDir, options: {} });

        const posterPath = path.join(runDir, "poster.png");
        const posterContent = await fs.readFile(posterPath);
        const expectedContent = Buffer.concat([FRAME_PNG, Buffer.from([1])]);
        assert.deepStrictEqual(posterContent, expectedContent, "poster.png should be the only frame (00001.png)");

        const summary = JSON.parse(
          await fs.readFile(path.join(runDir, "run-summary.json"), "utf8")
        );
        assert.strictEqual(summary.poster, "poster.png");
      }, "success");
    } finally {
      process.env.PATH = oldPath;
    }
  });

  test("render failure preserves frames", async () => {
    const runDir = await createRunDir(tempDir);
    const framesDir = await createNumericFrames(runDir, 3);

    const oldPath = process.env.PATH;
    try {
      await withFakeFFmpeg(async (manager) => {
        process.env.PATH = manager.getPATHEnv();
        try {
          await commandRender({ runDir, options: {} });
          assert.fail("Should have thrown");
        } catch (error) {
          assert(error.message.includes("render failed"));
        }
        const files = await fs.readdir(framesDir);
        assert.strictEqual(files.length, 3, "frames should be preserved after render failure");
        const summary = JSON.parse(
          await fs.readFile(path.join(runDir, "run-summary.json"), "utf8")
        );
        assert.strictEqual(summary.cleanup.reason, "render-or-validation-failed");
        const posterStat = await fs.stat(path.join(runDir, "poster.png")).catch(() => null);
        assert.strictEqual(posterStat, null, "poster.png should not exist after render failure");
      }, "fail");
    } finally {
      process.env.PATH = oldPath;
    }
  });

  test("invalid output preserves frames", async () => {
    const runDir = await createRunDir(tempDir);
    const framesDir = await createNumericFrames(runDir, 3);

    const oldPath = process.env.PATH;
    try {
      await withFakeFFmpeg(async (manager) => {
        process.env.PATH = manager.getPATHEnv();
        try {
          await commandRender({ runDir, options: {} });
          assert.fail("Should have thrown");
        } catch (error) {
          assert(error.message.includes("not a valid MP4"));
        }
        const files = await fs.readdir(framesDir);
        assert.strictEqual(files.length, 3, "frames should be preserved after invalid output");
        const summary = JSON.parse(
          await fs.readFile(path.join(runDir, "run-summary.json"), "utf8")
        );
        assert.match(
          summary.lastRenderAttempt.error,
          /not a valid MP4|MP4 validation failed/
        );
      }, "invalid-output");
    } finally {
      process.env.PATH = oldPath;
    }
  });
});

describe("render state safety checks", () => {
  let tempDir;

  before(async () => {
    tempDir = path.join(
      "/tmp",
      `test-render-state-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await fs.mkdir(tempDir, { recursive: true });
  });

  after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("render blocks when state is running without --force", async () => {
    const runDir = await createRunDir(tempDir);
    await createNumericFrames(runDir, 3);
    await fs.writeFile(
      path.join(runDir, "status.json"),
      JSON.stringify({ state: "running" }, null, 2)
    );
    try {
      await commandRender({ runDir, options: {} });
      assert.fail("Should have thrown");
    } catch (error) {
      assert(error.message.includes("Cannot render while capture is active"));
    }
  });

  test("render with --force on active run preserves frames", async () => {
    const runDir = await createRunDir(tempDir);
    const framesDir = await createNumericFrames(runDir, 3);
    await fs.writeFile(
      path.join(runDir, "status.json"),
      JSON.stringify({ state: "running" }, null, 2)
    );

    const oldPath = process.env.PATH;
    try {
      await withFakeFFmpeg(async (manager) => {
        process.env.PATH = manager.getPATHEnv();
        const result = await commandRender({ runDir, options: { force: true } });
        assert.strictEqual(result.path, path.join(runDir, "output.mp4"));
        const files = await fs.readdir(framesDir);
        assert.strictEqual(
          files.length,
          3,
          "frames should be preserved with --force on active run"
        );
      }, "success");
    } finally {
      process.env.PATH = oldPath;
    }
  });
});

describe("cleanup command", () => {
  let tempDir;

  before(async () => {
    tempDir = path.join(
      "/tmp",
      `test-cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await fs.mkdir(tempDir, { recursive: true });
  });

  after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("--keep-frames preserves all frames", async () => {
    const runDir = await createRunDir(tempDir);
    const framesDir = await createTestFrames(runDir, 3);
    const result = await commandCleanup({ runDir, options: { "keep-frames": true } });
    assert.match(result.message, /Frames preserved/);
    assert.strictEqual(result.frameCount, 3);
    const files = await fs.readdir(framesDir);
    assert.strictEqual(files.length, 3);
  });

  test("--keep-samples keeps first and last", async () => {
    const runDir = await createRunDir(tempDir);
    const framesDir = await createTestFrames(runDir, 5);
    const result = await commandCleanup({ runDir, options: { "keep-samples": true } });
    assert.match(result.message, /kept first and last/);
    assert.strictEqual(result.removed, 3);
    assert.strictEqual(result.retained, 2);
    const files = await fs.readdir(framesDir);
    assert.strictEqual(files.length, 2);
    assert(files.includes("frame-0001.png"));
    assert(files.includes("frame-0005.png"));
  });

  test("--keep-latest keeps only last frame", async () => {
    const runDir = await createRunDir(tempDir);
    const framesDir = await createTestFrames(runDir, 5);
    const result = await commandCleanup({ runDir, options: { "keep-latest": true } });
    assert.match(result.message, /kept latest/);
    assert.strictEqual(result.removed, 4);
    assert.strictEqual(result.retained, 1);
    const files = await fs.readdir(framesDir);
    assert.strictEqual(files.length, 1);
    assert(files.includes("frame-0005.png"));
  });

  test("default cleanup removes all frames", async () => {
    const runDir = await createRunDir(tempDir);
    const framesDir = await createTestFrames(runDir, 3);
    const result = await commandCleanup({ runDir, options: {} });
    assert.strictEqual(result.removed, 3);
    const stat = await fs.stat(framesDir).catch(() => null);
    assert.strictEqual(stat, null, "frames directory should be removed");
  });

  test("cleanup with no frames returns gracefully", async () => {
    const runDir = await createRunDir(tempDir);
    await fs.mkdir(path.join(runDir, "frames"), { recursive: true });
    const result = await commandCleanup({ runDir, options: {} });
    assert.match(result.message, /Cleanup complete/);
    assert.strictEqual(result.removed, 0);
  });

  test("cleanup --frames removes raw frames and latest.png", async () => {
    const runDir = await createRunDir(tempDir);
    const framesDir = await createTestFrames(runDir, 3);
    const latestPath = path.join(runDir, "latest.png");
    await fs.writeFile(latestPath, FRAME_PNG);
    const result = await commandCleanup({ runDir, options: { frames: true } });
    assert.match(result.message, /Raw frames and latest.png cleaned up/);
    assert.strictEqual(result.removed, 3);
    const files = await fs.readdir(framesDir).catch(() => []);
    assert.strictEqual(files.length, 0, "all frames should be deleted");
    const latestStat = await fs.stat(latestPath).catch(() => null);
    assert.strictEqual(latestStat, null, "latest.png should be deleted");
  });

  test("cleanup --frames preserves MP4 and special images", async () => {
    const runDir = await createRunDir(tempDir);
    await createTestFrames(runDir, 3);
    const mp4Path = path.join(runDir, "output.mp4");
    const posterPath = path.join(runDir, "poster.png");
    const retainedPath = path.join(runDir, "latest-retained.png");
    await fs.writeFile(mp4Path, Buffer.from("fake mp4"));
    await fs.writeFile(posterPath, FRAME_PNG);
    await fs.writeFile(retainedPath, FRAME_PNG);
    await commandCleanup({ runDir, options: { frames: true } });
    assert(await fs.stat(mp4Path).catch(() => null), "output.mp4 should be preserved");
    assert(await fs.stat(posterPath).catch(() => null), "poster.png should be preserved");
    assert(
      await fs.stat(retainedPath).catch(() => null),
      "latest-retained.png should be preserved"
    );
  });

  test("cleanup --all removes entire run directory", async () => {
    const runDir = await createRunDir(tempDir);
    await createTestFrames(runDir, 3);
    await fs.writeFile(path.join(runDir, "output.mp4"), Buffer.from("fake mp4"));
    const result = await commandCleanup({ runDir, options: { all: true, force: true } });
    assert.match(result.message, /Entire run directory deleted/);
    const stat = await fs.stat(runDir).catch(() => null);
    assert.strictEqual(stat, null, "run directory should be deleted");
  });

  test("cleanup --all blocks without --force if frames exist", async () => {
    const runDir = await createRunDir(tempDir);
    await createTestFrames(runDir, 3);
    try {
      await commandCleanup({ runDir, options: { all: true } });
      assert.fail("Should have thrown");
    } catch (error) {
      assert(error.message.includes("Raw frames still exist"));
    }
  });
});

describe("peek after cleanup", () => {
  let tempDir;

  before(async () => {
    tempDir = path.join(
      "/tmp",
      `test-peek-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await fs.mkdir(tempDir, { recursive: true });
  });

  after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("peek returns retained frame with --keep-latest", async () => {
    const runDir = await createRunDir(tempDir);
    await createTestFrames(runDir, 3);
    await commandCleanup({ runDir, options: { "keep-latest": true } });
    const result = await commandPeek({ runDir, options: {} });
    assert(result.path.includes("frame-0003.png"));
    assert.strictEqual(result.pathCount, 1);
  });

  test("peek returns poster.png when frames are cleaned up", async () => {
    const runDir = await createRunDir(tempDir);
    const posterPath = path.join(runDir, "poster.png");
    await createTestFrames(runDir, 3);
    await fs.writeFile(posterPath, FRAME_PNG);
    await commandCleanup({ runDir, options: { frames: true } });
    const result = await commandPeek({ runDir, options: {} });
    assert.strictEqual(result.path, posterPath);
  });

  test("peek returns latest-retained.png when no frames and no poster", async () => {
    const runDir = await createRunDir(tempDir);
    const retainedPath = path.join(runDir, "latest-retained.png");
    await createTestFrames(runDir, 3);
    await fs.writeFile(retainedPath, FRAME_PNG);
    await commandCleanup({ runDir, options: { frames: true } });
    const result = await commandPeek({ runDir, options: {} });
    assert.strictEqual(result.path, retainedPath);
  });

  test("peek with no frames and no fallback images throws clear error", async () => {
    const runDir = await createRunDir(tempDir);
    await fs.mkdir(path.join(runDir, "frames"), { recursive: true });
    try {
      await commandPeek({ runDir, options: {} });
      assert.fail("Should have thrown");
    } catch (error) {
      assert(error.message.includes("Raw frames were cleaned up"));
      assert(error.message.includes("poster.png"));
      assert(error.message.includes("latest-retained.png"));
    }
  });

  test("peek --latest works with kept samples", async () => {
    const runDir = await createRunDir(tempDir);
    await createTestFrames(runDir, 5);
    await commandCleanup({ runDir, options: { "keep-samples": true } });
    const result = await commandPeek({ runDir, options: { latest: true } });
    assert(result.path.includes("frame-0005.png"));
    assert.strictEqual(result.pathCount, 2);
  });
});

if (hasRealFFmpeg()) {
  describe("render with real ffmpeg", () => {
    let tempDir;

    before(async () => {
      tempDir = path.join(
        "/tmp",
        `test-real-ffmpeg-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      await fs.mkdir(tempDir, { recursive: true });
    });

    after(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    test("real ffmpeg renders valid MP4", async () => {
      const runDir = await createRunDir(tempDir);
      await createNumericFrames(runDir, 3);
      const result = await commandRender({ runDir, options: {} });
      assert(result.path.endsWith("output.mp4"));
      assert.strictEqual(result.frameCount, 3);
      const stat = await fs.stat(result.path);
      assert(stat.size > 0);
      const summary = JSON.parse(
        await fs.readFile(path.join(runDir, "run-summary.json"), "utf8")
      );
      assert.ok(typeof summary.duration === "number" && summary.duration > 0);
      assert.ok(summary.dimensions && summary.dimensions.width > 0 && summary.dimensions.height > 0);
      assert.ok(Array.isArray(summary.ffmpegCommand));
      assert.strictEqual(summary.ffmpegCommand[0], "ffmpeg");
    });

    test("real ffmpeg with cleanup flow", async () => {
      const runDir = await createRunDir(tempDir);
      const framesDir = await createNumericFrames(runDir, 3);
      await commandRender({ runDir, options: {} });
      const cleanupResult = await commandCleanup({ runDir, options: {} });
      assert.strictEqual(cleanupResult.removed, 3);
      const dirStat = await fs.stat(framesDir).catch(() => null);
      assert.strictEqual(dirStat, null);
    });
  });
} else {
  test("real ffmpeg tests skipped (ffmpeg/ffprobe not found)", () => {
    assert.ok(true);
  });
}
