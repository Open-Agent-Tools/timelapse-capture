import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { withFakeFFmpeg } from "./helpers/fake-ffmpeg.mjs";
import {
  commandCleanup,
  parseArgs,
  ParseError,
  resolveStartTiming
} from "../src/timelapse-capture.mjs";

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
    target: "http://example.test/",
    durationMs: frameCount * 1000,
    intervalMs: 1000,
    targetFrames: frameCount,
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
    framesAttempted: frameCount,
    frames: {
      captured: frameCount,
      failed: 0,
      totalExpected: frameCount
    },
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
    assert.equal(payload.status.frames.captured, 3);
    assert.equal(payload.config.targetFrames, 3);
    assert.ok(payload.latestFrame?.path?.endsWith(".png"));
    assert.ok(typeof payload.framesDiskUsageBytes === "number");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("start writes config.json with canonical field names only", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "tlc-start-config-"));
  try {
    const result = runCli(
      [
        "start",
        "http://example.test/",
        "--duration",
        "2s",
        "--interval",
        "1s",
        "--out",
        runDir,
        "--json"
      ],
      { TIMELAPSE_SIMULATE_FRAMES: "2" }
    );
    assert.equal(result.status, 0, result.stderr);

    const config = JSON.parse(await fs.readFile(path.join(runDir, "config.json"), "utf8"));
    assert.equal(config.target, "http://example.test/");
    assert.equal(config.intervalMs, 1000);
    assert.equal(config.durationMs, 2000);
    assert.equal(config.targetFrames, 2);
    assert.equal(Object.hasOwn(config, "url"), false);
    assert.equal(Object.hasOwn(config, "intervalSeconds"), false);
    assert.equal(Object.hasOwn(config, "durationSeconds"), false);
    assert.equal(Object.hasOwn(config, "expectedFrames"), false);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("status --json reports exact frame disk usage for nested directories", async () => {
  const { runDir } = await makeRun({ frameCount: 0, state: "completed" });
  try {
    const framesDir = path.join(runDir, "frames");
    const nestedDir = path.join(framesDir, "nested");
    const deeperDir = path.join(nestedDir, "deeper");
    const files = [
      { path: path.join(framesDir, "root.png"), data: "root-frame" },
      { path: path.join(nestedDir, "nested.png"), data: "nested-frame" },
      { path: path.join(deeperDir, "deep.png"), data: "deep-frame" }
    ];
    await fs.mkdir(deeperDir, { recursive: true });
    for (const file of files) {
      await fs.writeFile(file.path, file.data);
    }

    const result = runCli(["status", runDir, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(
      payload.framesDiskUsageBytes,
      files.reduce((sum, file) => sum + Buffer.byteLength(file.data), 0)
    );
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

test("peek --near --json returns the frame closest to an ISO timestamp", async () => {
  const { runDir, captured } = await makeRun({ frameCount: 4 });
  try {
    const nearTimestamp = new Date(
      new Date(captured[1].capturedAt).getTime() + 25
    ).toISOString();
    const result = runCli(["peek", runDir, "--near", nearTimestamp, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.exists, true);
    assert.equal(payload.frame.index, captured[1].index);
    assert.equal(payload.framePath, path.join(runDir, captured[1].path));
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("peek --near reports missing captured timestamps when manifest is absent", async () => {
  const { runDir, captured } = await makeRun();
  try {
    await fs.rm(path.join(runDir, "manifest.jsonl"));
    const result = runCli(["peek", runDir, "--near", captured.at(-1).capturedAt]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No captured frame timestamps are available for --near\./);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("peek --near guard does not fire for matching manifest and frames", async () => {
  const { runDir, captured } = await makeRun({ frameCount: 2 });
  try {
    const midMs =
      (new Date(captured[0].capturedAt).getTime() +
        new Date(captured[1].capturedAt).getTime()) /
      2;
    const result = runCli(["peek", runDir, "--near", new Date(midMs).toISOString(), "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.exists, true);
    assert.match(payload.framePath, /\.png$/);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("peek --near rejects invalid timestamps", async () => {
  const { runDir } = await makeRun();
  try {
    const result = runCli(["peek", runDir, "--near", "not-a-date"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Invalid ISO timestamp for --near/);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("peek --near with no captured frame timestamps exits non-zero", async () => {
  const { runDir } = await makeRun({ frameCount: 2 });
  try {
    const manifestPath = path.join(runDir, "manifest.jsonl");
    const failedRecords = [
      { index: 1, scheduledAt: new Date().toISOString(), capturedAt: null, path: "frames/frame-000001.png", status: "failed", error: "timeout" },
      { index: 2, scheduledAt: new Date().toISOString(), capturedAt: null, path: "frames/frame-000002.png", status: "failed", error: "timeout" }
    ];
    await fs.writeFile(manifestPath, failedRecords.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const result = runCli(["peek", runDir, "--near", new Date().toISOString()]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /No captured frame timestamps are available for --near/);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("peek --near rejects a plain integer (use --index instead)", async () => {
  const { runDir } = await makeRun();
  try {
    const result = runCli(["peek", runDir, "--near", "5"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Invalid ISO timestamp for --near/);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("peek --near rejects a year-only string that parseInt would have accepted", async () => {
  const { runDir } = await makeRun();
  try {
    const result = runCli(["peek", runDir, "--near", "2026"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Invalid ISO timestamp for --near/);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("peek --near selects first, middle, and last frame by timestamp proximity", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "tlc-canonical-"));
  try {
    const framesDir = path.join(runDir, "frames");
    await fs.mkdir(framesDir);

    const timestamps = [
      "2026-01-01T12:00:00Z",
      "2026-01-01T12:01:00Z",
      "2026-01-01T12:02:00Z"
    ];
    const captured = [];
    for (let i = 0; i < timestamps.length; i += 1) {
      const index = i + 1;
      const relative = path.join("frames", `frame-${String(index).padStart(6, "0")}.png`);
      await fs.writeFile(path.join(runDir, relative), FRAME_PNG_1x1);
      captured.push({
        index,
        scheduledAt: timestamps[i],
        capturedAt: timestamps[i],
        path: relative,
        status: "captured",
        url: "http://example.test/",
        title: "fixture",
        viewport: { width: 1280, height: 720 },
        error: null
      });
    }
    await fs.writeFile(path.join(runDir, "status.json"), JSON.stringify({ state: "completed" }));
    await fs.writeFile(
      path.join(runDir, "manifest.jsonl"),
      captured.map((r) => JSON.stringify(r)).join("\n") + "\n"
    );

    const r1 = runCli(["peek", runDir, "--near", "2026-01-01T12:00:20Z", "--json"]);
    assert.equal(r1.status, 0, r1.stderr);
    assert.equal(JSON.parse(r1.stdout).framePath, path.join(runDir, captured[0].path));

    const r2 = runCli(["peek", runDir, "--near", "2026-01-01T12:01:10Z", "--json"]);
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(JSON.parse(r2.stdout).framePath, path.join(runDir, captured[1].path));

    const r3 = runCli(["peek", runDir, "--near", "2026-01-01T12:02:40Z", "--json"]);
    assert.equal(r3.status, 0, r3.stderr);
    assert.equal(JSON.parse(r3.stdout).framePath, path.join(runDir, captured[2].path));
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
      assert.equal(summary.frameCount, 3);

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

test("render succeeds when status.json is initially missing", async () => {
  const { runDir } = await makeRun();
  try {
    await fs.rm(path.join(runDir, "status.json"));
    await withFakeFFmpeg(async (manager) => {
      const result = runCli(["render", runDir, "--json", "--force"], { PATH: manager.getPATHEnv() });
      assert.equal(result.status, 0, result.stderr);

      const status = JSON.parse(await fs.readFile(path.join(runDir, "status.json"), "utf8"));
      assert.equal(status.state, "rendered");
    }, "success");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("render leaves no .tmp status file after success", async () => {
  const { runDir } = await makeRun();
  try {
    await withFakeFFmpeg(async (manager) => {
      const result = runCli(["render", runDir, "--json"], { PATH: manager.getPATHEnv() });
      assert.equal(result.status, 0, result.stderr);

      const statusJson = await fs.readFile(path.join(runDir, "status.json"), "utf8");
      const status = JSON.parse(statusJson);
      assert.equal(status.state, "rendered");

      const entries = await fs.readdir(runDir);
      assert.deepEqual(
        entries.filter((entry) => entry.startsWith("status.json.tmp-")),
        []
      );
    }, "success");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("render succeeds with sparse (gapped) frame numbering", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "tlc-sparse-"));
  const framesDir = path.join(runDir, "frames");
  await fs.mkdir(framesDir);
  const indices = [1, 3, 5];
  for (const index of indices) {
    await fs.writeFile(
      path.join(framesDir, `frame-${String(index).padStart(4, "0")}.png`),
      FRAME_PNG_1x1
    );
  }
  const status = {
    state: "completed",
    pid: 1234,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    framesAttempted: 5,
    frames: {
      captured: 3,
      failed: 2,
      totalExpected: 5
    },
    latestFrame: null
  };
  const config = {
    version: "0.1.0",
    backend: "playwright-url",
    target: "http://example.test/",
    durationMs: 5000,
    intervalMs: 1000,
    targetFrames: 5,
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
  await fs.writeFile(path.join(runDir, "config.json"), JSON.stringify(config, null, 2));
  await fs.writeFile(path.join(runDir, "status.json"), JSON.stringify(status, null, 2));

  try {
    await withFakeFFmpeg(async (manager) => {
      const result = runCli(["render", runDir, "--json"], { PATH: manager.getPATHEnv() });
      assert.equal(result.status, 0, result.stderr);
      const summary = JSON.parse(result.stdout);
      assert.equal(summary.frameCount, 3);
      const ffmpegArgs = JSON.parse(
        await fs.readFile(path.join(manager.outputDir, "ffmpeg-args.json"), "utf8")
      );
      const inputPattern = ffmpegArgs[ffmpegArgs.indexOf("-i") + 1];
      assert.equal(path.basename(inputPattern), "frame-%04d.png");
      assert.equal(path.basename(path.dirname(inputPattern)), ".render-staging");

      const finalStatus = JSON.parse(await fs.readFile(path.join(runDir, "status.json"), "utf8"));
      assert.equal(finalStatus.state, "rendered");

      const stagingDir = path.join(framesDir, ".render-staging");
      const stagingExists = await fs.stat(stagingDir).then(() => true, () => false);
      assert.equal(stagingExists, false, "staging directory should be cleaned up");
    }, "success-require-contiguous-input");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("render replaces stale sparse-frame staging before restaging", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "tlc-stale-staging-"));
  const framesDir = path.join(runDir, "frames");
  const stagingDir = path.join(framesDir, ".render-staging");
  await fs.mkdir(stagingDir, { recursive: true });
  const indices = [1, 3, 5];
  for (const index of indices) {
    await fs.writeFile(
      path.join(framesDir, `frame-${String(index).padStart(4, "0")}.png`),
      FRAME_PNG_1x1
    );
  }
  await fs.writeFile(path.join(stagingDir, "frame-0001.png"), "stale fixture");
  const status = {
    state: "completed",
    pid: 1234,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expectedFrames: 5,
    framesAttempted: 5,
    framesCaptured: 3,
    framesFailed: 2,
    latestFrame: null
  };
  const config = {
    version: "0.1.0",
    backend: "playwright-url",
    url: "http://example.test/",
    durationSeconds: 5,
    intervalSeconds: 1,
    expectedFrames: 5,
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
  await fs.writeFile(path.join(runDir, "config.json"), JSON.stringify(config, null, 2));
  await fs.writeFile(path.join(runDir, "status.json"), JSON.stringify(status, null, 2));

  try {
    await withFakeFFmpeg(async (manager) => {
      const result = runCli(["render", runDir, "--json"], { PATH: manager.getPATHEnv() });
      assert.equal(result.status, 0, result.stderr);
      const summary = JSON.parse(result.stdout);
      assert.equal(summary.sourceFrames, 3);

      const finalStatus = JSON.parse(await fs.readFile(path.join(runDir, "status.json"), "utf8"));
      assert.equal(finalStatus.state, "rendered");

      const stagingExists = await fs.stat(stagingDir).then(() => true, () => false);
      assert.equal(stagingExists, false, "staging directory should be cleaned up");
    }, "success-require-contiguous-input");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("render with contiguous frames skips staging", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "tlc-contiguous-"));
  const framesDir = path.join(runDir, "frames");
  await fs.mkdir(framesDir);
  for (let index = 1; index <= 3; index++) {
    await fs.writeFile(
      path.join(framesDir, `frame-${String(index).padStart(4, "0")}.png`),
      FRAME_PNG_1x1
    );
  }
  const status = {
    state: "completed",
    pid: 1234,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    framesAttempted: 3,
    frames: {
      captured: 3,
      failed: 0,
      totalExpected: 3
    },
    latestFrame: null
  };
  const config = {
    version: "0.1.0",
    backend: "playwright-url",
    target: "http://example.test/",
    durationMs: 3000,
    intervalMs: 1000,
    targetFrames: 3,
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
  await fs.writeFile(path.join(runDir, "config.json"), JSON.stringify(config, null, 2));
  await fs.writeFile(path.join(runDir, "status.json"), JSON.stringify(status, null, 2));

  try {
    await withFakeFFmpeg(async (manager) => {
      const result = runCli(["render", runDir, "--json"], { PATH: manager.getPATHEnv() });
      assert.equal(result.status, 0, result.stderr);
      const summary = JSON.parse(result.stdout);
      assert.equal(summary.frameCount, 3);

      const finalStatus = JSON.parse(await fs.readFile(path.join(runDir, "status.json"), "utf8"));
      assert.equal(finalStatus.state, "rendered");
    }, "success");
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

test("cleanup --keep-samples reports one retained frame for a one-frame run", async () => {
  const { runDir } = await makeRun({ frameCount: 1 });
  try {
    await fs.writeFile(path.join(runDir, "output.mp4"), "rendered");

    const result = await commandCleanup({ runDir, options: { "keep-samples": true } });
    assert.equal(result.removed, 0);
    assert.equal(result.retained, 1);
    const frames = await fs.readdir(path.join(runDir, "frames"));
    assert.deepEqual(frames.sort(), ["frame-000001.png"]);

    const summary = JSON.parse(await fs.readFile(path.join(runDir, "run-summary.json"), "utf8"));
    assert.equal(summary.cleanup.success, true);
    assert.equal(summary.cleanup.removed, 0);
    assert.equal(summary.cleanup.retained, 1);
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

test("start parser accepts video length and fps options", () => {
  const parsed = parseArgs([
    "start",
    "http://example.test",
    "--duration",
    "2h",
    "--video-length",
    "1m",
    "--fps",
    "24"
  ]);

  assert.equal(parsed.options.duration.ms, 7_200_000);
  assert.equal(parsed.options["video-length"].ms, 60_000);
  assert.equal(parsed.options.fps, 24);
});

test("start parser rejects video length and interval together", () => {
  assert.throws(
    () => parseArgs([
      "start",
      "http://example.test",
      "--duration",
      "2h",
      "--video-length",
      "1m",
      "--interval",
      "5s"
    ]),
    (error) => error instanceof ParseError
      && /--video-length.*--interval|--interval.*--video-length/.test(error.message)
  );
});

test("start parser still requires duration with video length", () => {
  const result = runCli(["start", "http://example.test", "--video-length", "1m"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing --duration/);
});

test("start timing derives interval from target video length", () => {
  const timing = resolveStartTiming({
    duration: { ms: 7_200_000 },
    "video-length": { ms: 60_000 },
    fps: 24
  });

  assert.equal(timing.durationMs, 7_200_000);
  assert.equal(timing.videoLengthMs, 60_000);
  assert.equal(timing.fps, 24);
  assert.equal(timing.targetFrames, 1440);
  assert.equal(timing.intervalMs, 5000);
  assert.equal(timing.computedFromVideoLength, true);
});

test("start timing keeps explicit interval behavior unchanged", () => {
  const timing = resolveStartTiming({
    duration: { ms: 10_000 },
    interval: 250,
    fps: 12
  });

  assert.equal(timing.intervalMs, 250);
  assert.equal(timing.targetFrames, 40);
  assert.equal(timing.fps, 12);
  assert.equal(timing.computedFromVideoLength, false);
});

test("start command warns when computed video length interval is below one second", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "tlc-video-length-"));
  try {
    const result = runCli(
      [
        "start",
        "http://example.test",
        "--duration",
        "1s",
        "--video-length",
        "2s",
        "--fps",
        "2",
        "--out",
        runDir,
        "--json"
      ],
      { TIMELAPSE_SIMULATE_FRAMES: "1" }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /warning: computed interval 250ms is below 1000ms/);
    assert.equal(JSON.parse(result.stdout).status.intervalMs, 250);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("help command prints usage banner with the canonical commands", () => {
  const result = runCli(["help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /timelapse-capture/);
  assert.match(result.stdout, /start <url>/);
  assert.match(result.stdout, /--video-length/);
  assert.match(result.stdout, /--fps/);
  assert.match(result.stdout, /doctor/);
});
