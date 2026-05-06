'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { renderFrames, validateMP4, cleanupFrames } = require('../src/cli/render');

function createTempDir() {
  const dir = path.join('/tmp', `test-render-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

function prependFakeBinaries(binDir) {
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath || ''}`;
  return () => {
    process.env.PATH = oldPath;
  };
}

function writeSuccessfulFakeFFprobe(binDir) {
  writeExecutable(path.join(binDir, 'ffprobe'), `#!/bin/sh
cat <<'EOF'
{
  "streams": [
    {
      "codec_type": "video",
      "width": 1280,
      "height": 720
    }
  ],
  "format": {
    "duration": "10.0"
  }
}
EOF
exit 0
`);
}

function writeSuccessfulFakeFFmpeg(binDir) {
  writeExecutable(path.join(binDir, 'ffmpeg'), `#!/bin/sh
for arg do out_file="$arg"; done
printf "fake mp4 bytes" > "$out_file"
exit 0
`);
}

function writeSuccessfulFakeFFmpegAt(filePath) {
  writeExecutable(filePath, `#!/bin/sh
for arg do out_file="$arg"; done
printf "fake mp4 bytes" > "$out_file"
exit 0
`);
}

test('renderFrames: fails with missing run directory', () => {
  const result = renderFrames('/nonexistent/run/dir');
  assert.strictEqual(result.success, false);
  assert.match(result.error, /does not exist/);
});

test('renderFrames: fails with no frames', () => {
  const runDir = createTempDir();
  try {
    const framesDir = path.join(runDir, 'frames');
    fs.mkdirSync(framesDir, { recursive: true });

    const result = renderFrames(runDir);
    assert.strictEqual(result.success, false);
    assert.match(result.error, /No frames found/);
  } finally {
    cleanupTempDir(runDir);
  }
});

test('validateMP4: detects missing file', () => {
  const result = validateMP4('/nonexistent/file.mp4');
  assert.strictEqual(result.exists, false);
  assert.match(result.error, /does not exist/);
});

test('validateMP4: detects empty file', () => {
  const runDir = createTempDir();
  try {
    const mp4Path = path.join(runDir, 'empty.mp4');
    fs.writeFileSync(mp4Path, '');

    const result = validateMP4(mp4Path);
    assert.strictEqual(result.exists, true);
    assert.strictEqual(result.bytes, 0);
    assert.match(result.error, /empty/i);
  } finally {
    cleanupTempDir(runDir);
  }
});

test('validateMP4: treats shell metacharacters in output path as literal argv', () => {
  const runDir = createTempDir();
  const binDir = path.join(runDir, 'bin');
  const markerPath = path.join(runDir, 'ffprobe-marker');
  const injectedDir = path.join(runDir, `safe " ; touch ${markerPath} ; echo "`);
  const mp4Path = path.join(injectedDir, 'output.mp4');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(injectedDir, { recursive: true });
  fs.writeFileSync(mp4Path, 'fake mp4 bytes');
  writeSuccessfulFakeFFprobe(binDir);

  const restorePath = prependFakeBinaries(binDir);
  try {
    const result = validateMP4(mp4Path);

    assert.strictEqual(result.error, null);
    assert.strictEqual(result.hasVideoStream, true);
    assert.deepStrictEqual(result.dimensions, { width: 1280, height: 720 });
    assert.strictEqual(fs.existsSync(markerPath), false);
  } finally {
    restorePath();
    cleanupTempDir(runDir);
  }
});

test('renderFrames: treats shell metacharacters in run directory as literal argv', () => {
  const tempDir = createTempDir();
  const binDir = path.join(tempDir, 'bin');
  const markerPath = path.join(tempDir, 'ffmpeg-marker');
  const runDir = path.join(tempDir, `run " ; touch ${markerPath} ; echo "`);
  const framesDir = path.join(runDir, 'frames');
  const framePath = path.join(framesDir, '00001.png');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(framesDir, { recursive: true });
  fs.writeFileSync(framePath, 'fake png');
  writeSuccessfulFakeFFmpeg(binDir);
  writeSuccessfulFakeFFprobe(binDir);

  const restorePath = prependFakeBinaries(binDir);
  try {
    const result = renderFrames(runDir, { 'keep-frames': true });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.outputPath, path.join(runDir, 'output.mp4'));
    assert.strictEqual(fs.existsSync(markerPath), false);
    assert.strictEqual(fs.existsSync(framePath), true);
  } finally {
    restorePath();
    cleanupTempDir(tempDir);
  }
});

test('renderFrames: preserves explicit ffmpegPath override', () => {
  const tempDir = createTempDir();
  const binDir = path.join(tempDir, 'bin');
  const runDir = path.join(tempDir, 'run');
  const framesDir = path.join(runDir, 'frames');
  const customFFmpegPath = path.join(binDir, 'custom-ffmpeg');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(framesDir, { recursive: true });
  fs.writeFileSync(path.join(framesDir, '00001.png'), 'fake png');
  writeSuccessfulFakeFFmpegAt(customFFmpegPath);
  writeSuccessfulFakeFFprobe(binDir);

  const restorePath = prependFakeBinaries(binDir);
  try {
    const result = renderFrames(runDir, { 'keep-frames': true, ffmpegPath: customFFmpegPath });

    assert.strictEqual(result.success, true);
    assert.match(result.metadata.ffmpegCommand, new RegExp(`^${customFFmpegPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `));
  } finally {
    restorePath();
    cleanupTempDir(tempDir);
  }
});

test('cleanupFrames: removes frame files', () => {
  const runDir = createTempDir();
  try {
    const framesDir = path.join(runDir, 'frames');
    fs.mkdirSync(framesDir, { recursive: true });

    fs.writeFileSync(path.join(framesDir, '00001.png'), 'fake png');
    fs.writeFileSync(path.join(framesDir, '00002.png'), 'fake png');
    fs.writeFileSync(path.join(framesDir, 'other.txt'), 'not a frame');

    const result = cleanupFrames(framesDir);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.removed, 2);

    assert.strictEqual(fs.existsSync(path.join(framesDir, '00001.png')), false);
    assert.strictEqual(fs.existsSync(path.join(framesDir, '00002.png')), false);
    assert.strictEqual(fs.existsSync(path.join(framesDir, 'other.txt')), true);
  } finally {
    cleanupTempDir(runDir);
  }
});

test('cleanupFrames: handles empty directory', () => {
  const runDir = createTempDir();
  try {
    const framesDir = path.join(runDir, 'frames');
    fs.mkdirSync(framesDir, { recursive: true });

    const result = cleanupFrames(framesDir);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.removed, 0);
  } finally {
    cleanupTempDir(runDir);
  }
});

test('cleanupFrames: handles nonexistent directory', () => {
  const result = cleanupFrames('/nonexistent/frames');
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.removed, 0);
});
