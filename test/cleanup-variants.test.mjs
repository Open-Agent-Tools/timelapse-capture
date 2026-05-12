import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { withFakeFFmpeg } from "./helpers/fake-ffmpeg.mjs";

import { commandCleanup, commandRender } from "../src/timelapse-capture.mjs";

const __filename = fileURLToPath(import.meta.url);
const CLI = path.join(path.dirname(__filename), "..", "src", "timelapse-capture.mjs");

const FRAME_PNG_1x1 = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000b49444154789c636060000000020001d75edeb0000000049454e44ae426082",
  "hex"
);

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
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

async function makeRun({ frameCount = 3 } = {}) {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "tlc-cleanup-variants-"));
  const framesDir = path.join(runDir, "frames");
  await fs.mkdir(framesDir);
  for (let index = 1; index <= frameCount; index += 1) {
    await fs.writeFile(
      path.join(framesDir, `frame-${String(index).padStart(4, "0")}.png`),
      FRAME_PNG_1x1
    );
  }
  await fs.writeFile(path.join(runDir, "output.mp4"), "placeholder");
  await fs.writeFile(
    path.join(runDir, "status.json"),
    JSON.stringify({ state: "completed", frames: { captured: frameCount } })
  );
  return runDir;
}

test("cleanup default removes all frames and clears peek path", async () => {
  const runDir = await makeRun();
  try {
    const result = await runWithFakeFFmpeg(() => commandCleanup({ runDir, options: {} }));
    assert.equal(result.message, "Cleanup complete");
    assert.equal(result.removed, 3);
    assert.equal(await fs.stat(path.join(runDir, "frames")).then(() => true, () => false), false);

    const peekResult = runCli(["peek", runDir, "--latest", "--json"]);
    assert.notEqual(peekResult.status, 0);
    assert.match(peekResult.stderr, /No frames available/);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("cleanup --keep-frames retains all frames and keeps peek available", async () => {
  const runDir = await makeRun();
  try {
    const result = await runWithFakeFFmpeg(() => commandCleanup({ runDir, options: { "keep-frames": true } }));
    assert.equal(result.message, "Frames preserved (--keep-frames)");
    assert.deepEqual((await fs.readdir(path.join(runDir, "frames"))).sort(), [
      "frame-0001.png",
      "frame-0002.png",
      "frame-0003.png"
    ]);

    const peekResult = runCli(["peek", runDir, "--latest", "--json"]);
    assert.equal(peekResult.status, 0, peekResult.stderr);
    const payload = JSON.parse(peekResult.stdout);
    assert.equal(payload.exists, true);
    assert.match(payload.path, /frame-0003\.png$/);
  } finally {
      await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("cleanup --keep-samples retains first and last frame", async () => {
  const runDir = await makeRun();
  try {
    const result = await runWithFakeFFmpeg(() => commandCleanup({ runDir, options: { "keep-samples": 2 } }));
    assert.equal(result.message, "Frames cleaned up (kept first and last)");
    assert.equal(result.removed, 1);
    assert.equal(result.retained, 2);
    assert.deepEqual((await fs.readdir(path.join(runDir, "frames"))).sort(), [
      "frame-0001.png",
      "frame-0003.png"
    ]);

    const peekResult = runCli(["peek", runDir, "--latest", "--json"]);
    assert.equal(peekResult.status, 0, peekResult.stderr);
    assert.equal(JSON.parse(peekResult.stdout).frame.index, 3);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("cleanup --keep-samples 3 retains evenly distributed frames", async () => {
  const runDir = await makeRun({ frameCount: 10 });
  try {
    const result = await runWithFakeFFmpeg(() => commandCleanup({ runDir, options: { "keep-samples": 3 } }));
    assert.equal(result.retained, 3);
    assert.deepEqual((await fs.readdir(path.join(runDir, "frames"))).sort(), [
      "frame-0001.png",
      "frame-0006.png",
      "frame-0010.png"
    ]);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("cleanup --keep-samples (default) retains 5 frames", async () => {
  const runDir = await makeRun({ frameCount: 10 });
  try {
    const result = await runWithFakeFFmpeg(() => commandCleanup({ runDir, options: { "keep-samples": true } }));
    assert.equal(result.retained, 5);
    assert.deepEqual((await fs.readdir(path.join(runDir, "frames"))).sort(), [
      "frame-0001.png",
      "frame-0003.png",
      "frame-0006.png",
      "frame-0008.png",
      "frame-0010.png"
    ]);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("cleanup --keep-latest retains only the latest frame", async () => {
  const runDir = await makeRun();
  try {
    const result = await runWithFakeFFmpeg(() => commandCleanup({ runDir, options: { "keep-latest": true } }));
    assert.equal(result.message, "Frames cleaned up (kept latest)");
    assert.equal(result.removed, 2);
    assert.equal(result.retained, 1);
    assert.deepEqual((await fs.readdir(path.join(runDir, "frames"))).sort(), ["frame-0003.png"]);

    const peekResult = runCli(["peek", runDir, "--latest", "--json"]);
    assert.equal(peekResult.status, 0, peekResult.stderr);
    assert.equal(JSON.parse(peekResult.stdout).frame.index, 3);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("peek falls back to latest-retained.png when frames are cleaned up", async () => {
  const runDir = await makeRun();
  try {
    await fs.writeFile(path.join(runDir, "latest-retained.png"), FRAME_PNG_1x1);
    await runWithFakeFFmpeg(() => commandCleanup({ runDir, options: {} }));

    const peekResult = runCli(["peek", runDir, "--latest", "--json"]);
    assert.equal(peekResult.status, 0, peekResult.stderr);
    const payload = JSON.parse(peekResult.stdout);
    assert.equal(payload.exists, true);
    assert.match(payload.path, /latest-retained\.png$/);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("peek falls back to poster.png when frames are cleaned up", async () => {
  const runDir = await makeRun();
  try {
    await fs.writeFile(path.join(runDir, "poster.png"), FRAME_PNG_1x1);
    await runWithFakeFFmpeg(() => commandCleanup({ runDir, options: {} }));

    const peekResult = runCli(["peek", runDir, "--latest", "--json"]);
    assert.equal(peekResult.status, 0, peekResult.stderr);
    const payload = JSON.parse(peekResult.stdout);
    assert.equal(payload.exists, true);
    assert.match(payload.path, /poster\.png$/);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("render --keep-samples 3 retains 3 frames", async () => {
  const runDir = await makeRun({ frameCount: 10 });
  try {
    await fs.writeFile(path.join(runDir, "config.json"), JSON.stringify({}));
    await runWithFakeFFmpeg(async () => {
      await commandRender({ runDir, options: { "keep-samples": "3" } });
    });

    const retainedFiles = await fs.readdir(path.join(runDir, "frames"));
    assert.equal(retainedFiles.length, 3);
    const summary = JSON.parse(await fs.readFile(path.join(runDir, "run-summary.json"), "utf8"));
    assert.equal(summary.cleanup.retained, 3);
    assert.equal(summary.cleanup.reason, "keep-samples");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("render picks up keepSamples from config.json", async () => {
  const runDir = await makeRun({ frameCount: 10 });
  try {
    await fs.writeFile(path.join(runDir, "config.json"), JSON.stringify({ keepSamples: 4 }));
    await runWithFakeFFmpeg(async () => {
      await commandRender({ runDir, options: {} });
    });

    const retainedFiles = await fs.readdir(path.join(runDir, "frames"));
    assert.equal(retainedFiles.length, 4);
    const summary = JSON.parse(await fs.readFile(path.join(runDir, "run-summary.json"), "utf8"));
    assert.equal(summary.cleanup.retained, 4);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});
