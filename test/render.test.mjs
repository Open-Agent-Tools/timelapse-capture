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

test("cleanupFrames: removes frame files", () => {
  const runDir = createTempDir();
  try {
    const framesDir = path.join(runDir, "frames");
    fs.mkdirSync(framesDir, { recursive: true });
    fs.writeFileSync(path.join(framesDir, "00001.png"), "fake png");
    fs.writeFileSync(path.join(framesDir, "00002.png"), "fake png");
    fs.writeFileSync(path.join(framesDir, "other.txt"), "not a frame");

    const result = cleanupFrames(framesDir);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.removed, 2);
    assert.strictEqual(fs.existsSync(path.join(framesDir, "00001.png")), false);
    assert.strictEqual(fs.existsSync(path.join(framesDir, "00002.png")), false);
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
