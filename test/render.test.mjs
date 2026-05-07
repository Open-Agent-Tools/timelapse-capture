import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  renderFrames,
  validateMP4,
  cleanupFrames
} from "../src/timelapse-capture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, "..", "src", "timelapse-capture.mjs");

function createTempDir() {
  const dir = path.join(
    "/tmp",
    `test-render-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

function writeFakeFFprobe(binDir) {
  writeExecutable(path.join(binDir, "ffprobe"), [
    "#!/bin/sh",
    "cat << 'EOF'",
    "{",
    '  "streams": [',
    "    {",
    '      "codec_type": "video",',
    '      "width": 1280,',
    '      "height": 720',
    "    }",
    "  ],",
    '  "format": {',
    '    "duration": "10.0"',
    "  }",
    "}",
    "EOF",
    "exit 0"
  ].join("\n"));
}

function writeFakeFFmpeg(binDir) {
  writeExecutable(path.join(binDir, "ffmpeg"), [
    "#!/bin/sh",
    "for arg do out_file=\"$arg\"; done",
    "printf \"fake mp4 bytes\" > \"$out_file\"",
    "exit 0"
  ].join("\n"));
}

function writeRecordingFakeFFmpeg(binDir, argvPath) {
  writeExecutable(path.join(binDir, "ffmpeg"), [
    "#!/bin/sh",
    `: > ${JSON.stringify(argvPath)}`,
    "for arg do",
    `  printf '%s\\n' \"$arg\" >> ${JSON.stringify(argvPath)}`,
    "  out_file=\"$arg\"",
    "done",
    "printf \"fake mp4 bytes\" > \"$out_file\"",
    "exit 0"
  ].join("\n"));
}

function withFakePath(binDir, testFn) {
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath || ""}`;
  try {
    return testFn();
  } finally {
    process.env.PATH = oldPath;
  }
}

function runCli({ cwd, args, env = {} }) {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
  if (result.status !== 0) {
    throw new Error(
      `cli failed (${result.status}): ${result.stdout}\n${result.stderr}`
    );
  }
  return { stdout: result.stdout.trim(), stderr: result.stderr };
}

test("renderFrames: fails with missing run directory", () => {
  const result = renderFrames("/nonexistent/run/dir");
  assert.strictEqual(result.success, false);
  assert.match(result.error, /does not exist/);
});

test("renderFrames: fails with no frames", () => {
  const runDir = createTempDir();
  try {
    fs.mkdirSync(path.join(runDir, "frames"), { recursive: true });
    const result = renderFrames(runDir);
    assert.strictEqual(result.success, false);
    assert.match(result.error, /No frames found/);
  } finally {
    cleanupTempDir(runDir);
  }
});

test("validateMP4: detects missing file", () => {
  const result = validateMP4("/nonexistent/file.mp4");
  assert.strictEqual(result.exists, false);
  assert.match(result.error, /does not exist/);
});

test("validateMP4: detects empty file", () => {
  const runDir = createTempDir();
  try {
    const mp4Path = path.join(runDir, "empty.mp4");
    fs.writeFileSync(mp4Path, "");
    const result = validateMP4(mp4Path);
    assert.strictEqual(result.exists, true);
    assert.strictEqual(result.bytes, 0);
    assert.match(result.error, /empty/i);
  } finally {
    cleanupTempDir(runDir);
  }
});

test("validateMP4: treats shell metacharacters in output path as literal argv", () => {
  const runDir = createTempDir();
  const markerName = `ffprobe-marker-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const markerPath = path.join(process.cwd(), markerName);
  try {
    const binDir = path.join(runDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    writeFakeFFprobe(binDir);

    const mp4Path = path.join(runDir, `safe " ; touch ${markerName} ; echo ".mp4`);
    fs.writeFileSync(mp4Path, "fake mp4 bytes");

    withFakePath(binDir, () => {
      const result = validateMP4(mp4Path);

      assert.strictEqual(result.error, null);
      assert.strictEqual(result.hasVideoStream, true);
      assert.deepStrictEqual(result.dimensions, { width: 1280, height: 720 });
    });

    assert.strictEqual(fs.existsSync(markerPath), false);
  } finally {
    fs.rmSync(markerPath, { force: true });
    cleanupTempDir(runDir);
  }
});

