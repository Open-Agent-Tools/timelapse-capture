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

function writeFakeBin(binDir, name, script) {
  const binPath = path.join(binDir, name);
  fs.writeFileSync(binPath, script, { mode: 0o755 });
}

test('validateMP4: passes literal path with shell metacharacters to ffprobe', () => {
  const root = createTempDir();
  const oldPath = process.env.PATH;
  try {
    const binDir = path.join(root, 'bin');
    fs.mkdirSync(binDir, { recursive: true });

    const markerPath = path.join(root, 'marker');
    const ffprobeScript = '#!/bin/sh\n' +
      'cat << \'EOF\'\n' +
      '{"streams":[{"codec_type":"video","width":640,"height":480,"duration":"5.0"}],' +
      '"format":{"duration":"5.0","size":"1000"}}\n' +
      'EOF\n' +
      'exit 0\n';
    writeFakeBin(binDir, 'ffprobe', ffprobeScript);

    const trickyDir = path.join(root, 'safe " ; touch ' + markerPath + ' ; ');
    fs.mkdirSync(trickyDir, { recursive: true });
    const mp4Path = path.join(trickyDir, 'output.mp4');
    fs.writeFileSync(mp4Path, 'fake mp4 bytes');

    process.env.PATH = `${binDir}:${oldPath || ''}`;

    const result = validateMP4(mp4Path);
    assert.strictEqual(result.error, null, `expected no error, got: ${result.error}`);
    assert.strictEqual(result.exists, true);
    assert.strictEqual(result.hasVideoStream, true);
    assert.deepStrictEqual(result.dimensions, { width: 640, height: 480 });
    assert.strictEqual(result.duration, 5);
    assert.strictEqual(fs.existsSync(markerPath), false,
      'marker file must not exist; presence proves a shell interpreted the path');
  } finally {
    process.env.PATH = oldPath;
    cleanupTempDir(root);
  }
});

test('renderFrames: passes literal paths with shell metacharacters to ffmpeg', () => {
  const root = createTempDir();
  const oldPath = process.env.PATH;
  try {
    const binDir = path.join(root, 'bin');
    fs.mkdirSync(binDir, { recursive: true });

    const markerPath = path.join(root, 'marker');
    const ffmpegScript = '#!/bin/sh\n' +
      'for arg do out_file="$arg"; done\n' +
      'printf "fake mp4 bytes" > "$out_file"\n' +
      'exit 0\n';
    writeFakeBin(binDir, 'ffmpeg', ffmpegScript);

    const ffprobeScript = '#!/bin/sh\n' +
      'cat << \'EOF\'\n' +
      '{"streams":[{"codec_type":"video","width":1280,"height":720,"duration":"10.0"}],' +
      '"format":{"duration":"10.0","size":"1000"}}\n' +
      'EOF\n' +
      'exit 0\n';
    writeFakeBin(binDir, 'ffprobe', ffprobeScript);

    const runDir = path.join(root, 'run " ; touch ' + markerPath + ' ; ');
    const framesDir = path.join(runDir, 'frames');
    fs.mkdirSync(framesDir, { recursive: true });
    fs.writeFileSync(path.join(framesDir, '00001.png'), 'fake png');

    process.env.PATH = `${binDir}:${oldPath || ''}`;

    const result = renderFrames(runDir, { 'keep-frames': true });
    assert.strictEqual(result.success, true, `expected success, got error: ${result.error}`);
    assert.strictEqual(result.outputPath, path.resolve(runDir, 'output.mp4'));
    assert.strictEqual(fs.existsSync(markerPath), false,
      'marker file must not exist; presence proves a shell interpreted the path');
    assert.strictEqual(fs.existsSync(path.join(framesDir, '00001.png')), true,
      'frame should be preserved due to keep-frames');
    assert.match(result.metadata.ffmpegCommand, /^ffmpeg /);
  } finally {
    process.env.PATH = oldPath;
    cleanupTempDir(root);
  }
});
