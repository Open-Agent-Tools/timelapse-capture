import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

import {
  renderFrames,
  validateMP4,
  cleanupFrames
} from "../src/timelapse-capture.mjs";

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
    "input_pattern=\"\"",
    "while [ $# -gt 0 ]; do",
    "  if [ \"$1\" = \"-i\" ]; then input_pattern=\"$2\"; shift; fi",
    "  out_file=\"$1\"",
    "  shift",
    "done",
    "if [ -n \"$input_pattern\" ] && [ \"$input_pattern\" != \"pipe:0\" ]; then",
    "  dir=$(dirname \"$input_pattern\")",
    "  base=$(basename \"$input_pattern\")",
    "  case \"$base\" in",
    "    *%05d*) check_pattern=$(echo \"$base\" | sed 's/%05d/[0-9][0-9][0-9][0-9][0-9]/') ;;",
    "    *%04d*) check_pattern=$(echo \"$base\" | sed 's/%04d/[0-9][0-9][0-9][0-9]/') ;;",
    "    *) check_pattern=\"$base\" ;;",
    "  esac",
    "  found=false",
    "  for f in \"$dir\"/$check_pattern; do",
    "    if [ -f \"$f\" ]; then found=true; break; fi",
    "  done",
    "  if [ \"$found\" = \"false\" ]; then",
    "    echo \"ffmpeg: $input_pattern: No such file or directory\" >&2",
    "    exit 1",
    "  fi",
    "fi",
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