test("renderFrames: treats shell metacharacters in run directory as literal argv", () => {
  const tempDir = createTempDir();
  const markerName = `ffmpeg-marker-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const markerPath = path.join(process.cwd(), markerName);
  try {
    const binDir = path.join(tempDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    writeFakeFFmpeg(binDir);
    writeFakeFFprobe(binDir);

    const runDir = path.join(tempDir, `run " ; touch ${markerName} ; echo " ok`);
    const framesDir = path.join(runDir, "frames");
    fs.mkdirSync(framesDir, { recursive: true });
    fs.writeFileSync(path.join(framesDir, "frame-0001.png"), "fake png");

    withFakePath(binDir, () => {
      const result = renderFrames(runDir, { "keep-frames": true });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.outputPath, path.join(runDir, "output.mp4"));
    });

    assert.strictEqual(fs.existsSync(markerPath), false);
    assert.strictEqual(fs.existsSync(path.join(framesDir, "frame-0001.png")), true);
  } finally {
    fs.rmSync(markerPath, { force: true });
    cleanupTempDir(tempDir);
  }
});

test("renderFrames: fails without overwriting malformed summary JSON", () => {
  const runDir = createTempDir();
  const malformedSummary = "{";
  try {
    const binDir = path.join(runDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    writeFakeFFmpeg(binDir);
    writeFakeFFprobe(binDir);

    const framesDir = path.join(runDir, "frames");
    fs.mkdirSync(framesDir, { recursive: true });
    fs.writeFileSync(path.join(framesDir, "frame-0001.png"), "fake png");
    fs.writeFileSync(path.join(runDir, "run-summary.json"), malformedSummary);

    withFakePath(binDir, () => {
      const result = renderFrames(runDir, { "keep-frames": true });

      assert.strictEqual(result.success, false);
      assert.match(result.error, /JSON|position|Unexpected/);
    });

    assert.strictEqual(
      fs.readFileSync(path.join(runDir, "run-summary.json"), "utf8"),
      malformedSummary
    );
  } finally {
    cleanupTempDir(runDir);
  }
});

test("cleanupFrames: removes frame files", () => {
  const runDir = createTempDir();
  try {
    const framesDir = path.join(runDir, "frames");
    fs.mkdirSync(framesDir, { recursive: true });
    fs.writeFileSync(path.join(framesDir, "frame-0001.png"), "fake png");
    fs.writeFileSync(path.join(framesDir, "frame-0002.png"), "fake png");
    fs.writeFileSync(path.join(framesDir, "other.txt"), "not a frame");

    const result = cleanupFrames(framesDir);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.removed, 2);
    assert.strictEqual(fs.existsSync(path.join(framesDir, "frame-0001.png")), false);
    assert.strictEqual(fs.existsSync(path.join(framesDir, "frame-0002.png")), false);
    assert.strictEqual(fs.existsSync(path.join(framesDir, "other.txt")), true);
  } finally {
    cleanupTempDir(runDir);
  }
});

test("cleanupFrames: handles empty directory", () => {
  const runDir = createTempDir();
  try {
    const framesDir = path.join(runDir, "frames");
    fs.mkdirSync(framesDir, { recursive: true });
    const result = cleanupFrames(framesDir);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.removed, 0);
  } finally {
    cleanupTempDir(runDir);
  }
});

test("cleanupFrames: handles nonexistent directory", () => {
  const result = cleanupFrames("/nonexistent/frames");
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.removed, 0);
});

test("renderFrames: consumes frames written by capture (frame-%04d.png contract)", () => {
  const workDir = createTempDir();
  try {
    const runDir = path.join(workDir, "run");
    runCli({
      cwd: workDir,
      args: [
        "start",
        "http://example.test/",
        "--out",
        runDir,
        "--json",
        "--interval",
        "100ms",
        "--duration",
        "300ms"
      ],
      env: { TIMELAPSE_SIMULATE_FRAMES: "3" }
    });

    const framesDir = path.join(runDir, "frames");
    assert.deepStrictEqual(
      fs.readdirSync(framesDir).filter((file) => file.endsWith(".png")).sort(),
      ["frame-0001.png", "frame-0002.png", "frame-0003.png"]
    );

    const binDir = path.join(workDir, "bin");
    const argvPath = path.join(workDir, "ffmpeg-argv.txt");
    fs.mkdirSync(binDir, { recursive: true });
    writeRecordingFakeFFmpeg(binDir, argvPath);
    writeFakeFFprobe(binDir);

    withFakePath(binDir, () => {
      const result = renderFrames(runDir, { "keep-frames": true });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.outputPath, path.join(runDir, "output.mp4"));
      assert.ok(fs.statSync(result.outputPath).size > 0);
    });

    const argv = fs.readFileSync(argvPath, "utf8").trim().split("\n");
    const inputPattern = argv[argv.indexOf("-i") + 1];
    assert.strictEqual(inputPattern, path.join(framesDir, "frame-%04d.png"));
  } finally {
    cleanupTempDir(workDir);
  }
});
