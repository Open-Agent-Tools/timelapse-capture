import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  cleanupFrames,
  commandCleanup,
  commandPeek,
  commandStatus,
  renderFrames,
  validateMP4,
  __test__
} from "../src/timelapse-capture.mjs";

const FRAME_PNG_1x1 = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000b49444154789c636060000000020001d75edeb0000000049454e44ae426082",
  "hex"
);

async function makeRun() {
  const runDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tlc-cleanup-errors-"));
  const framesDir = path.join(runDir, "frames");
  await fsp.mkdir(framesDir);
  await fsp.writeFile(path.join(framesDir, "frame-000001.png"), FRAME_PNG_1x1);
  await fsp.writeFile(path.join(runDir, "output.mp4"), "placeholder");
  return { runDir, framesDir };
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

test("cleanup --keep-samples reports one retained frame when only one frame exists", async () => {
  const { runDir } = await makeRun();
  try {
    const result = await commandCleanup({ runDir, options: { "keep-samples": true } });
    assert.equal(result.removed, 0);
    assert.equal(result.retained, 1);

    const summary = JSON.parse(await fsp.readFile(path.join(runDir, "run-summary.json"), "utf8"));
    assert.equal(summary.cleanup.removed, 0);
    assert.equal(summary.cleanup.retained, 1);
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test("cleanup --keep-samples keeps distinct first and last frames", async () => {
  const { runDir, framesDir } = await makeRun();
  try {
    await fsp.writeFile(path.join(framesDir, "frame-000002.png"), FRAME_PNG_1x1);
    await fsp.writeFile(path.join(framesDir, "frame-000003.png"), FRAME_PNG_1x1);

    const result = await commandCleanup({ runDir, options: { "keep-samples": true } });
    assert.equal(result.removed, 1);
    assert.equal(result.retained, 2);
    assert.deepEqual((await fsp.readdir(framesDir)).sort(), ["frame-000001.png", "frame-000003.png"]);

    const summary = JSON.parse(await fsp.readFile(path.join(runDir, "run-summary.json"), "utf8"));
    assert.equal(summary.cleanup.removed, 1);
    assert.equal(summary.cleanup.retained, 2);
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test("cleanup --frames ignores a non-empty frames directory after deleting raw frames", async () => {
  const { runDir, framesDir } = await makeRun();
  try {
    await fsp.writeFile(path.join(framesDir, "notes.txt"), "retain me");

    const result = await commandCleanup({ runDir, options: { frames: true } });
    assert.equal(result.removed, 1);
    assert.equal(await fsp.readFile(path.join(framesDir, "notes.txt"), "utf8"), "retain me");
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

test("commandStatus reports unexpected frames directory read errors", async () => {
  const runDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tlc-status-err-"));
  const statusPath = path.join(runDir, "status.json");
  const framesDir = path.join(runDir, "frames");
  await fsp.mkdir(framesDir);
  await fsp.writeFile(path.join(framesDir, "frame-000001.png"), FRAME_PNG_1x1);
  await fsp.writeFile(statusPath, JSON.stringify({ state: "completed" }));
  const originalReaddir = fsp.readdir;
  try {
    fsp.readdir = async (target, options) => {
      if (path.resolve(target) === path.resolve(framesDir)) {
        const error = new Error("permission denied");
        error.code = "EACCES";
        throw error;
      }
      return originalReaddir(target, options);
    };

    await assert.rejects(
      () => commandStatus({ runDir }),
      /permission denied/
    );
  } finally {
    fsp.readdir = originalReaddir;
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test("commandStatus accepts a missing frames directory as ENOENT fallback", async () => {
  const runDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tlc-status-ok-"));
  const statusPath = path.join(runDir, "status.json");
  await fsp.writeFile(statusPath, JSON.stringify({ state: "completed" }));
  const result = await commandStatus({ runDir });
  assert.equal(result.status.state, "completed");
  assert.equal(result.framesDiskUsageBytes, 0);
  await fsp.rm(runDir, { recursive: true, force: true });
});

test("commandPeek surfaces unexpected manifest read errors", async () => {
  const runDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tlc-peek-manifest-"));
  const framesDir = path.join(runDir, "frames");
  await fsp.mkdir(framesDir);
  await fsp.writeFile(path.join(framesDir, "frame-000001.png"), FRAME_PNG_1x1);
  const manifestPath = path.join(runDir, "manifest.jsonl");
  await fsp.writeFile(manifestPath, JSON.stringify({ status: "captured", capturedAt: new Date().toISOString(), path: "frames/frame-000001.png" }));
  const originalReadFile = fsp.readFile;
  try {
    fsp.readFile = async (target, options) => {
      if (path.resolve(target) === path.resolve(manifestPath)) {
        const error = new Error("permission denied");
        error.code = "EACCES";
        throw error;
      }
      return originalReadFile(target, options);
    };

    await assert.rejects(
      () => commandPeek({ runDir, options: { near: new Date().toISOString() } }),
      /permission denied/
    );
  } finally {
    fsp.readFile = originalReadFile;
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test("validateMP4 reports unexpected output size read errors", async () => {
  const runDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tlc-validate-mp4-"));
  const outputPath = path.join(runDir, "output.mp4");
  await fsp.writeFile(outputPath, "placeholder");
  const originalStatSync = fs.statSync;
  try {
    fs.statSync = () => {
      const error = new Error("permission denied");
      error.code = "EACCES";
      throw error;
    };

    const result = validateMP4(outputPath);
    assert.equal(result.exists, true);
    assert.equal(result.bytes, 0);
    assert.match(result.error, /Failed to read output file size/);
    assert.match(result.error, /permission denied/);
  } finally {
    fs.statSync = originalStatSync;
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test("commandCleanup surfaces unexpected runDir stat errors", async () => {
  const { runDir } = await makeRun();
  const originalStat = fsp.stat;
  try {
    fsp.stat = () => {
      const error = new Error("permission denied");
      error.code = "EACCES";
      throw error;
    };

    await assert.rejects(
      () => commandCleanup({ runDir }),
      /permission denied/
    );
  } finally {
    fsp.stat = originalStat;
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});
