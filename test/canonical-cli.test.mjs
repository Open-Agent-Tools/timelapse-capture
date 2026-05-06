import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  ParseError,
  parseArgs,
  parseDuration,
  parseViewport,
  buildStatusPayload,
  doctorCommand,
  statusCommand
} from "../src/timelapse-capture.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI_PATH = path.resolve(__dirname, "..", "src", "timelapse-capture.mjs");

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
    ...options
  });
}

test("parseDuration accepts simple unit forms", () => {
  assert.deepEqual(parseDuration("10s"), { input: "10s", ms: 10_000 });
  assert.deepEqual(parseDuration("2m30s"), { input: "2m30s", ms: 150_000 });
  assert.deepEqual(parseDuration("1h"), { input: "1h", ms: 3_600_000 });
  assert.equal(parseDuration("500ms").ms, 500);
});

test("parseDuration rejects malformed input with E_BAD_DURATION", () => {
  for (const value of ["", "  ", "abc", "99x", "1y", "h1"]) {
    assert.throws(() => parseDuration(value), {
      name: "ParseError",
      code: "E_BAD_DURATION"
    }, `expected ${JSON.stringify(value)} to be rejected`);
  }
});

test("parseViewport accepts WIDTHxHEIGHT", () => {
  assert.deepEqual(parseViewport("1280x800"), { input: "1280x800", width: 1280, height: 800 });
});

test("parseViewport rejects malformed input with E_BAD_VIEWPORT", () => {
  for (const value of ["1280", "1280x", "x800", "abc", "0x100"]) {
    assert.throws(() => parseViewport(value), {
      name: "ParseError",
      code: "E_BAD_VIEWPORT"
    }, `expected ${JSON.stringify(value)} to be rejected`);
  }
});

test("parseArgs returns help for empty argv", () => {
  assert.deepEqual(parseArgs([]), { command: "help", options: {}, positionals: [] });
});

test("parseArgs rejects unknown command with E_UNKNOWN_COMMAND", () => {
  assert.throws(() => parseArgs(["unknown"]), {
    name: "ParseError",
    code: "E_UNKNOWN_COMMAND"
  });
});

test("parseArgs accepts positional URL for start", () => {
  const parsed = parseArgs(["start", "https://example.com", "--duration", "10s", "--interval", "1s"]);
  assert.equal(parsed.command, "start");
  assert.equal(parsed.positionals[0], "https://example.com");
  assert.equal(parsed.target, "https://example.com");
  assert.equal(parsed.options.duration.ms, 10_000);
  assert.equal(parsed.options.interval, 1_000);
});

test("parseArgs accepts --url flag for start", () => {
  const parsed = parseArgs(["start", "--url", "https://example.com", "--duration", "10s", "--interval", "1s"]);
  assert.equal(parsed.options.url, "https://example.com");
});

test("parseArgs supports --no-<flag> negation for boolean flags", () => {
  const parsed = parseArgs(["start", "https://example.com", "--no-headed", "--duration", "10s", "--interval", "1s"]);
  assert.equal(parsed.options.headed, false);
});

test("parseArgs rejects --no- on unknown bool flag", () => {
  assert.throws(() => parseArgs(["start", "--no-bogus"]), {
    name: "ParseError",
    code: "E_UNKNOWN_FLAG"
  });
});

test("parseArgs rejects unknown flag for command", () => {
  assert.throws(() => parseArgs(["status", "runs/foo", "--bogus"]), {
    name: "ParseError",
    code: "E_UNKNOWN_FLAG"
  });
});

test("parseArgs requires values for value flags", () => {
  assert.throws(() => parseArgs(["start", "https://example.com", "--duration"]), {
    name: "ParseError",
    code: "E_MISSING_VALUE"
  });
});

test("parseArgs rejects too many positional arguments", () => {
  assert.throws(() => parseArgs(["status", "runs/foo", "extra"]), {
    name: "ParseError",
    code: "E_EXTRA_ARGUMENT"
  });
});

test("parseArgs propagates structured errors for malformed duration", () => {
  assert.throws(() => parseArgs(["start", "https://example.com", "--duration", "99x"]), {
    name: "ParseError",
    code: "E_BAD_DURATION"
  });
});

