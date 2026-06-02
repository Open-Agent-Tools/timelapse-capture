import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { withFakeFFmpeg } from "./helpers/fake-ffmpeg.mjs";
import { CLI, runCli } from "./helpers/cli.mjs";
import { waitForTerminalStatus } from "./helpers/status-waiters.mjs";
import {
  commandStart,
  commandCleanup,
  commandRender,
  __test__,
  parseArgs,
  ParseError,
  resolveStartTiming,
} from "../src/timelapse-capture.mjs";

const FRAME_PNG_1x1 = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000b49444154789c636060000000020001d75edeb0000000049454e44ae426082",
  "hex",
);

async function makeRun({
  frameCount = 3,
  state = "completed",
  format = "png",
} = {}) {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "tlc-canonical-"));
  const framesDir = path.join(runDir, "frames");
  await fs.mkdir(framesDir);

  const ext = format === "jpeg" ? "jpeg" : "png";
  const frameBytes =
    format === "jpeg" ? __test__.SIMULATION_FRAME_JPEG : FRAME_PNG_1x1;
  const captured = [];
  for (let index = 1; index <= frameCount; index += 1) {
    const relative = path.join(
      "frames",
      `frame-${String(index).padStart(4, "0")}.${ext}`,
    );
    await fs.writeFile(path.join(runDir, relative), frameBytes);
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
    format: ext,
    quality: ext === "jpeg" ? 90 : null,
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

test("start --block-websockets persists in config.json; default is false", async () => {
  const enabledRunDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "tlc-block-ws-on-"),
  );
  const defaultRunDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "tlc-block-ws-off-"),
  );
  try {
    const enabled = runCli(
      [
        "start",
        "http://example.test/",
        "--duration",
        "2s",
        "--interval",
        "1s",
        "--out",
        enabledRunDir,
        "--block-websockets",
        "--json",
      ],
      { TIMELAPSE_SIMULATE_FRAMES: "2" },
    );
    assert.equal(enabled.status, 0, enabled.stderr);
    const enabledConfig = JSON.parse(
      await fs.readFile(path.join(enabledRunDir, "config.json"), "utf8"),
    );
    assert.equal(enabledConfig.blockWebsockets, true);
    await waitForTerminalStatus(enabledRunDir);

    const defaultRun = runCli(
      [
        "start",
        "http://example.test/",
        "--duration",
        "2s",
        "--interval",
        "1s",
        "--out",
        defaultRunDir,
        "--json",
      ],
      { TIMELAPSE_SIMULATE_FRAMES: "2" },
    );
    assert.equal(defaultRun.status, 0, defaultRun.stderr);
    const defaultConfig = JSON.parse(
      await fs.readFile(path.join(defaultRunDir, "config.json"), "utf8"),
    );
    assert.equal(defaultConfig.blockWebsockets, false);
    await waitForTerminalStatus(defaultRunDir);
  } finally {
    await fs.rm(enabledRunDir, { recursive: true, force: true });
    await fs.rm(defaultRunDir, { recursive: true, force: true });
  }
});

