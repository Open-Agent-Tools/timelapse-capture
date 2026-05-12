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
const CLI = path.join(
  path.dirname(__filename),
  "..",
  "src",
  "timelapse-capture.mjs",
);

const FRAME_PNG_1x1 = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000b49444154789c636060000000020001d75edeb0000000049454e44ae426082",
  "hex",
);

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
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
  const runDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "tlc-cleanup-variants-"),
  );
  const framesDir = path.join(runDir, "frames");
  await fs.mkdir(framesDir);
  for (let index = 1; index <= frameCount; index += 1) {
    await fs.writeFile(
      path.join(framesDir, `frame-${String(index).padStart(4, "0")}.png`),
      FRAME_PNG_1x1,
    );
  }
  await fs.writeFile(path.join(runDir, "latest.png"), FRAME_PNG_1x1);
  await fs.writeFile(path.join(runDir, "output.mp4"), "placeholder");
  await fs.writeFile(
    path.join(runDir, "status.json"),
    JSON.stringify({ state: "completed", frames: { captured: frameCount } }),
  );
  return runDir;
}

test("cleanup default removes all frames and clears peek path", async () => {
  const runDir = await makeRun();
  try {
    const result = await runWithFakeFFmpeg(() =>
      commandCleanup({ runDir, options: {} }),
    );
    assert.equal(result.message, "Cleanup complete");
    assert.equal(result.removed, 3);
    assert.equal(
      await fs.stat(path.join(runDir, "frames")).then(
        () => true,
        () => false,
      ),
      false,
    );

    const peekResult = runCli(["peek", runDir, "--latest", "--json"]);
    assert.notEqual(peekResult.status, 0);
    assert.match(peekResult.stderr, /No frames available/);
    const summary = JSON.parse(
      await fs.readFile(path.join(runDir, "run-summary.json"), "utf8"),
    );
    assert.equal(summary.cleanup.bytesFreed, FRAME_PNG_1x1.length * 3);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("cleanup --keep-frames retains all frames and keeps peek available", async () => {
  const runDir = await makeRun();
  try {
    const result = await runWithFakeFFmpeg(() =>
      commandCleanup({ runDir, options: { "keep-frames": true } }),
    );
    assert.equal(result.message, "Frames preserved (--keep-frames)");
    assert.deepEqual((await fs.readdir(path.join(runDir, "frames"))).sort(), [
      "frame-0001.png",
      "frame-0002.png",
      "frame-0003.png",
    ]);

    const peekResult = runCli(["peek", runDir, "--latest", "--json"]);
    assert.equal(peekResult.status, 0, peekResult.stderr);
    const payload = JSON.parse(peekResult.stdout);
    assert.equal(payload.exists, true);
    assert.match(payload.path, /frame-0003\.png$/);
    const summary = JSON.parse(
      await fs.readFile(path.join(runDir, "run-summary.json"), "utf8"),
    );
    assert.equal(summary.cleanup.reason, "keep-frames");
    assert.equal(summary.cleanup.bytesFreed, 0);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("cleanup --keep-samples moves retained frames to samples/ and removes frames/", async () => {
  const runDir = await makeRun();
  try {
    const result = await runWithFakeFFmpeg(() =>
      commandCleanup({ runDir, options: { "keep-samples": 2 } }),
    );
    assert.equal(
      result.message,
      "Frames cleaned up (kept 2 samples in samples/)",
    );
    assert.equal(result.removed, 3);
    assert.equal(result.retained, 2);
    assert.deepEqual((await fs.readdir(path.join(runDir, "samples"))).sort(), [
      "sample-000001.png",
      "sample-000002.png",
    ]);

    const peekResult = runCli(["peek", runDir, "--latest", "--json"]);
    assert.notEqual(
      peekResult.status,
      0,
      "peek should fail without raw frames or fallback artifacts",
    );
    assert.match(peekResult.stderr, /Raw frames were cleaned up/);
    assert.match(peekResult.stderr, /poster\.png/);
    assert.match(peekResult.stderr, /latest-retained\.png/);
    assert.equal(
      peekResult.stdout,
      "",
      "peek should not emit a JSON payload from samples/",
    );
    const summary = JSON.parse(
      await fs.readFile(path.join(runDir, "run-summary.json"), "utf8"),
    );
    assert.equal(summary.cleanup.reason, "keep-samples");
    assert.equal(summary.cleanup.bytesFreed, FRAME_PNG_1x1.length * 3);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("cleanup --keep-samples 3 copies evenly distributed samples", async () => {
  const runDir = await makeRun({ frameCount: 10 });
  try {
    const result = await runWithFakeFFmpeg(() =>
      commandCleanup({ runDir, options: { "keep-samples": 3 } }),
    );
    assert.equal(result.retained, 3);
    assert.deepEqual((await fs.readdir(path.join(runDir, "samples"))).sort(), [
      "sample-000001.png",
      "sample-000002.png",
      "sample-000003.png",
    ]);
    assert.equal(
      await fs.stat(path.join(runDir, "frames")).then(
        () => true,
        () => false,
      ),
      false,
    );
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("cleanup --keep-samples (default) keeps 2 samples in samples/", async () => {
  const runDir = await makeRun({ frameCount: 10 });
  try {
    const result = await runWithFakeFFmpeg(() =>
      commandCleanup({ runDir, options: { "keep-samples": true } }),
    );
    assert.equal(result.retained, 2);
    assert.deepEqual((await fs.readdir(path.join(runDir, "samples"))).sort(), [
      "sample-000001.png",
      "sample-000002.png",
    ]);
    assert.equal(
      await fs.stat(path.join(runDir, "frames")).then(
        () => true,
        () => false,
      ),
      false,
    );
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("cleanup --keep-latest retains only the latest frame", async () => {
  const runDir = await makeRun();
  try {
    const result = await runWithFakeFFmpeg(() =>
      commandCleanup({ runDir, options: { "keep-latest": true } }),
    );
    assert.equal(result.message, "Frames cleaned up (kept latest)");
    assert.equal(result.removed, 2);
    assert.equal(result.retained, 1);
    assert.deepEqual((await fs.readdir(path.join(runDir, "frames"))).sort(), [
      "frame-0003.png",
    ]);

    const peekResult = runCli(["peek", runDir, "--latest", "--json"]);
    assert.equal(peekResult.status, 0, peekResult.stderr);
    assert.equal(JSON.parse(peekResult.stdout).frame.index, 3);
    const summary = JSON.parse(
      await fs.readFile(path.join(runDir, "run-summary.json"), "utf8"),
    );
    assert.equal(summary.cleanup.bytesFreed, FRAME_PNG_1x1.length * 2);
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
    assert.equal(payload.selection.source, "latest-retained");
    assert.equal(payload.selection.metadataAvailable, false);
    assert.equal(payload.frame, null);
    assert.equal(payload.fallback.source, "latest-retained");
    assert.equal(payload.fallback.path, path.join(runDir, "latest-retained.png"));
    assert.equal(path.isAbsolute(payload.fallback.path), true);
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
    assert.equal(payload.selection.source, "poster");
    assert.equal(payload.selection.metadataAvailable, false);
    assert.equal(payload.frame, null);
    assert.equal(payload.fallback.source, "poster");
    assert.equal(payload.fallback.path, path.join(runDir, "poster.png"));
    assert.equal(path.isAbsolute(payload.fallback.path), true);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("cleanup --frames removes frames and latest.png and records in summary", async () => {
  const runDir = await makeRun();
  try {
    const summaryPath = path.join(runDir, "run-summary.json");
    await fs.writeFile(summaryPath, JSON.stringify({ existing: "data" }));

    const result = await runWithFakeFFmpeg(() =>
      commandCleanup({ runDir, options: { frames: true } }),
    );
    assert.equal(result.message, "Raw frames and latest.png cleaned up");
    assert.equal(result.removed, 3);
    assert.equal(
      await fs.stat(path.join(runDir, "frames")).then(
        () => true,
        () => false,
      ),
      false,
    );
    assert.equal(
      await fs.stat(path.join(runDir, "latest.png")).then(
        () => true,
        () => false,
      ),
      false,
    );

    const summary = JSON.parse(await fs.readFile(summaryPath, "utf8"));
    assert.ok(summary.cleanup, "Summary should have cleanup information");
    assert.equal(summary.cleanup.success, true);
    assert.equal(summary.cleanup.removed, 3);
    assert.equal(summary.cleanup.retained, 0);
    assert.equal(summary.cleanup.reason, "frames");
    assert.ok(summary.cleanup.bytesFreed > 0, "bytesFreed should be recorded");
    assert.equal(
      summary.cleanup.latestPngRemoved,
      true,
      "latestPngRemoved should be true",
    );
    assert.ok(summary.cleanup.timestamp, "Cleanup should have a timestamp");
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

    const retainedFiles = await fs.readdir(path.join(runDir, "samples"));
    assert.equal(retainedFiles.length, 3);
    assert.equal(
      await fs.stat(path.join(runDir, "frames")).then(
        () => true,
        () => false,
      ),
      false,
    );
    const summary = JSON.parse(
      await fs.readFile(path.join(runDir, "run-summary.json"), "utf8"),
    );
    assert.equal(summary.cleanup.retained, 3);
    assert.equal(summary.cleanup.reason, "keep-samples");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("render picks up keepSamples from config.json", async () => {
  const runDir = await makeRun({ frameCount: 10 });
  try {
    await fs.writeFile(
      path.join(runDir, "config.json"),
      JSON.stringify({ keepSamples: 4 }),
    );
    await runWithFakeFFmpeg(async () => {
      await commandRender({ runDir, options: {} });
    });

    const retainedFiles = await fs.readdir(path.join(runDir, "samples"));
    assert.equal(retainedFiles.length, 4);
    assert.equal(
      await fs.stat(path.join(runDir, "frames")).then(
        () => true,
        () => false,
      ),
      false,
    );
    const summary = JSON.parse(
      await fs.readFile(path.join(runDir, "run-summary.json"), "utf8"),
    );
    assert.equal(summary.cleanup.retained, 4);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});
