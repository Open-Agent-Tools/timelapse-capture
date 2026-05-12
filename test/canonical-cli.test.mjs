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
  commandRender,
  parseArgs,
  ParseError,
  resolveStartTiming,
} from "../src/timelapse-capture.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI = path.join(__dirname, "..", "src", "timelapse-capture.mjs");

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForTerminalStatus(runDir, { timeoutMs = 5000 } = {}) {
  const started = Date.now();
  let status;
  while (Date.now() - started < timeoutMs) {
    status = JSON.parse(
      await fs.readFile(path.join(runDir, "status.json"), "utf8"),
    );
    const job = JSON.parse(
      await fs.readFile(path.join(runDir, "job.json"), "utf8"),
    );
    if (
      (status.state === "completed" || status.state === "failed") &&
      (job.state === "completed" || job.state === "failed")
    ) {
      return status;
    }
    await sleep(25);
  }
  assert.fail(
    `Timed out waiting for terminal status. Last status: ${JSON.stringify(status)}`,
  );
}

async function makeRun({ frameCount = 3, state = "completed" } = {}) {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "tlc-canonical-"));
  const framesDir = path.join(runDir, "frames");
  await fs.mkdir(framesDir);

  const captured = [];
  for (let index = 1; index <= frameCount; index += 1) {
    const relative = path.join(
      "frames",
      `frame-${String(index).padStart(6, "0")}.png`,
    );
    await fs.writeFile(path.join(runDir, relative), FRAME_PNG_1x1);
    captured.push({
      index,
      scheduledAt: new Date(
        Date.now() - (frameCount - index) * 1000,
      ).toISOString(),
      capturedAt: new Date(
        Date.now() - (frameCount - index) * 1000 + 50,
      ).toISOString(),
      path: relative,
      status: "captured",
      url: "http://example.test/",
      title: "fixture",
      viewport: { width: 1280, height: 720 },
      error: null,
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
    createdAt: new Date().toISOString(),
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
      totalExpected: frameCount,
    },
    latestFrame: captured.at(-1) ?? null,
  };

  await fs.writeFile(
    path.join(runDir, "config.json"),
    JSON.stringify(config, null, 2),
  );
  await fs.writeFile(
    path.join(runDir, "status.json"),
    JSON.stringify(status, null, 2),
  );
  await fs.writeFile(
    path.join(runDir, "manifest.jsonl"),
    captured.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
  if (captured.length) {
    await fs.writeFile(
      path.join(runDir, "latest-frame.json"),
      JSON.stringify(captured.at(-1), null, 2),
    );
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

test("status --json round-trips status.json with canonical frames object", async () => {
  const { runDir, captured } = await makeRun({
    frameCount: 3,
    state: "completed",
  });
  try {
    const statusPath = path.join(runDir, "status.json");
    const status = {
      state: "completed",
      pid: 1234,
      startedAt: captured[0]?.capturedAt ?? new Date().toISOString(),
      updatedAt: captured.at(-1)?.capturedAt ?? new Date().toISOString(),
      frames: {
        captured: 3,
        failed: 0,
        totalExpected: 3,
      },
      latestFrame: captured.at(-1) ?? null,
    };

    await fs.writeFile(statusPath, JSON.stringify(status, null, 2));

    const result = runCli(["status", runDir, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status.frames.captured, 3);
    assert.equal(payload.status.frames.failed, 0);
    assert.equal(payload.status.frames.totalExpected, 3);
    assert.equal(Object.hasOwn(payload.status, "framesCaptured"), false);
    assert.equal(Object.hasOwn(payload.status, "frameCount"), false);
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
        "--json",
      ],
      { TIMELAPSE_SIMULATE_FRAMES: "2" },
    );
    assert.equal(result.status, 0, result.stderr);

    const config = JSON.parse(
      await fs.readFile(path.join(runDir, "config.json"), "utf8"),
    );
    assert.equal(config.target, "http://example.test/");
    assert.equal(config.intervalMs, 1000);
    assert.equal(config.durationMs, 2000);
    assert.equal(config.targetFrames, 2);
    assert.equal(Object.hasOwn(config, "url"), false);
    assert.equal(Object.hasOwn(config, "intervalSeconds"), false);
    assert.equal(Object.hasOwn(config, "durationSeconds"), false);
    assert.equal(Object.hasOwn(config, "expectedFrames"), false);
    await waitForTerminalStatus(runDir);
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
      { path: path.join(deeperDir, "deep.png"), data: "deep-frame" },
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
      files.reduce((sum, file) => sum + Buffer.byteLength(file.data), 0),
    );
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("status --json includes status.diskUsage with runDirBytes and framesBytes", async () => {
  const { runDir } = await makeRun({ frameCount: 2 });
  try {
    const result = runCli(["status", runDir, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.ok(
      typeof payload.status.diskUsage === "object" &&
        payload.status.diskUsage !== null,
    );
    assert.ok(typeof payload.status.diskUsage.runDirBytes === "number");
    assert.ok(typeof payload.status.diskUsage.framesBytes === "number");
    assert.ok(payload.status.diskUsage.framesBytes > 0);
    assert.ok(
      payload.status.diskUsage.runDirBytes >=
        payload.status.diskUsage.framesBytes,
    );
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("status --json has null outputPath and null cleanup when no run-summary exists", async () => {
  const { runDir } = await makeRun();
  try {
    const result = runCli(["status", runDir, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status.outputPath, null);
    assert.equal(payload.status.cleanup, null);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("status --json includes outputPath and cleanup from run-summary when present", async () => {
  const { runDir } = await makeRun({ state: "rendered" });
  try {
    const fakeOutputPath = path.join(runDir, "output.mp4");
    const summary = {
      render: {
        outputPath: fakeOutputPath,
        bytes: 12345,
        duration: 1.5,
        dimensions: { width: 1280, height: 720 },
        sourceFrameCount: 3,
        timestamp: new Date().toISOString(),
      },
      cleanup: {
        success: true,
        removed: 3,
        retained: 0,
        timestamp: new Date().toISOString(),
      },
    };
    await fs.writeFile(
      path.join(runDir, "run-summary.json"),
      JSON.stringify(summary, null, 2),
    );

    const result = runCli(["status", runDir, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status.outputPath, fakeOutputPath);
    assert.ok(
      payload.status.cleanup !== null &&
        typeof payload.status.cleanup === "object",
    );
    assert.equal(payload.status.cleanup.success, true);
    assert.equal(payload.status.cleanup.removed, 3);
    assert.equal(payload.status.cleanup.retained, 0);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("status --human output includes stale warning when latest frame is stale", async () => {
  const { runDir } = await makeRun({ state: "running" });
  try {
    const intervalMs = 5_000;
    const staleAgeMs = 60_000;
    const latestFrameTimestamp = new Date(
      Date.now() - staleAgeMs,
    ).toISOString();
    const startedAt = new Date(Date.now() - 120_000).toISOString();
    await fs.writeFile(
      path.join(runDir, "status.json"),
      JSON.stringify(
        {
          state: "running",
          startedAt,
          intervalMs,
          frames: { captured: 1, failed: 0, totalExpected: 5 },
          latestFrameTimestamp,
        },
        null,
        2,
      ),
    );

    const result = runCli(["status", runDir]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^state: running$/m);
    assert.match(result.stdout, /^eta: /m);
    assert.match(result.stdout, /warning: latest successful frame is stale/);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("status --human output omits eta line for non-running states", async () => {
  const { runDir } = await makeRun({ state: "completed" });
  try {
    const result = runCli(["status", runDir]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^state: completed$/m);
    assert.doesNotMatch(result.stdout, /^eta: /m);
    assert.doesNotMatch(
      result.stdout,
      /warning: latest successful frame is stale/,
    );
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("status --human output prints output and cleanup summary", async () => {
  const { runDir } = await makeRun();
  try {
    await withFakeFFmpeg(async (manager) => {
      const renderResult = runCli(["render", runDir, "--json"], {
        PATH: manager.getPATHEnv(),
      });
      assert.equal(renderResult.status, 0, renderResult.stderr);

      const statusResult = runCli(["status", runDir]);
      assert.equal(statusResult.status, 0, statusResult.stderr);
      assert.match(
        statusResult.stdout,
        new RegExp(`^output: .*output\\.mp4$`, "m"),
      );
      assert.match(
        statusResult.stdout,
        /^cleanup: removed \d+, retained \d+$/m,
      );
    }, "success");
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
      new Date(captured[1].capturedAt).getTime() + 25,
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
    const result = runCli([
      "peek",
      runDir,
      "--near",
      captured.at(-1).capturedAt,
    ]);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /No captured frame timestamps are available for --near\./,
    );
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
    const result = runCli([
      "peek",
      runDir,
      "--near",
      new Date(midMs).toISOString(),
      "--json",
    ]);
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
      {
        index: 1,
        scheduledAt: new Date().toISOString(),
        capturedAt: null,
        path: "frames/frame-000001.png",
        status: "failed",
        error: "timeout",
      },
      {
        index: 2,
        scheduledAt: new Date().toISOString(),
        capturedAt: null,
        path: "frames/frame-000002.png",
        status: "failed",
        error: "timeout",
      },
    ];
    await fs.writeFile(
      manifestPath,
      failedRecords.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );

    const result = runCli(["peek", runDir, "--near", new Date().toISOString()]);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /No captured frame timestamps are available for --near/,
    );
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
      "2026-01-01T12:02:00Z",
    ];
    const captured = [];
    for (let i = 0; i < timestamps.length; i += 1) {
      const index = i + 1;
      const relative = path.join(
        "frames",
        `frame-${String(index).padStart(6, "0")}.png`,
      );
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
        error: null,
      });
    }
    await fs.writeFile(
      path.join(runDir, "status.json"),
      JSON.stringify({ state: "completed" }),
    );
    await fs.writeFile(
      path.join(runDir, "manifest.jsonl"),
      captured.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );

    const r1 = runCli([
      "peek",
      runDir,
      "--near",
      "2026-01-01T12:00:20Z",
      "--json",
    ]);
    assert.equal(r1.status, 0, r1.stderr);
    assert.equal(
      JSON.parse(r1.stdout).framePath,
      path.join(runDir, captured[0].path),
    );

    const r2 = runCli([
      "peek",
      runDir,
      "--near",
      "2026-01-01T12:01:10Z",
      "--json",
    ]);
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(
      JSON.parse(r2.stdout).framePath,
      path.join(runDir, captured[1].path),
    );

    const r3 = runCli([
      "peek",
      runDir,
      "--near",
      "2026-01-01T12:02:40Z",
      "--json",
    ]);
    assert.equal(r3.status, 0, r3.stderr);
    assert.equal(
      JSON.parse(r3.stdout).framePath,
      path.join(runDir, captured[2].path),
    );
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("render writes rendering then rendered states with fake ffmpeg", async () => {
  const { runDir } = await makeRun();
  try {
    await fs.writeFile(path.join(runDir, "render.log"), "[prior] previous render\n");

    await withFakeFFmpeg(async (manager) => {
      const result = runCli(["render", runDir, "--json"], {
        PATH: manager.getPATHEnv(),
      });
      assert.equal(result.status, 0, result.stderr);
      const summary = JSON.parse(result.stdout);
      assert.ok(summary.output.endsWith("output.mp4"));
      assert.equal(summary.sourceFrameCount, 3);

      const onDisk = JSON.parse(
        await fs.readFile(path.join(runDir, "run-summary.json"), "utf8"),
      );
      assert.equal(onDisk.render.outputPath, path.join(runDir, "output.mp4"));
      assert.equal(onDisk.render.bytes > 0, true);
      assert.equal(onDisk.render.duration, 10);
      assert.deepEqual(onDisk.render.dimensions, { width: 1280, height: 720 });
      assert.equal(onDisk.render.sourceFrameCount, 3);
      assert.ok(Array.isArray(onDisk.render.ffmpegCommand));
      assert.equal(onDisk.render.ffmpegCommand[0].includes("ffmpeg"), true);
      assert.equal(onDisk.cleanup.success, true);
      assert.equal(onDisk.cleanup.removed, 3);
      assert.equal(onDisk.cleanup.retained, 0);
      assert.equal(onDisk.cleanup.error, null);
      assert.ok(typeof onDisk.cleanup.timestamp === "string");

      const status = JSON.parse(
        await fs.readFile(path.join(runDir, "status.json"), "utf8"),
      );
      assert.equal(status.state, "rendered");
      assert.ok(status.renderedAt);

      const renderLog = await fs.readFile(path.join(runDir, "render.log"), "utf8");
      assert.match(renderLog, /^\[prior\] previous render\n\[/);
      assert.match(renderLog, /^\[[^\]]+\] render attempt started/m);
      assert.match(renderLog, /^\[[^\]]+\] fake ffmpeg stdout: render started/m);
      assert.match(renderLog, /^\[[^\]]+\] fake ffmpeg stderr: render details/m);
      assert.match(renderLog, /^\[[^\]]+\] render attempt succeeded/m);

      const framesDirExists = await fs.stat(path.join(runDir, "frames")).then(
        () => true,
        (error) => {
          if (error.code === "ENOENT") return false;
          throw error;
        }
      );
      assert.equal(framesDirExists, false);
    }, "success");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("render with fake ffmpeg success mode does not create -version artifact", async () => {
  const { runDir } = await makeRun();
  const cwd = await fs.mkdtemp(
    path.join(os.tmpdir(), "tlc-ffmpeg-version-cwd-"),
  );
  try {
    await withFakeFFmpeg(async (manager) => {
      const result = spawnSync(
        process.execPath,
        [CLI, "render", runDir, "--json"],
        {
          encoding: "utf8",
          cwd,
          env: { ...process.env, PATH: manager.getPATHEnv() },
        },
      );
      assert.equal(result.status, 0, result.stderr);

      const summary = JSON.parse(result.stdout);
      const outputPath = path.join(runDir, "output.mp4");
      assert.equal(summary.output, outputPath);
      assert.equal(await fs.stat(outputPath).then(() => true), true);

      const versionArtifactExists = await fs
        .stat(path.join(cwd, "-version"))
        .then(
          () => true,
          (error) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        );
      assert.equal(versionArtifactExists, false);
    }, "success");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("render uses fps from run config for ffmpeg framerate", async () => {
  const { runDir, config } = await makeRun();
  try {
    await fs.writeFile(
      path.join(runDir, "config.json"),
      JSON.stringify({ ...config, fps: 12 }, null, 2),
    );

    await withFakeFFmpeg(async (manager) => {
      const result = runCli(["render", runDir, "--json"], {
        PATH: manager.getPATHEnv(),
      });
      assert.equal(result.status, 0, result.stderr);

      const ffmpegArgs = JSON.parse(
        await fs.readFile(
          path.join(manager.outputDir, "ffmpeg-args.json"),
          "utf8",
        ),
      );
      const framerateIdx = ffmpegArgs.indexOf("-framerate");
      assert.notEqual(framerateIdx, -1);
      assert.equal(ffmpegArgs[framerateIdx + 1], "12");

      const summary = JSON.parse(
        await fs.readFile(path.join(runDir, "run-summary.json"), "utf8"),
      );
      assert.equal(summary.render.framerate, 12);
    }, "success-require-contiguous-input");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("commandRender framerate option overrides config fps", async () => {
  const { runDir, config } = await makeRun();
  try {
    await fs.writeFile(
      path.join(runDir, "config.json"),
      JSON.stringify({ ...config, fps: 12 }, null, 2),
    );

    await withFakeFFmpeg(async (manager) => {
      const originalPath = process.env.PATH;
      process.env.PATH = manager.getPATHEnv();
      try {
        await commandRender({ runDir, options: { framerate: 30 } });
      } finally {
        process.env.PATH = originalPath;
      }

      const ffmpegArgs = JSON.parse(
        await fs.readFile(
          path.join(manager.outputDir, "ffmpeg-args.json"),
          "utf8",
        ),
      );
      const framerateIdx = ffmpegArgs.indexOf("-framerate");
      assert.equal(ffmpegArgs[framerateIdx + 1], "30");

      const summary = JSON.parse(
        await fs.readFile(path.join(runDir, "run-summary.json"), "utf8"),
      );
      assert.equal(summary.render.framerate, 30);
    }, "success-require-contiguous-input");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("render failure records effective framerate", async () => {
  const { runDir, config } = await makeRun();
  try {
    await fs.writeFile(
      path.join(runDir, "config.json"),
      JSON.stringify({ ...config, fps: 12 }, null, 2),
    );

    await withFakeFFmpeg(async (manager) => {
      const result = runCli(["render", runDir, "--json"], {
        PATH: manager.getPATHEnv(),
      });
      assert.notEqual(result.status, 0);

      const summary = JSON.parse(
        await fs.readFile(path.join(runDir, "run-summary.json"), "utf8"),
      );
      assert.equal(summary.lastRenderAttempt.framerate, 12);
    }, "fail");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("render with --keep-frames records retained cleanup summary", async () => {
  const { runDir } = await makeRun();
  try {
    await withFakeFFmpeg(async (manager) => {
      const result = runCli(["render", runDir, "--json", "--keep-frames"], {
        PATH: manager.getPATHEnv(),
      });
      assert.equal(result.status, 0, result.stderr);

      const summary = JSON.parse(
        await fs.readFile(path.join(runDir, "run-summary.json"), "utf8"),
      );
      assert.equal(summary.cleanup.success, true);
      assert.equal(summary.cleanup.removed, 0);
      assert.equal(summary.cleanup.retained, 3);
      assert.equal(summary.cleanup.reason, "keep-frames");

      const frames = await fs.readdir(path.join(runDir, "frames"));
      assert.equal(frames.length, 3);
    }, "success");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("render with --keep-all records retained cleanup summary", async () => {
  const { runDir } = await makeRun();
  try {
    await withFakeFFmpeg(async (manager) => {
      const result = runCli(["render", runDir, "--json", "--keep-all"], {
        PATH: manager.getPATHEnv(),
      });
      assert.equal(result.status, 0, result.stderr);

      const summary = JSON.parse(
        await fs.readFile(path.join(runDir, "run-summary.json"), "utf8"),
      );
      assert.equal(summary.cleanup.success, true);
      assert.equal(summary.cleanup.removed, 0);
      assert.equal(summary.cleanup.retained, 3);
      assert.equal(summary.cleanup.reason, "keep-all");

      const frames = await fs.readdir(path.join(runDir, "frames"));
      assert.equal(frames.length, 3);
    }, "success");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});
test("render records validation metadata before default cleanup", async () => {
  const { runDir } = await makeRun();
  try {
    await withFakeFFmpeg(async (manager) => {
      const result = runCli(["render", runDir, "--json"], {
        PATH: manager.getPATHEnv(),
      });
      assert.equal(result.status, 0, result.stderr);

      const payload = JSON.parse(result.stdout);
      const expectedOutputPath = path.join(runDir, "output.mp4");
      assert.equal(payload.output, expectedOutputPath);

      const status = JSON.parse(
        await fs.readFile(path.join(runDir, "status.json"), "utf8"),
      );
      assert.equal(status.state, "rendered");

      const summary = JSON.parse(
        await fs.readFile(path.join(runDir, "run-summary.json"), "utf8"),
      );
      assert.equal(summary.render.outputPath, expectedOutputPath);
      assert.ok(summary.render.bytes > 0);
      assert.ok(summary.render.duration > 0);
      assert.ok(summary.render.dimensions.width > 0);
      assert.ok(summary.render.dimensions.height > 0);
      assert.equal(summary.render.sourceFrameCount, 3);
      assert.equal(summary.cleanup.success, true);
      assert.equal(summary.cleanup.removed, 3);

      const framesDir = path.join(runDir, "frames");
      const remainingFrames = await fs.readdir(framesDir).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      assert.deepEqual(
        remainingFrames.filter((name) => name.endsWith(".png")),
        [],
      );
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

      const status = JSON.parse(
        await fs.readFile(path.join(runDir, "status.json"), "utf8"),
      );
      assert.equal(status.state, "render_failed");
      assert.ok(status.error);

      const renderLog = await fs.readFile(path.join(runDir, "render.log"), "utf8");
      assert.match(renderLog, /^\[[^\]]+\] render attempt started/m);
      assert.match(renderLog, /^\[[^\]]+\] fake ffmpeg stdout: render failed/m);
      assert.match(renderLog, /^\[[^\]]+\] fake ffmpeg stderr: encoder failed/m);
      assert.match(renderLog, /^\[[^\]]+\] render attempt failed errorCode=FFMPEG_FAILED/m);
    }, "fail");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("render preserves frames when MP4 validation fails", async () => {
  const cases = [
    ["ffmpeg exits non-zero", "fail", /ffmpeg failed/],
    ["ffmpeg creates no output", "no-output", /Output file does not exist/],
    ["ffmpeg creates empty output", "empty-output", /Output file is empty/],
    ["ffprobe reports zero duration", "zero-duration", /duration is zero/],
    [
      "ffprobe reports no video stream",
      "no-video-stream",
      /readable video stream/,
    ],
    [
      "ffprobe cannot read output",
      "invalid-output",
      /ffprobe failed|valid MP4/,
    ],
  ];

  for (const [name, fakeMode, errorPattern] of cases) {
    const { runDir } = await makeRun();
    try {
      await withFakeFFmpeg(async (manager) => {
        const result = runCli(["render", runDir, "--json"], {
          PATH: manager.getPATHEnv(),
        });
        assert.notEqual(result.status, 0, name);
        assert.match(result.stderr, errorPattern, name);

        const status = JSON.parse(
          await fs.readFile(path.join(runDir, "status.json"), "utf8"),
        );
        assert.equal(status.state, "render_failed", name);

        const summary = JSON.parse(
          await fs.readFile(path.join(runDir, "run-summary.json"), "utf8"),
        );
        assert.equal(summary.cleanup.removed, 0, name);

        const frameNames = (
          await fs.readdir(path.join(runDir, "frames"))
        ).filter((frameName) => frameName.endsWith(".png"));
        assert.equal(frameNames.length, 3, name);
      }, fakeMode);
    } finally {
      await fs.rm(runDir, { recursive: true, force: true });
    }
  }
});

test("render marks render_failed when output is not a valid MP4", async () => {
  const { runDir } = await makeRun();
  try {
    await withFakeFFmpeg(async (manager) => {
      const result = runCli(["render", runDir, "--json"], {
        PATH: manager.getPATHEnv(),
      });
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        /Rendered output is not a valid MP4|valid MP4/,
      );

      const status = JSON.parse(
        await fs.readFile(path.join(runDir, "status.json"), "utf8"),
      );
      assert.equal(status.state, "render_failed");
      assert.ok(status.error);
      assert.equal((await fs.readdir(path.join(runDir, "frames"))).length, 3);
    }, "invalid-output");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("render succeeds when status.json is initially missing", async () => {
  const { runDir } = await makeRun();
  try {
    await fs.rm(path.join(runDir, "status.json"));
    await withFakeFFmpeg(async (manager) => {
      const result = runCli(["render", runDir, "--json", "--force"], {
        PATH: manager.getPATHEnv(),
      });
      assert.equal(result.status, 0, result.stderr);

      const status = JSON.parse(
        await fs.readFile(path.join(runDir, "status.json"), "utf8"),
      );
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
      const result = runCli(["render", runDir, "--json"], {
        PATH: manager.getPATHEnv(),
      });
      assert.equal(result.status, 0, result.stderr);

      const statusJson = await fs.readFile(
        path.join(runDir, "status.json"),
        "utf8",
      );
      const status = JSON.parse(statusJson);
      assert.equal(status.state, "rendered");

      const entries = await fs.readdir(runDir);
      assert.deepEqual(
        entries.filter((entry) => entry.startsWith("status.json.tmp-")),
        [],
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
      FRAME_PNG_1x1,
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
      totalExpected: 5,
    },
    latestFrame: null,
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
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(
    path.join(runDir, "config.json"),
    JSON.stringify(config, null, 2),
  );
  await fs.writeFile(
    path.join(runDir, "status.json"),
    JSON.stringify(status, null, 2),
  );

  try {
    await withFakeFFmpeg(async (manager) => {
      const result = runCli(["render", runDir, "--json"], {
        PATH: manager.getPATHEnv(),
      });
      assert.equal(result.status, 0, result.stderr);
      const summary = JSON.parse(result.stdout);
      assert.equal(summary.sourceFrameCount, 3);
      const ffmpegArgs = JSON.parse(
        await fs.readFile(
          path.join(manager.outputDir, "ffmpeg-args.json"),
          "utf8",
        ),
      );
      const inputPattern = ffmpegArgs[ffmpegArgs.indexOf("-i") + 1];
      assert.equal(path.basename(inputPattern), "frame-%04d.png");
      assert.equal(
        path.basename(path.dirname(inputPattern)),
        ".render-staging",
      );

      const finalStatus = JSON.parse(
        await fs.readFile(path.join(runDir, "status.json"), "utf8"),
      );
      assert.equal(finalStatus.state, "rendered");

      const stagingDir = path.join(framesDir, ".render-staging");
      const stagingExists = await fs.stat(stagingDir).then(
        () => true,
        () => false,
      );
      assert.equal(
        stagingExists,
        false,
        "staging directory should be cleaned up",
      );
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
      FRAME_PNG_1x1,
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
    latestFrame: null,
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
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(
    path.join(runDir, "config.json"),
    JSON.stringify(config, null, 2),
  );
  await fs.writeFile(
    path.join(runDir, "status.json"),
    JSON.stringify(status, null, 2),
  );

  try {
    await withFakeFFmpeg(async (manager) => {
      const result = runCli(["render", runDir, "--json"], {
        PATH: manager.getPATHEnv(),
      });
      assert.equal(result.status, 0, result.stderr);
      const summary = JSON.parse(result.stdout);
      assert.equal(summary.sourceFrameCount, 3);

      const finalStatus = JSON.parse(
        await fs.readFile(path.join(runDir, "status.json"), "utf8"),
      );
      assert.equal(finalStatus.state, "rendered");

      const stagingExists = await fs.stat(stagingDir).then(
        () => true,
        () => false,
      );
      assert.equal(
        stagingExists,
        false,
        "staging directory should be cleaned up",
      );
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
      FRAME_PNG_1x1,
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
      totalExpected: 3,
    },
    latestFrame: null,
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
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(
    path.join(runDir, "config.json"),
    JSON.stringify(config, null, 2),
  );
  await fs.writeFile(
    path.join(runDir, "status.json"),
    JSON.stringify(status, null, 2),
  );

  try {
    await withFakeFFmpeg(async (manager) => {
      const result = runCli(["render", runDir, "--json"], {
        PATH: manager.getPATHEnv(),
      });
      assert.equal(result.status, 0, result.stderr);
      const summary = JSON.parse(result.stdout);
      assert.equal(summary.sourceFrameCount, 3);

      const finalStatus = JSON.parse(
        await fs.readFile(path.join(runDir, "status.json"), "utf8"),
      );
      assert.equal(finalStatus.state, "rendered");
    }, "success");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("render refuses active capture runs without --force", async () => {
  for (const activeState of ["starting", "running", "rendering"]) {
    const { runDir } = await makeRun({ state: activeState });
    try {
      const result = runCli(["render", runDir]);
      assert.notEqual(
        result.status,
        0,
        `Expected non-zero exit for state=${activeState}`,
      );
      assert.match(result.stderr, /Cannot render while capture is active/);
      const status = JSON.parse(
        await fs.readFile(path.join(runDir, "status.json"), "utf8"),
      );
      assert.equal(
        status.state,
        activeState,
        `status.state should remain ${activeState}`,
      );
    } finally {
      await fs.rm(runDir, { recursive: true, force: true });
    }
  }
});

test("render --force refuses when no frames exist during active capture", async () => {
  const { runDir } = await makeRun({ frameCount: 0, state: "running" });
  try {
    await withFakeFFmpeg(async (manager) => {
      const result = runCli(["render", runDir, "--force"], {
        PATH: manager.getPATHEnv(),
      });
      assert.notEqual(result.status, 0, result.stderr);
      assert.match(result.stderr, /no frames/i);
      const status = JSON.parse(
        await fs.readFile(path.join(runDir, "status.json"), "utf8"),
      );
      assert.equal(status.state, "running");
    }, "success");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("render --force during active capture preserves frames after success", async () => {
  const { runDir } = await makeRun({ frameCount: 3, state: "running" });
  try {
    await withFakeFFmpeg(async (manager) => {
      const result = runCli(["render", runDir, "--force", "--json"], {
        PATH: manager.getPATHEnv(),
      });
      assert.equal(result.status, 0, result.stderr);
      const summary = JSON.parse(result.stdout);
      assert.ok(summary.output.endsWith("output.mp4"));

      const status = JSON.parse(
        await fs.readFile(path.join(runDir, "status.json"), "utf8"),
      );
      assert.equal(status.state, "rendered");

      const frames = await fs.readdir(path.join(runDir, "frames"));
      const pngs = frames.filter((f) => f.endsWith(".png"));
      assert.equal(
        pngs.length,
        3,
        "frames must be preserved after forced active-state render",
      );
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
    assert.match(
      result.stderr,
      /Refusing to delete frames: Output file does not exist \(at .*output\.mp4\)\. Pass --force to override\./,
    );
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("cleanup honors configured custom output path before output.mp4", async () => {
  const { runDir } = await makeRun();
  try {
    const configuredOutput = path.join(runDir, "custom", "output.mp4");
    await withFakeFFmpeg(async (manager) => {
      await fs.rm(path.join(runDir, "output.mp4"), { force: true });
      await fs.mkdir(path.join(runDir, "custom"), { recursive: true });
      await fs.writeFile(configuredOutput, "rendered");
      const config = JSON.parse(
        await fs.readFile(path.join(runDir, "config.json"), "utf8"),
      );
      config.output = { path: "custom/output.mp4" };
      await fs.writeFile(
        path.join(runDir, "config.json"),
        JSON.stringify(config, null, 2),
      );

      const result = runCli(["cleanup", runDir], {
        PATH: manager.getPATHEnv(),
      });
      assert.equal(result.status, 0, result.stderr);
      const summary = JSON.parse(
        await fs.readFile(path.join(runDir, "run-summary.json"), "utf8"),
      );
      assert.equal(summary.cleanup.removed, 3);
      assert.equal(summary.cleanup.retained, 0);
    });
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("cleanup --keep-samples reports one retained frame for a one-frame run", async () => {
  const { runDir } = await makeRun({ frameCount: 1 });
  try {
    await fs.writeFile(path.join(runDir, "output.mp4"), "rendered");
    await withFakeFFmpeg(async (manager) => {
      const originalPath = process.env.PATH;
      process.env.PATH = manager.getPATHEnv();
      try {
        const result = await commandCleanup({ runDir, options: { "keep-samples": true } });
        assert.equal(result.removed, 1);
        assert.equal(result.retained, 1);
        const framesExist = await fs.stat(path.join(runDir, "frames")).then(() => true, () => false);
        assert.equal(framesExist, false);
        const samples = await fs.readdir(path.join(runDir, "samples"));
        assert.deepEqual(samples.sort(), ["sample-000001.png"]);

        const summary = JSON.parse(
          await fs.readFile(path.join(runDir, "run-summary.json"), "utf8"),
        );
        assert.equal(summary.cleanup.success, true);
        assert.equal(summary.cleanup.removed, 1);
        assert.equal(summary.cleanup.retained, 1);
      } finally {
        process.env.PATH = originalPath;
      }
    });
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
  const workdir = await fs.mkdtemp(
    path.join(os.tmpdir(), "tlc-start-positional-"),
  );
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
    "24",
  ]);

  assert.equal(parsed.options.duration.ms, 7_200_000);
  assert.equal(parsed.options["video-length"].ms, 60_000);
  assert.equal(parsed.options.fps, 24);
});

test("start parser rejects video length and interval together", () => {
  assert.throws(
    () =>
      parseArgs([
        "start",
        "http://example.test",
        "--duration",
        "2h",
        "--video-length",
        "1m",
        "--interval",
        "5s",
      ]),
    (error) =>
      error instanceof ParseError &&
      /--video-length.*--interval|--interval.*--video-length/.test(
        error.message,
      ),
  );
});

test("start parser still requires duration with video length", () => {
  const result = runCli([
    "start",
    "http://example.test",
    "--video-length",
    "1m",
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing --duration/);
});

test("start timing derives interval from target video length", () => {
  const timing = resolveStartTiming({
    duration: { ms: 7_200_000 },
    "video-length": { ms: 60_000 },
    fps: 24,
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
    fps: 12,
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
        "--json",
      ],
      { TIMELAPSE_SIMULATE_FRAMES: "1" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stderr,
      /warning: computed interval 250ms is below 1000ms/,
    );
    assert.equal(JSON.parse(result.stdout).status.intervalMs, 250);
    await waitForTerminalStatus(runDir);
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

test("status --json preserves latestFrame when subsequent frames failed", async () => {
  const { runDir, captured } = await makeRun({
    frameCount: 2,
    state: "failed",
  });
  try {
    const lastCaptured = captured.at(-1);
    const status = {
      state: "failed",
      pid: 1234,
      startedAt: captured[0].scheduledAt,
      updatedAt: new Date().toISOString(),
      frames: {
        captured: 2,
        failed: 1,
        totalExpected: 3,
      },
      latestFrame: lastCaptured.path,
      latestFrameTimestamp: lastCaptured.capturedAt,
    };
    await fs.writeFile(
      path.join(runDir, "status.json"),
      JSON.stringify(status, null, 2),
    );

    const result = runCli(["status", runDir, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status.state, "failed");
    assert.equal(payload.status.frames.captured, 2);
    assert.equal(payload.status.frames.failed, 1);
    assert.equal(payload.status.latestFrame, lastCaptured.path);
    assert.equal(payload.status.latestFrameTimestamp, lastCaptured.capturedAt);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("peek --latest returns poster.png after default cleanup removes raw frames", async () => {
  const { runDir } = await makeRun();
  try {
    await withFakeFFmpeg(async (manager) => {
      const renderResult = runCli(["render", runDir, "--json"], {
        PATH: manager.getPATHEnv(),
      });
      assert.equal(renderResult.status, 0, renderResult.stderr);

      // Write poster.png directly since fake-ffmpeg doesn't copy the poster in tests
      const posterPath = path.join(runDir, "poster.png");
      if (
        !(await fs.stat(posterPath).then(
          () => true,
          () => false,
        ))
      ) {
        await fs.writeFile(
          posterPath,
          Buffer.from(
            "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000b49444154789c636060000000020001d75edeb0000000049454e44ae426082",
            "hex",
          ),
        );
      }

      const cleanupResult = runCli(["cleanup", runDir], {
        PATH: manager.getPATHEnv(),
      });
      assert.equal(cleanupResult.status, 0, cleanupResult.stderr);

      assert.equal(
        await fs.stat(path.join(runDir, "frames")).then(
          () => true,
          () => false,
        ),
        false,
        "frames/ directory should not exist after cleanup",
      );
      assert.ok(
        await fs.stat(posterPath).then(
          () => true,
          () => false,
        ),
        "poster.png should exist",
      );

      const peekResult = runCli(["peek", runDir, "--latest", "--json"]);
      assert.equal(peekResult.status, 0, peekResult.stderr);
      const payload = JSON.parse(peekResult.stdout);
      assert.equal(payload.exists, true);
      assert.equal(payload.path, posterPath);
    }, "success");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("status --json includes diskUsage with runDirBytes and framesBytes", async () => {
  const { runDir } = await makeRun({ frameCount: 2, state: "completed" });
  try {
    const result = runCli(["status", runDir, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(typeof payload.status.diskUsage, "object");
    assert.notEqual(payload.status.diskUsage, null);
    assert.equal(typeof payload.status.diskUsage.runDirBytes, "number");
    assert.equal(typeof payload.status.diskUsage.framesBytes, "number");
    assert.ok(payload.status.diskUsage.runDirBytes > 0);
    assert.ok(payload.status.diskUsage.framesBytes >= 0);
    assert.ok(
      payload.status.diskUsage.runDirBytes >=
        payload.status.diskUsage.framesBytes,
      `runDirBytes (${payload.status.diskUsage.runDirBytes}) should be >= framesBytes (${payload.status.diskUsage.framesBytes})`,
    );
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("peek --latest returns remaining frame after cleanup --keep-latest", async () => {
  const { runDir } = await makeRun();
  // render auto-calls cleanupFrames internally; use --keep-frames to preserve frames for --keep-latest
  try {
    await withFakeFFmpeg(async (manager) => {
      const renderResult = runCli(
        ["render", runDir, "--json", "--keep-frames"],
        { PATH: manager.getPATHEnv() },
      );
      assert.equal(renderResult.status, 0, renderResult.stderr);

      // cleanup --keep-latest needs fake ffprobe to validate the rendered output.mp4
      const cleanupResult = runCli(["cleanup", runDir, "--keep-latest"], {
        PATH: manager.getPATHEnv(),
      });
      assert.equal(cleanupResult.status, 0, cleanupResult.stderr);

      // With --keep-latest, the last frame remains in frames/ (no latest-retained.png)
      const posterPath = path.join(runDir, "poster.png");
      await fs.rm(posterPath, { force: true });

      const peekResult = runCli(["peek", runDir, "--latest", "--json"]);
      assert.equal(peekResult.status, 0, peekResult.stderr);
      const payload = JSON.parse(peekResult.stdout);
      assert.equal(payload.exists, true);
      assert.equal(payload.frame.index, 3);
    }, "success");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("start with simulated navigation failure reports 'navigation failed:' error", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "tlc-nav-fail-"));
  try {
    const result = runCli(
      [
        "start",
        "http://example.test/",
        "--duration",
        "1s",
        "--interval",
        "1s",
        "--out",
        runDir,
      ],
      { TIMELAPSE_SIMULATE_NAVIGATION_FAILURE: "1" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /navigation failed:/);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("peek --latest exits non-zero with a clear error when no frames or fallback artifacts exist", async () => {
  const { runDir } = await makeRun();
  try {
    await fs.rm(path.join(runDir, "frames"), { recursive: true, force: true });

    const peekResult = runCli(["peek", runDir, "--latest"]);
    assert.notEqual(
      peekResult.status,
      0,
      "peek should exit non-zero when no frames or artifacts",
    );
    assert.match(peekResult.stderr, /Raw frames were cleaned up/);
    assert.match(peekResult.stderr, /poster\.png/);
    assert.match(peekResult.stderr, /latest-retained\.png/);
    assert.ok(
      !peekResult.stdout.includes("frames/"),
      "stdout should not mention a frames/ path",
    );
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("status with missing run directory reports 'run directory not found'", async () => {
  const missing = path.join(
    os.tmpdir(),
    `tlc-missing-${process.pid}-${Date.now()}`,
  );
  const result = runCli(["status", missing]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /run directory not found/);
});

test("commandStart saves keepSamples (explicit) to config.json", async () => {
  const runDir = path.join(os.tmpdir(), "tlc-test-start-samples-" + Date.now());
  try {
    process.env.TIMELAPSE_SIMULATE_FRAMES = "3";
    const { commandStart } = await import("../src/timelapse-capture.mjs");
    await commandStart({
      target: "http://example.com",
      options: {
        out: runDir,
        duration: { ms: 1000 },
        "keep-samples": "7",
        cleanup: "never"
      }
    });

    const config = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(runDir, "config.json"), "utf8"));
    assert.equal(config.keepSamples, 7);
  } finally {
    delete process.env.TIMELAPSE_SIMULATE_FRAMES;
    await (await import("node:fs/promises")).rm(runDir, { recursive: true, force: true });
  }
});

test("commandStart saves keepSamples (default) to config.json", async () => {
  const runDir = path.join(os.tmpdir(), "tlc-test-start-samples-default-" + Date.now());
  try {
    process.env.TIMELAPSE_SIMULATE_FRAMES = "3";
    const { commandStart } = await import("../src/timelapse-capture.mjs");
    await commandStart({
      target: "http://example.com",
      options: {
        out: runDir,
        duration: { ms: 1000 },
        "keep-samples": true,
        cleanup: "never"
      }
    });

    const config = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(runDir, "config.json"), "utf8"));
    assert.equal(config.keepSamples, 5);
  } finally {
    delete process.env.TIMELAPSE_SIMULATE_FRAMES;
    await (await import("node:fs/promises")).rm(runDir, { recursive: true, force: true });
  }
});