test("parseArgs propagates structured errors for malformed viewport", () => {
  assert.throws(() => parseArgs(["start", "https://example.com", "--viewport", "1280"]), {
    name: "ParseError",
    code: "E_BAD_VIEWPORT"
  });
});

test("parseArgs supports peek --index and --near", () => {
  const parsed = parseArgs(["peek", "runs/foo", "--index", "2"]);
  assert.equal(parsed.options.index, 2);

  const parsedNear = parseArgs(["peek", "runs/foo", "--near", "2026-01-01T00:00:00Z"]);
  assert.equal(parsedNear.options.near, "2026-01-01T00:00:00Z");
});

test("buildStatusPayload exposes elapsed, ETA, stale-warning, and disk usage", () => {
  const startedAt = new Date(Date.now() - 30_000).toISOString();
  const latestCapturedAt = new Date(Date.now() - 5_000).toISOString();

  const payload = buildStatusPayload({
    runDir: "/tmp/run",
    config: { intervalMs: 1000, expectedFrames: 10 },
    status: {
      state: "running",
      startedAt,
      framesCaptured: 3,
      framesFailed: 1,
      updatedAt: latestCapturedAt
    },
    latest: { path: "frames/frame-000003.png", capturedAt: latestCapturedAt },
    summary: null,
    framesBytes: 4096,
    runDirBytes: 8192
  });

  assert.equal(payload.state, "running");
  assert.equal(payload.frames.captured, 3);
  assert.equal(payload.frames.failed, 1);
  assert.equal(payload.frames.totalExpected, 10);
  assert.equal(payload.frameCount, 3);
  assert.equal(payload.failedFrameCount, 1);
  assert.ok(payload.elapsedMs >= 25_000);
  assert.equal(payload.etaMs, (10 - 4) * 1000);
  assert.equal(payload.staleWarning.isStale, true);
  assert.equal(payload.staleWarning.intervalMs, 1000);
  assert.equal(payload.diskUsage.runDirBytes, 8192);
  assert.equal(payload.diskUsage.framesBytes, 4096);
  assert.equal(payload.latestFrame, path.join("/tmp/run", "frames/frame-000003.png"));
  assert.equal(payload.latestFrameTimestamp, latestCapturedAt);
});

test("buildStatusPayload surfaces output and cleanup from run-summary.json", () => {
  const payload = buildStatusPayload({
    runDir: "/tmp/run",
    config: { intervalMs: 1000, expectedFrames: 1 },
    status: {
      state: "rendered",
      startedAt: new Date().toISOString(),
      framesCaptured: 1,
      framesFailed: 0
    },
    latest: null,
    summary: {
      output: "/tmp/run/output.mp4",
      cleanup: { filesDeleted: 3, retained: 1 }
    },
    framesBytes: 0,
    runDirBytes: 100
  });

  assert.equal(payload.outputPath, "/tmp/run/output.mp4");
  assert.deepEqual(payload.cleanup, { filesDeleted: 3, retained: 1 });
});

test("doctorCommand --json returns ok flag and check list", async () => {
  const log = console.log;
  const captured = [];
  console.log = (line) => captured.push(String(line));
  let result;
  try {
    result = await doctorCommand({ options: { json: true } });
  } finally {
    console.log = log;
    process.exitCode = 0;
  }

  assert.ok(captured.length > 0, "doctor --json should print at least one line");
  const parsed = JSON.parse(captured.join("\n"));
  assert.equal(typeof parsed.ok, "boolean");
  assert.ok(Array.isArray(parsed.checks));
  const names = parsed.checks.map((check) => check.name);
  for (const required of ["node", "playwright", "chromium", "ffmpeg", "ffprobe"]) {
    assert.ok(names.includes(required), `expected doctor check "${required}"`);
  }
  assert.equal(typeof result.ok, "boolean");
  assert.deepEqual(result.checks.map((c) => c.name), names);
});