test("start command accepts --url target", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "tlc-start-url-"));
  try {
    const result = runCli(
      [
        "start",
        "--url",
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

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status.target, "http://example.test/");

    const config = JSON.parse(
      await fs.readFile(path.join(runDir, "config.json"), "utf8"),
    );
    assert.equal(config.target, "http://example.test/");
    assert.equal(Object.hasOwn(config, "url"), false);
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
        /^cleanup: removed \d+, retained \d+ \(freed .+\)$/m,
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
    const last = captured.at(-1);
    assert.equal(payload.exists, true);
    assert.equal(payload.frame.index, last.index);
    assert.equal(payload.framePath, path.join(runDir, last.path));
    assert.equal(payload.frame.capturedAt, last.capturedAt);
    assert.equal(payload.frame.scheduledAt, last.scheduledAt);
    assert.equal(payload.frame.url, last.url);
    assert.equal(payload.frame.title, last.title);
    assert.deepEqual(payload.frame.viewport, last.viewport);
    assert.equal(payload.frame.status, last.status);
    assert.equal(payload.frame.error, last.error);
    assert.equal(payload.selection.source, "frames");
    assert.equal(payload.selection.metadataAvailable, true);
    assert.equal(payload.selection.index, last.index);
    assert.equal(payload.selection.path, last.path);
    assert.equal(payload.selection.capturedAt, last.capturedAt);
    assert.equal(payload.selection.scheduledAt, last.scheduledAt);
    assert.equal(payload.selection.url, last.url);
    assert.equal(payload.selection.title, last.title);
    assert.deepEqual(payload.selection.viewport, last.viewport);
    assert.equal(payload.selection.status, last.status);
    assert.equal(payload.selection.error, last.error);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("peek --index --json returns selected frame metadata", async () => {
  const { runDir, captured } = await makeRun({ frameCount: 4 });
  try {
    const selected = captured[1];
    const result = runCli(["peek", runDir, "--index", "1", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.exists, true);
    assert.equal(payload.frame.index, selected.index);
    assert.equal(payload.frame.path, selected.path);
    assert.equal(payload.frame.capturedAt, selected.capturedAt);
    assert.equal(payload.frame.scheduledAt, selected.scheduledAt);
    assert.equal(payload.frame.url, selected.url);
    assert.equal(payload.frame.title, selected.title);
    assert.deepEqual(payload.frame.viewport, selected.viewport);
    assert.equal(payload.frame.status, selected.status);
    assert.equal(payload.frame.error, selected.error);
    assert.equal(payload.selection.source, "frames");
    assert.equal(payload.selection.metadataAvailable, true);
    assert.equal(payload.selection.index, selected.index);
    assert.equal(payload.selection.path, selected.path);
    assert.equal(payload.selection.capturedAt, selected.capturedAt);
    assert.equal(payload.selection.scheduledAt, selected.scheduledAt);
    assert.equal(payload.selection.url, selected.url);
    assert.equal(payload.selection.title, selected.title);
    assert.deepEqual(payload.selection.viewport, selected.viewport);
    assert.equal(payload.selection.status, selected.status);
    assert.equal(payload.selection.error, selected.error);
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
    const selected = captured[1];
    assert.equal(payload.exists, true);
    assert.equal(payload.frame.index, selected.index);
    assert.equal(payload.framePath, path.join(runDir, selected.path));
    assert.equal(payload.frame.capturedAt, selected.capturedAt);
    assert.equal(payload.frame.scheduledAt, selected.scheduledAt);
    assert.equal(payload.frame.url, selected.url);
    assert.equal(payload.frame.title, selected.title);
    assert.deepEqual(payload.frame.viewport, selected.viewport);
    assert.equal(payload.frame.status, selected.status);
    assert.equal(payload.frame.error, selected.error);
    assert.equal(payload.selection.source, "frames");
    assert.equal(payload.selection.metadataAvailable, true);
    assert.equal(payload.selection.index, selected.index);
    assert.equal(payload.selection.path, selected.path);
    assert.equal(payload.selection.capturedAt, selected.capturedAt);
    assert.equal(payload.selection.scheduledAt, selected.scheduledAt);
    assert.equal(payload.selection.url, selected.url);
    assert.equal(payload.selection.title, selected.title);
    assert.deepEqual(payload.selection.viewport, selected.viewport);
    assert.equal(payload.selection.status, selected.status);
    assert.equal(payload.selection.error, selected.error);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("peek --latest --json marks orphan frames with no manifest record", async () => {
  const { runDir } = await makeRun();
  try {
    await fs.rm(path.join(runDir, "manifest.jsonl"));
    const result = runCli(["peek", runDir, "--latest", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.exists, true);
    assert.equal(payload.selection.source, "frames");
    assert.equal(payload.selection.metadataAvailable, false);
    assert.equal(payload.selection.reason, "no-manifest-record");
    assert.equal(payload.selection.index, 3);
    assert.equal(payload.selection.path, path.join("frames", "frame-0003.png"));
    assert.equal(payload.selection.capturedAt, null);
    assert.equal(payload.selection.scheduledAt, null);
    assert.equal(payload.selection.url, null);
    assert.equal(payload.selection.title, null);
    assert.equal(payload.selection.viewport, null);
    assert.equal(payload.selection.status, null);
    assert.equal(payload.selection.error, null);
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
    assert.ok(
      path.isAbsolute(payload.framePath),
      "peek framePath remains absolute even with relative manifest paths",
    );
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
        path: "frames/frame-0001.png",
        status: "failed",
        error: "timeout",
      },
      {
        index: 2,
        scheduledAt: new Date().toISOString(),
        capturedAt: null,
        path: "frames/frame-0002.png",
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
        `frame-${String(index).padStart(4, "0")}.png`,
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
    await fs.writeFile(
      path.join(runDir, "render.log"),
      "[prior] previous render\n",
    );

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

      const renderLog = await fs.readFile(
        path.join(runDir, "render.log"),
        "utf8",
      );
      assert.match(renderLog, /^\[prior\] previous render\n\[/);
      assert.match(renderLog, /^\[[^\]]+\] render attempt started/m);
      assert.match(
        renderLog,
        /^\[[^\]]+\] fake ffmpeg stdout: render started/m,
      );
      assert.match(
        renderLog,
        /^\[[^\]]+\] fake ffmpeg stderr: render details/m,
      );
      assert.match(renderLog, /^\[[^\]]+\] render attempt succeeded/m);

      const framesDirExists = await fs.stat(path.join(runDir, "frames")).then(
        () => true,
        (error) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      );
      assert.equal(framesDirExists, false);
    }, "success");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("frame filename width and render input pattern stay in sync", async () => {
  const { runDir } = await makeRun({ frameCount: 3 });
  try {
    assert.equal(__test__.frameName(1), "frame-0001.png");
    assert.equal(__test__.frameName(42), "frame-0042.png");
    assert.match(__test__.frameName(1), /^frame-\d{4}\.png$/);
    assert.equal(__test__.frameName(1, "jpeg"), "frame-0001.jpeg");
    assert.equal(__test__.frameName(42, "png"), "frame-0042.png");

    await withFakeFFmpeg(async (manager) => {
      const result = runCli(["render", runDir, "--json"], {
        PATH: manager.getPATHEnv(),
      });
      assert.equal(result.status, 0, result.stderr);

      const summary = JSON.parse(
        await fs.readFile(path.join(runDir, "run-summary.json"), "utf8"),
      );
      const ffmpegArgs = summary.render.ffmpegCommand;
      const inputIndex = ffmpegArgs.indexOf("-i");
      assert.notEqual(inputIndex, -1);
      assert.equal(path.basename(ffmpegArgs[inputIndex + 1]), "frame-%04d.png");
    }, "success");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("render of a jpeg run uses a jpeg input pattern and jpeg poster", async () => {
  const { runDir } = await makeRun({ frameCount: 3, format: "jpeg" });
  try {
    await withFakeFFmpeg(async (manager) => {
      const result = runCli(["render", runDir, "--json", "--keep-frames"], {
        PATH: manager.getPATHEnv(),
      });
      assert.equal(result.status, 0, result.stderr);

      const summary = JSON.parse(
        await fs.readFile(path.join(runDir, "run-summary.json"), "utf8"),
      );
      const ffmpegArgs = summary.render.ffmpegCommand;
      const inputIndex = ffmpegArgs.indexOf("-i");
      assert.notEqual(inputIndex, -1);
      assert.equal(
        path.basename(ffmpegArgs[inputIndex + 1]),
        "frame-%04d.jpeg",
      );

      // Poster carries the jpeg extension and the recorded summary agrees.
      assert.equal(summary.poster, "poster.jpeg");
      const posterStat = await fs.stat(path.join(runDir, "poster.jpeg"));
      assert.ok(posterStat.size > 0, "poster.jpeg exists and is non-empty");

      // Peek still resolves a jpeg frame for a kept-frames jpeg run.
      const peekResult = runCli(["peek", runDir, "--latest", "--json"]);
      assert.equal(peekResult.status, 0, peekResult.stderr);
      const payload = JSON.parse(peekResult.stdout);
      assert.match(payload.path, /frame-0003\.jpeg$/);
    }, "success");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("start rejects --quality combined with --format png", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "tlc-quality-png-"));
  try {
    const result = runCli(
      [
        "start",
        "http://example.test/",
        "--duration",
        "1s",
        "--interval",
        "1s",
        "--format",
        "png",
        "--quality",
        "80",
        "--out",
        runDir,
        "--json",
      ],
      { TIMELAPSE_SIMULATE_FRAMES: "1" },
    );
    assert.notEqual(result.status, 0, "start should reject quality+png");
    assert.match(result.stderr, /quality/i);
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

test("render --output writes to the requested run-relative path", async () => {
  const { runDir, config } = await makeRun();
  try {
    const configuredOutput = path.join("configured", "output.mp4");
    const cliOutput = path.join("exports", "custom.mp4");
    const expectedOutputPath = path.join(runDir, cliOutput);

    await fs.writeFile(
      path.join(runDir, "config.json"),
      JSON.stringify(
        { ...config, output: { path: configuredOutput } },
        null,
        2,
      ),
    );

    await withFakeFFmpeg(async (manager) => {
      const result = runCli(
        ["render", runDir, "--output", cliOutput, "--json"],
        {
          PATH: manager.getPATHEnv(),
        },
      );
      assert.equal(result.status, 0, result.stderr);

      const payload = JSON.parse(result.stdout);
      assert.equal(payload.output, expectedOutputPath);
      assert.equal(payload.path, expectedOutputPath);
      assert.equal(await fs.stat(expectedOutputPath).then(() => true), true);

      const defaultOutputExists = await fs
        .stat(path.join(runDir, "output.mp4"))
        .then(
          () => true,
          (error) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        );
      assert.equal(defaultOutputExists, false);

      const configuredOutputExists = await fs
        .stat(path.join(runDir, configuredOutput))
        .then(
          () => true,
          (error) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        );
      assert.equal(configuredOutputExists, false);

      const summary = JSON.parse(
        await fs.readFile(path.join(runDir, "run-summary.json"), "utf8"),
      );
      assert.equal(summary.render.outputPath, expectedOutputPath);
    }, "success-require-contiguous-input");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("render uses fps persisted by start command", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "tlc-start-fps-"));
  try {
    process.env.TIMELAPSE_SIMULATE_FRAMES = "3";
    await commandStart({
      target: "http://example.com",
      options: {
        out: runDir,
        duration: { ms: 1000 },
        fps: 18,
        cleanup: "never",
        "no-render": true,
      },
    });
    await waitForTerminalStatus(runDir);

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
      assert.equal(ffmpegArgs[framerateIdx + 1], "18");

      const summary = JSON.parse(
        await fs.readFile(path.join(runDir, "run-summary.json"), "utf8"),
      );
      assert.equal(summary.render.framerate, 18);
    }, "success-require-contiguous-input");
  } finally {
    delete process.env.TIMELAPSE_SIMULATE_FRAMES;
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

test("render with --keep-latest records latest-frame cleanup summary", async () => {
  const { runDir, config } = await makeRun();
  try {
    await fs.writeFile(
      path.join(runDir, "config.json"),
      JSON.stringify(
        { ...config, cleanup: "never", keepLatest: false },
        null,
        2,
      ),
    );

    await withFakeFFmpeg(async (manager) => {
      const result = runCli(["render", runDir, "--json", "--keep-latest"], {
        PATH: manager.getPATHEnv(),
      });
      assert.equal(result.status, 0, result.stderr);

      const summary = JSON.parse(
        await fs.readFile(path.join(runDir, "run-summary.json"), "utf8"),
      );
      assert.equal(summary.cleanup.success, true);
      assert.equal(summary.cleanup.reason, "keep-latest");
      assert.equal(summary.cleanup.source, "cli");
      assert.equal(summary.cleanup.retained, 1);
      assert.equal(summary.cleanup.removed, 2);
      assert.ok(
        summary.cleanup.bytesFreed > 0,
        `expected bytesFreed > 0, got ${summary.cleanup.bytesFreed}`,
      );

      const frames = await fs.readdir(path.join(runDir, "frames"));
      assert.deepEqual(frames.sort(), ["frame-0003.png"]);
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

      const renderLog = await fs.readFile(
        path.join(runDir, "render.log"),
        "utf8",
      );
      assert.match(renderLog, /^\[[^\]]+\] render attempt started/m);
      assert.match(renderLog, /^\[[^\]]+\] fake ffmpeg stdout: render failed/m);
      assert.match(
        renderLog,
        /^\[[^\]]+\] fake ffmpeg stderr: encoder failed/m,
      );
      assert.match(
        renderLog,
        /^\[[^\]]+\] render attempt failed errorCode=FFMPEG_FAILED/m,
      );
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
        const result = await commandCleanup({
          runDir,
          options: { "keep-samples": true },
        });
        assert.equal(result.removed, 1);
        assert.equal(result.retained, 1);
        const framesExist = await fs.stat(path.join(runDir, "frames")).then(
          () => true,
          () => false,
        );
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

test("start command without --duration enters indefinite mode with 12h cap", async () => {
  const parsed = parseArgs(["start", "http://example.com"]);
  assert.equal(parsed.options.indefinite, true);

  const timing = resolveStartTiming(parsed.options);
  assert.equal(timing.indefinite, true);
  assert.equal(timing.durationMs, 12 * 60 * 60 * 1000);
  assert.equal(timing.intervalMs, 2500);
  assert.equal(timing.targetFrames, 17280);
});

test("start command without --duration rejects --interval and --video-length", () => {
  assert.throws(
    () => parseArgs(["start", "http://example.com", "--interval", "5s"]),
    (error) =>
      error instanceof ParseError &&
      error.code === "E_INDEFINITE_FLAG_CONFLICT",
  );
  assert.throws(
    () => parseArgs(["start", "http://example.com", "--video-length", "1m"]),
    (error) =>
      error instanceof ParseError &&
      error.code === "E_INDEFINITE_FLAG_CONFLICT",
  );
});

test("start command uses PRD desktop default viewport when omitted", async () => {
  const runDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "tlc-default-viewport-"),
  );
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
        "--json",
      ],
      { TIMELAPSE_SIMULATE_FRAMES: "1" },
    );
    assert.equal(result.status, 0, result.stderr);

    const startPayload = JSON.parse(result.stdout);
    assert.deepEqual(startPayload.status.viewport, {
      width: 1440,
      height: 900,
    });

    const config = JSON.parse(
      await fs.readFile(path.join(runDir, "config.json"), "utf8"),
    );
    assert.deepEqual(config.viewport, { width: 1440, height: 900 });
    // Default capture format is JPEG q90.
    assert.equal(config.format, "jpeg");
    assert.equal(config.quality, 90);
    assert.equal(
      config.estimatedDiskBytes,
      Math.max(1, config.targetFrames) *
        Math.ceil(1440 * 900 * (0.07 + 0.0125 * (90 / 100))) +
        4096,
    );

    const status = await waitForTerminalStatus(runDir);
    assert.deepEqual(status.viewport, { width: 1440, height: 900 });
    assert.equal(status.format, "jpeg");

    const manifest = (
      await fs.readFile(path.join(runDir, "manifest.jsonl"), "utf8")
    )
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.deepEqual(manifest[0].viewport, { width: 1440, height: 900 });
    assert.match(manifest[0].path, /^frames\/frame-\d{4}\.jpeg$/);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("start command preserves explicit viewport override", async () => {
  const runDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "tlc-override-viewport-"),
  );
  try {
    const result = runCli(
      [
        "start",
        "http://example.test/",
        "--duration",
        "1s",
        "--interval",
        "1s",
        "--viewport",
        "800x600",
        "--out",
        runDir,
        "--json",
      ],
      { TIMELAPSE_SIMULATE_FRAMES: "1" },
    );
    assert.equal(result.status, 0, result.stderr);

    const startPayload = JSON.parse(result.stdout);
    assert.deepEqual(startPayload.status.viewport, { width: 800, height: 600 });

    const config = JSON.parse(
      await fs.readFile(path.join(runDir, "config.json"), "utf8"),
    );
    assert.deepEqual(config.viewport, { width: 800, height: 600 });
    assert.equal(
      config.estimatedDiskBytes,
      Math.max(1, config.targetFrames) *
        Math.ceil(800 * 600 * (0.07 + 0.0125 * (90 / 100))) +
        4096,
    );

    const status = await waitForTerminalStatus(runDir);
    assert.deepEqual(status.viewport, { width: 800, height: 600 });

    const manifest = (
      await fs.readFile(path.join(runDir, "manifest.jsonl"), "utf8")
    )
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.deepEqual(manifest[0].viewport, { width: 800, height: 600 });
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
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

test("start parser rejects video length without duration", () => {
  const result = runCli([
    "start",
    "http://example.test",
    "--video-length",
    "1m",
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /E_INDEFINITE_FLAG_CONFLICT/);
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

test("start timing clamps explicit interval below backend minimum", () => {
  const timing = resolveStartTiming({
    duration: { ms: 10_000 },
    interval: 250,
    fps: 12,
  });

  assert.equal(timing.requestedIntervalMs, 250);
  assert.equal(timing.intervalMs, 1000);
  assert.equal(timing.backendMinIntervalMs, 1000);
  assert.equal(timing.intervalClamped, true);
  assert.equal(timing.targetFrames, 10);
  assert.equal(timing.fps, 12);
  assert.equal(timing.computedFromVideoLength, false);
});

test("start timing rejects unsupported backend values", () => {
  assert.throws(
    () =>
      resolveStartTiming({
        duration: { ms: 10_000 },
        interval: 250,
        backend: "command-frame",
      }),
    (error) =>
      error instanceof ParseError &&
      error.code === "E_UNSUPPORTED_BACKEND" &&
      /command-frame/.test(error.message),
  );
});

test("start command clamps direct interval below backend minimum and persists clamp metadata", async () => {
  const runDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "tlc-direct-interval-"),
  );
  try {
    const result = runCli(
      [
        "start",
        "http://example.test",
        "--duration",
        "10s",
        "--interval",
        "250ms",
        "--out",
        runDir,
        "--json",
      ],
      { TIMELAPSE_SIMULATE_FRAMES: "1" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /warning: requested interval 250ms/);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status.intervalMs, 1000);
    assert.equal(payload.status.requestedIntervalMs, 250);
    assert.equal(payload.status.backendMinIntervalMs, 1000);
    assert.equal(payload.status.intervalClamped, true);
    const config = JSON.parse(
      await fs.readFile(path.join(runDir, "config.json"), "utf8"),
    );
    assert.equal(config.intervalMs, 1000);
    assert.equal(config.requestedIntervalMs, 250);
    assert.equal(config.backendMinIntervalMs, 1000);
    assert.equal(config.intervalClamped, true);
    await waitForTerminalStatus(runDir);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("start command rejects unsupported backend before writing artifacts", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "tlc-bad-backend-"));
  await fs.rm(runDir, { recursive: true, force: true });
  const result = runCli([
    "start",
    "http://example.test",
    "--duration",
    "10s",
    "--backend",
    "command-frame",
    "--out",
    runDir,
    "--json",
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /E_UNSUPPORTED_BACKEND/);
  assert.match(result.stderr, /command-frame/);
  await assert.rejects(fs.stat(runDir), { code: "ENOENT" });
});

test("start command rejects unsupported cleanup policy before writing artifacts", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "tlc-bad-cleanup-"));
  await fs.rm(runDir, { recursive: true, force: true });
  const result = runCli([
    "start",
    "http://example.test",
    "--duration",
    "1s",
    "--cleanup",
    "typo",
    "--out",
    runDir,
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /E_BAD_CLEANUP/);
  assert.match(result.stderr, /Invalid cleanup policy/);
  await assert.rejects(fs.stat(runDir), { code: "ENOENT" });
});

test("start command persists explicit playwright-url backend", async () => {
  const runDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "tlc-explicit-backend-"),
  );
  try {
    const result = runCli(
      [
        "start",
        "http://example.test",
        "--duration",
        "2s",
        "--backend",
        "playwright-url",
        "--out",
        runDir,
        "--json",
      ],
      { TIMELAPSE_SIMULATE_FRAMES: "1" },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status.target, "http://example.test");
    assert.equal(payload.status.backend, "playwright-url");
    const config = JSON.parse(
      await fs.readFile(path.join(runDir, "config.json"), "utf8"),
    );
    assert.equal(config.backend, "playwright-url");
    const terminalStatus = await waitForTerminalStatus(runDir);
    assert.equal(terminalStatus.backend, "playwright-url");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("start command clamps computed video-length interval below backend minimum", async () => {
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
    assert.match(result.stderr, /warning: requested interval 250ms/);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status.intervalMs, 1000);
    assert.equal(payload.status.requestedIntervalMs, 250);
    assert.equal(payload.status.backendMinIntervalMs, 1000);
    assert.equal(payload.status.intervalClamped, true);
    await waitForTerminalStatus(runDir);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("start timing keeps boundary-at-minimum and above-minimum intervals unchanged", () => {
  const atMinimum = resolveStartTiming({
    duration: { ms: 10_000 },
    interval: 1000,
    fps: 12,
  });
  assert.equal(atMinimum.intervalMs, 1000);
  assert.equal(atMinimum.requestedIntervalMs, 1000);
  assert.equal(atMinimum.intervalClamped, false);

  const aboveMinimum = resolveStartTiming({
    duration: { ms: 10_000 },
    interval: 2000,
    fps: 12,
  });
  assert.equal(aboveMinimum.intervalMs, 2000);
  assert.equal(aboveMinimum.requestedIntervalMs, 2000);
  assert.equal(aboveMinimum.intervalClamped, false);
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

test("help output covers all schema flags for each user-facing command", () => {
  const result = runCli(["help"]);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split("\n");

  const USER_COMMANDS = [
    "start",
    "status",
    "peek",
    "render",
    "cleanup",
    "doctor",
  ];
  const { COMMAND_SCHEMAS } = __test__;

  // Locate the line index where each command's section starts
  const commandStarts = {};
  for (const [i, line] of lines.entries()) {
    for (const cmd of USER_COMMANDS) {
      if (line.trimStart().startsWith(`timelapse-capture ${cmd}`)) {
        commandStarts[cmd] = i;
      }
    }
  }

  for (const command of USER_COMMANDS) {
    const startIdx = commandStarts[command];
    assert.notEqual(
      startIdx,
      undefined,
      `Command ${command} not found in help output`,
    );

    // Section ends at the next command's line (or end of output)
    const endIdx = USER_COMMANDS.filter((c) => c !== command)
      .map((c) => commandStarts[c])
      .filter((i) => i !== undefined && i > startIdx)
      .reduce((min, i) => Math.min(min, i), lines.length);

    const section = lines.slice(startIdx, endIdx).join("\n");
    const schema = COMMAND_SCHEMAS[command];
    const allFlags = [...schema.valueFlags, ...schema.boolFlags].filter(
      (f) => f !== "help",
    );

    for (const flag of allFlags) {
      assert.ok(
        section.includes(`--${flag}`),
        `--${flag} missing from help section for "${command}"`,
      );
    }
  }
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
      assert.equal(payload.selection.source, "poster");
      assert.equal(payload.selection.metadataAvailable, false);
      assert.equal(payload.frame, null);
      assert.equal(payload.fallback.source, "poster");
      assert.equal(payload.fallback.path, posterPath);
      assert.equal(path.isAbsolute(payload.fallback.path), true);
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

test("start with simulated initial navigation failure writes manifest diagnostics", async () => {
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
        "--json",
      ],
      { TIMELAPSE_SIMULATE_NAVIGATION_FAILURE: "1" },
    );
    assert.equal(result.status, 0, result.stderr);

    const startPayload = JSON.parse(result.stdout);
    assert.equal(startPayload.runDir, runDir);

    const status = await waitForTerminalStatus(runDir);
    const job = JSON.parse(
      await fs.readFile(path.join(runDir, "job.json"), "utf8"),
    );
    assert.equal(status.state, "failed");
    assert.equal(job.state, "failed");
    assert.equal(status.frames.captured, 0);
    assert.equal(status.frames.failed, 1);
    assert.match(status.error, /navigation failed:/);

    const manifest = (
      await fs.readFile(path.join(runDir, "manifest.jsonl"), "utf8")
    )
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].index, 1);
    assert.equal(manifest[0].status, "failed");
    assert.equal(manifest[0].capturedAt, null);
    assert.equal(manifest[0].path, null);
    assert.equal(manifest[0].url, "http://example.test/");
    assert.equal(manifest[0].title, null);
    assert.deepEqual(manifest[0].viewport, { width: 1440, height: 900 });
    assert.match(manifest[0].error, /navigation failed:/);
    assert.equal(manifest[0].error, status.error);

    const renderResult = runCli(["render", runDir]);
    assert.notEqual(renderResult.status, 0);
    assert.match(renderResult.stderr, /No frames found to render|no frames/i);

    for (const artifact of [
      "manifest.jsonl",
      "status.json",
      "capture.log",
      "render.log",
      "run-summary.json",
    ]) {
      await fs.access(path.join(runDir, artifact));
    }

    const renderLog = await fs.readFile(
      path.join(runDir, "render.log"),
      "utf8",
    );
    assert.match(renderLog, /render attempt failed/);
    const summary = JSON.parse(
      await fs.readFile(path.join(runDir, "run-summary.json"), "utf8"),
    );
    assert.match(summary.lastRenderAttempt.error, /No frames found to render/i);

    const humanStatus = runCli(["status", runDir]);
    assert.equal(humanStatus.status, 0, humanStatus.stderr);
    assert.match(humanStatus.stdout, /^state: render_failed$/m);
    assert.match(humanStatus.stdout, /^error: .*No frames found to render/im);
    assert.doesNotMatch(humanStatus.stdout, /\bat .+\(.+:\d+:\d+\)/);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("status --human output surfaces the recorded error for failed runs", async () => {
  const runDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "tlc-nav-fail-human-"),
  );
  try {
    const startResult = runCli(
      [
        "start",
        "http://example.test/",
        "--duration",
        "1s",
        "--interval",
        "1s",
        "--out",
        runDir,
        "--json",
      ],
      { TIMELAPSE_SIMULATE_NAVIGATION_FAILURE: "1" },
    );
    assert.equal(startResult.status, 0, startResult.stderr);

    const status = await waitForTerminalStatus(runDir);
    assert.equal(status.state, "failed");
    assert.match(status.error, /navigation failed:/);

    const humanResult = runCli(["status", runDir]);
    assert.equal(humanResult.status, 0, humanResult.stderr);
    assert.match(humanResult.stdout, /^state: failed$/m);
    assert.match(humanResult.stdout, /^error: navigation failed:/m);
    assert.match(
      humanResult.stdout,
      new RegExp(
        `^error: .*${status.error.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}`,
        "m",
      ),
    );
    assert.doesNotMatch(humanResult.stdout, /\bat .+\(.+:\d+:\d+\)/);

    const jsonResult = runCli(["status", runDir, "--json"]);
    assert.equal(jsonResult.status, 0, jsonResult.stderr);
    const jsonPayload = JSON.parse(jsonResult.stdout);
    assert.equal(jsonPayload.status.error, status.error);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("status --human output omits error line when no error is recorded", async () => {
  const { runDir } = await makeRun({ state: "completed" });
  try {
    const result = runCli(["status", runDir]);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /^error: /m);
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
    assert.match(peekResult.stderr, /poster/);
    assert.doesNotMatch(peekResult.stderr, /latest-retained\.png/);
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
    await commandStart({
      target: "http://example.com",
      options: {
        out: runDir,
        duration: { ms: 1000 },
        "keep-samples": "7",
        cleanup: "never",
      },
    });

    const config = JSON.parse(
      await fs.readFile(path.join(runDir, "config.json"), "utf8"),
    );
    assert.equal(config.keepSamples, 7);
  } finally {
    delete process.env.TIMELAPSE_SIMULATE_FRAMES;
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("commandStart saves keepSamples (default) to config.json", async () => {
  const runDir = path.join(
    os.tmpdir(),
    "tlc-test-start-samples-default-" + Date.now(),
  );
  try {
    process.env.TIMELAPSE_SIMULATE_FRAMES = "3";
    await commandStart({
      target: "http://example.com",
      options: {
        out: runDir,
        duration: { ms: 1000 },
        "keep-samples": true,
        cleanup: "never",
      },
    });

    const config = JSON.parse(
      await fs.readFile(path.join(runDir, "config.json"), "utf8"),
    );
    assert.equal(config.keepSamples, 2);
  } finally {
    delete process.env.TIMELAPSE_SIMULATE_FRAMES;
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("start retention cleanup:never is honored by render without render flags", async () => {
  const runDir = path.join(
    os.tmpdir(),
    "tlc-test-start-render-never-" + Date.now(),
  );
  try {
    process.env.TIMELAPSE_SIMULATE_FRAMES = "3";
    await commandStart({
      target: "http://example.com",
      options: {
        out: runDir,
        duration: { ms: 1000 },
        cleanup: "never",
        "no-render": true,
      },
    });
    await waitForTerminalStatus(runDir);

    await withFakeFFmpeg(async (manager) => {
      const originalPath = process.env.PATH;
      process.env.PATH = manager.getPATHEnv();
      try {
        await commandRender({ runDir, options: {} });
      } finally {
        process.env.PATH = originalPath;
      }
    });

    const frames = await fs.readdir(path.join(runDir, "frames"));
    assert.equal(frames.length, 3);
    const summary = JSON.parse(
      await fs.readFile(path.join(runDir, "run-summary.json"), "utf8"),
    );
    assert.equal(summary.cleanup.reason, "never");
    assert.equal(summary.cleanup.source, "config");
  } finally {
    delete process.env.TIMELAPSE_SIMULATE_FRAMES;
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("start retention keepLatest is honored by render without render flags", async () => {
  const runDir = path.join(
    os.tmpdir(),
    "tlc-test-start-render-keep-latest-" + Date.now(),
  );
  try {
    process.env.TIMELAPSE_SIMULATE_FRAMES = "3";
    await commandStart({
      target: "http://example.com",
      options: {
        out: runDir,
        duration: { ms: 1000 },
        "keep-latest": true,
        "no-render": true,
      },
    });
    await waitForTerminalStatus(runDir);

    await withFakeFFmpeg(async (manager) => {
      const originalPath = process.env.PATH;
      process.env.PATH = manager.getPATHEnv();
      try {
        await commandRender({ runDir, options: {} });
      } finally {
        process.env.PATH = originalPath;
      }
    });

    const frames = await fs.readdir(path.join(runDir, "frames"));
    assert.deepEqual(frames.sort(), ["frame-0003.jpeg"]);
    const summary = JSON.parse(
      await fs.readFile(path.join(runDir, "run-summary.json"), "utf8"),
    );
    assert.equal(summary.cleanup.reason, "keep-latest");
    assert.equal(summary.cleanup.source, "config");
  } finally {
    delete process.env.TIMELAPSE_SIMULATE_FRAMES;
    await fs.rm(runDir, { recursive: true, force: true });
  }
});
