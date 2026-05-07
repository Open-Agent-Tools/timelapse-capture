import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { withFakeFFmpeg } from "./helpers/fake-ffmpeg.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI = path.join(__dirname, "..", "src", "timelapse-capture.mjs");

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

async function makeRun({ frameCount = 3, state = "completed" } = {}) {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "tlc-canonical-"));
  const framesDir = path.join(runDir, "frames");
  await fs.mkdir(framesDir);

  const captured = [];
  for (let index = 1; index <= frameCount; index += 1) {
    const relative = path.join("frames", `frame-${String(index).padStart(6, "0")}.png`);
    await fs.writeFile(path.join(runDir, relative), FRAME_PNG_1x1);
    captured.push({
      index,
      scheduledAt: new Date(Date.now() - (frameCount - index) * 1000).toISOString(),
      capturedAt: new Date(Date.now() - (frameCount - index) * 1000 + 50).toISOString(),
      path: relative,
      status: "captured",
      url: "http://example.test/",
      title: "fixture",
      viewport: { width: 1280, height: 720 },
      error: null
    });
  }

  const config = {
    version: "0.1.0",
    backend: "playwright-url",
    url: "http://example.test/",
    durationSeconds: frameCount,
    intervalSeconds: 1,
    expectedFrames: frameCount,
    fps: 24,
    viewport: { width: 1280, height: 720 },
    outDir: runDir,
    cleanup: "after-render",
    keepSamples: 0,
    keepLatest: false,
    waitUntil: "domcontentloaded",
    headed: false,
    createdAt: new Date().toISOString()
  };

  const status = {
    state,
    pid: 1234,
    startedAt: captured[0]?.scheduledAt ?? new Date().toISOString(),
    updatedAt: captured.at(-1)?.capturedAt ?? new Date().toISOString(),
    expectedFrames: frameCount,
    framesAttempted: frameCount,
    framesCaptured: frameCount,
    framesFailed: 0,
    latestFrame: captured.at(-1) ?? null
  };

  await fs.writeFile(path.join(runDir, "config.json"), JSON.stringify(config, null, 2));
  await fs.writeFile(path.join(runDir, "status.json"), JSON.stringify(status, null, 2));
  await fs.writeFile(
    path.join(runDir, "manifest.jsonl"),
    captured.map((record) => JSON.stringify(record)).join("\n") + "\n"
  );
  if (captured.length) {
    await fs.writeFile(path.join(runDir, "latest-frame.json"), JSON.stringify(captured.at(-1), null, 2));
  }

  return { runDir, captured, config, status };
}

test("status --json reports canonical state for a completed run", async () => {
  const { runDir } = await makeRun({ state: "completed" });
  try {
    const result = runCli(["status", runDir, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status.state, "completed");
    assert.equal(payload.status.framesCaptured, 3);
    assert.equal(payload.config.expectedFrames, 3);
    assert.ok(payload.latestFrame?.path?.endsWith(".png"));
    assert.ok(typeof payload.framesDiskUsageBytes === "number");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("peek --latest --json returns the latest captured frame", async () => {
  const { runDir, captured } = await makeRun();
  try {
    const result = runCli(["peek", runDir, "--latest", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.exists, true);
    assert.equal(payload.frame.index, captured.at(-1).index);
    assert.equal(payload.framePath, path.join(runDir, captured.at(-1).path));
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("render writes rendering then rendered states with fake ffmpeg", async () => {
  const { runDir } = await makeRun();
  try {
    await withFakeFFmpeg(async (manager) => {
      const result = runCli(["render", runDir, "--json"], { PATH: manager.getPATHEnv() });
      assert.equal(result.status, 0, result.stderr);
      const summary = JSON.parse(result.stdout);
      assert.ok(summary.output.endsWith("output.mp4"));
      assert.equal(summary.sourceFrames, 3);

      const status = JSON.parse(await fs.readFile(path.join(runDir, "status.json"), "utf8"));
      assert.equal(status.state, "rendered");
      assert.ok(status.renderedAt);
    }, "success");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("render writes render_failed when ffmpeg exits non-zero", async () => {
  const { runDir } = await makeRun();
  try {
    await withFakeFFmpeg(async (manager) => {
      const result = runCli(["render", runDir], { PATH: manager.getPATHEnv() });
      assert.notEqual(result.status, 0);

      const status = JSON.parse(await fs.readFile(path.join(runDir, "status.json"), "utf8"));
      assert.equal(status.state, "render_failed");
      assert.ok(status.error);
    }, "fail");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("cleanup refuses to delete frames before output.mp4 exists without --force", async () => {
  const { runDir } = await makeRun();
  try {
    const result = runCli(["cleanup", runDir]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to delete frames/);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("start command rejects missing URL clearly", async () => {
  const result = runCli(["start"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing URL/);
});

test("start command accepts positional URL and validates required flags", async () => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "tlc-start-positional-"));
  try {
    const result = runCli(["start", "http://example.com"], { PWD: workdir });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing --duration/);
  } finally {
    await fs.rm(workdir, { recursive: true, force: true });
  }
});

test("help command prints usage banner with the canonical commands", () => {
  const result = runCli(["help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /timelapse-capture/);
  assert.match(result.stdout, /start <url>/);
  assert.match(result.stdout, /doctor/);
});
