import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withFakeFFmpeg } from "./helpers/fake-ffmpeg.mjs";
import { commandRender } from "../src/timelapse-capture.mjs";

const FRAME_PNG_1x1 = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000b49444154789c636060000000020001d75edeb0000000049454e44ae426082",
  "hex"
);

async function makeRun(config) {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "repro-280-"));
  const framesDir = path.join(runDir, "frames");
  await fs.mkdir(framesDir);
  await fs.writeFile(path.join(framesDir, "frame-0001.png"), FRAME_PNG_1x1);
  await fs.writeFile(path.join(runDir, "config.json"), JSON.stringify(config));
  await fs.writeFile(path.join(runDir, "status.json"), JSON.stringify({ state: "completed", frames: { captured: 1 } }));
  return runDir;
}

test("render respects cleanup: never from config.json", async () => {
  const runDir = await makeRun({ cleanup: "never" });
  try {
    await withFakeFFmpeg(async (manager) => {
      const originalPath = process.env.PATH;
      process.env.PATH = manager.getPATHEnv();
      try {
        await commandRender({ runDir, options: {} });
      } finally {
        process.env.PATH = originalPath;
      }
    });

    const framesExist = await fs.access(path.join(runDir, "frames", "frame-0001.png")).then(() => true, () => false);
    assert.ok(framesExist, "Frames should still exist when cleanup is 'never' in config.json");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("render CLI flag overrides config.json", async () => {
  const runDir = await makeRun({ cleanup: "never" });
  try {
    await withFakeFFmpeg(async (manager) => {
      const originalPath = process.env.PATH;
      process.env.PATH = manager.getPATHEnv();
      try {
        await commandRender({ runDir, options: { cleanup: "after-render" } });
      } finally {
        process.env.PATH = originalPath;
      }
    });

    const framesExist = await fs.access(path.join(runDir, "frames", "frame-0001.png")).then(() => true, () => false);
    assert.ok(!framesExist, "Frames should be removed when CLI override is 'after-render'");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("render respects keep-samples from config.json", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "repro-280-samples-"));
  const framesDir = path.join(runDir, "frames");
  await fs.mkdir(framesDir);
  await fs.writeFile(path.join(framesDir, "frame-0001.png"), FRAME_PNG_1x1);
  await fs.writeFile(path.join(framesDir, "frame-0002.png"), FRAME_PNG_1x1);
  await fs.writeFile(path.join(framesDir, "frame-0003.png"), FRAME_PNG_1x1);
  await fs.writeFile(path.join(runDir, "config.json"), JSON.stringify({ keepSamples: 1 }));
  await fs.writeFile(path.join(runDir, "status.json"), JSON.stringify({ state: "completed", frames: { captured: 3 } }));
  
  try {
    await withFakeFFmpeg(async (manager) => {
      const originalPath = process.env.PATH;
      process.env.PATH = manager.getPATHEnv();
      try {
        await commandRender({ runDir, options: {} });
      } finally {
        process.env.PATH = originalPath;
      }
    });

    const frames = await fs.readdir(framesDir);
    assert.deepEqual(frames.sort(), ["frame-0001.png", "frame-0003.png"], "Should keep first and last frame");
    
    const summary = JSON.parse(await fs.readFile(path.join(runDir, "run-summary.json"), "utf8"));
    assert.equal(summary.cleanup.source, "config", "Cleanup source should be 'config'");
    assert.equal(summary.cleanup.reason, "keep-samples", "Cleanup reason should be 'keep-samples'");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("render respects keep-latest from config.json", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "repro-280-latest-"));
  const framesDir = path.join(runDir, "frames");
  await fs.mkdir(framesDir);
  await fs.writeFile(path.join(framesDir, "frame-0001.png"), FRAME_PNG_1x1);
  await fs.writeFile(path.join(framesDir, "frame-0002.png"), FRAME_PNG_1x1);
  await fs.writeFile(path.join(runDir, "config.json"), JSON.stringify({ keepLatest: true }));
  await fs.writeFile(path.join(runDir, "status.json"), JSON.stringify({ state: "completed", frames: { captured: 2 } }));
  
  try {
    await withFakeFFmpeg(async (manager) => {
      const originalPath = process.env.PATH;
      process.env.PATH = manager.getPATHEnv();
      try {
        await commandRender({ runDir, options: {} });
      } finally {
        process.env.PATH = originalPath;
      }
    });

    const frames = await fs.readdir(framesDir);
    assert.deepEqual(frames.sort(), ["frame-0002.png"], "Should keep only latest frame");
    
    const summary = JSON.parse(await fs.readFile(path.join(runDir, "run-summary.json"), "utf8"));
    assert.equal(summary.cleanup.source, "config", "Cleanup source should be 'config'");
    assert.equal(summary.cleanup.reason, "keep-latest", "Cleanup reason should be 'keep-latest'");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});