test("statusCommand JSON output reads canonical artifacts and includes enrichment", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "canonical-status-"));
  const framesDir = path.join(runDir, "frames");
  await fs.mkdir(framesDir);
  const framePath = path.join(framesDir, "frame-000001.png");
  await fs.writeFile(framePath, "fake png bytes");

  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const latestCapturedAt = new Date(Date.now() - 1_500).toISOString();

  await fs.writeFile(path.join(runDir, "config.json"), `${JSON.stringify({
    intervalMs: 1000,
    intervalSeconds: 1,
    expectedFrames: 5,
    fps: 24,
    viewport: { width: 320, height: 240 }
  })}\n`);
  await fs.writeFile(path.join(runDir, "status.json"), `${JSON.stringify({
    state: "running",
    startedAt,
    updatedAt: latestCapturedAt,
    framesAttempted: 2,
    framesCaptured: 1,
    framesFailed: 1
  })}\n`);
  await fs.writeFile(path.join(runDir, "latest-frame.json"), `${JSON.stringify({
    path: "frames/frame-000001.png",
    capturedAt: latestCapturedAt,
    index: 1
  })}\n`);
  await fs.writeFile(path.join(runDir, "run-summary.json"), `${JSON.stringify({
    output: path.join(runDir, "output.mp4"),
    cleanup: { filesDeleted: 0, retained: 1 }
  })}\n`);

  const log = console.log;
  const captured = [];
  console.log = (line) => captured.push(String(line));
  try {
    await statusCommand({ command: "status", positionals: [runDir], options: { json: true } });
  } finally {
    console.log = log;
  }

  const payload = JSON.parse(captured.join("\n"));
  try {
    assert.equal(payload.state, "running");
    assert.equal(payload.frames.captured, 1);
    assert.equal(payload.frames.failed, 1);
    assert.equal(payload.frames.totalExpected, 5);
    assert.ok(payload.elapsedMs >= 50_000);
    assert.ok(payload.etaMs > 0);
    assert.equal(payload.staleWarning.intervalMs, 1000);
    assert.ok(payload.diskUsage.runDirBytes >= payload.diskUsage.framesBytes);
    assert.ok(payload.diskUsage.framesBytes > 0);
    assert.equal(payload.latestFrame, framePath);
    assert.equal(payload.latestFrameTimestamp, latestCapturedAt);
    assert.equal(payload.outputPath, path.join(runDir, "output.mp4"));
    assert.deepEqual(payload.cleanup, { filesDeleted: 0, retained: 1 });
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("CLI: unknown command exits 2 with structured error", () => {
  const result = runCli(["nonsense"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /E_UNKNOWN_COMMAND/);
});

test("CLI: malformed --duration exits 2 with E_BAD_DURATION", () => {
  const result = runCli(["start", "https://example.com", "--duration", "99x"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /E_BAD_DURATION/);
});

test("CLI: doctor --json prints a parseable JSON object", () => {
  const result = runCli(["doctor", "--json"]);
  assert.ok(result.stdout, `expected doctor stdout, got: ${result.stderr}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(typeof payload.ok, "boolean");
  assert.ok(Array.isArray(payload.checks));
  const expected = ["node", "playwright", "chromium", "ffmpeg", "ffprobe"];
  for (const name of expected) {
    assert.ok(payload.checks.find((check) => check.name === name), `doctor JSON missing check ${name}`);
  }
});

test("CLI: help prints usage when no args given", () => {
  const result = runCli([]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /timelapse-capture/);
  assert.match(result.stdout, /Usage:/);
});

test("CLI: status on missing run-dir surfaces a clear error", () => {
  const result = runCli(["status", path.join(os.tmpdir(), "this-run-does-not-exist-" + Date.now())]);
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.length > 0);
});

test("source does not fall back to a hardcoded 1x1 PNG buffer", async () => {
  const text = await fs.readFile(CLI_PATH, "utf8");
  // The legacy scaffold smuggled in a 1x1 PNG via this exact hex blob.
  // The canonical entry must rely on real Playwright screenshots instead.
  assert.equal(
    text.includes("89504e470d0a1a0a0000000d4948445200000001000000010802"),
    false,
    "canonical CLI must not contain the 1x1 PNG fallback fixture"
  );
});
