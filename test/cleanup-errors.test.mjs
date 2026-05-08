import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { cleanupFrames, commandCleanup, renderFrames, __test__ } from "../src/timelapse-capture.mjs";

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
