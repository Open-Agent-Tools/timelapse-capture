import { mock, test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { commandPeek, commandStatus } from "../src/timelapse-capture.mjs";

function createFrameDirent(name) {
  return {
    name,
    isFile() {
      return true;
    },
    isDirectory() {
      return false;
    }
  };
}

async function writeStatusRunDir(runDir) {
  const statusPath = path.join(runDir, "status.json");
  const configPath = path.join(runDir, "config.json");
  await fsp.writeFile(statusPath, JSON.stringify({ state: "completed" }));
  await fsp.writeFile(configPath, JSON.stringify({}));
}

test("commandStatus treats missing frames directory as zero usage", async () => {
  const runDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tlc-fs-errors-status-"));
  try {
    await writeStatusRunDir(runDir);
    const result = await commandStatus({ runDir });
    assert.equal(result.framesDiskUsageBytes, 0);
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test("commandStatus ignores ENOENT from frame stat during traversal", async () => {
  const runDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tlc-fs-errors-status-"));
  const framesDir = path.join(runDir, "frames");
  const framePath = path.join(framesDir, "frame-0001.png");
  const originalStat = fsp.stat;

  try {
    await writeStatusRunDir(runDir);
    await fsp.mkdir(framesDir, { recursive: true });
    await fsp.writeFile(framePath, "frame");

    mock.method(fsp, "stat", async (target) => {
      if (target === framePath) {
        const error = new Error("frame disappeared");
        error.code = "ENOENT";
        throw error;
      }
      return originalStat(target);
    });

    const result = await commandStatus({ runDir });
    assert.equal(result.framesDiskUsageBytes, 0);
  } finally {
    mock.restoreAll();
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test("commandStatus treats ENOTDIR from nested traversal as a benign race", async () => {
  const runDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tlc-fs-errors-status-"));
  const framesDir = path.join(runDir, "frames");
  const stalePath = path.join(framesDir, "stale-dir");
  const originalReaddir = fsp.readdir;

  try {
    await writeStatusRunDir(runDir);
    await fsp.mkdir(framesDir, { recursive: true });
    await fsp.mkdir(stalePath, { recursive: true });

    mock.method(fsp, "readdir", async (target, options) => {
      if (target === stalePath) {
        const error = new Error("not a directory anymore");
        error.code = "ENOTDIR";
        throw error;
      }
      return originalReaddir(target, options);
    });

    const result = await commandStatus({ runDir });
    assert.equal(result.framesDiskUsageBytes, 0);
  } finally {
    mock.restoreAll();
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test("commandStatus surfaces non-ENOENT errors from frames traversal", async () => {
  const runDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tlc-fs-errors-status-"));
  const framesDir = path.join(runDir, "frames");
    await writeStatusRunDir(runDir);
    await fsp.mkdir(framesDir, { recursive: true });
  const originalReaddir = fsp.readdir;

  try {
    mock.method(fsp, "readdir", async (target) => {
      if (target === framesDir) {
        const error = new Error("permission denied reading frames");
        error.code = "EACCES";
        throw error;
      }
      return originalReaddir(target);
    });

    await assert.rejects(
      () => commandStatus({ runDir }),
      /permission denied reading frames|EACCES/
    );
  } finally {
    mock.restoreAll();
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test("commandPeek surfaces non-ENOENT errors when listing frame files", async () => {
  const runDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tlc-fs-errors-peek-"));
  const framesDir = path.join(runDir, "frames");
    await fsp.mkdir(framesDir, { recursive: true });
  const originalReaddir = fsp.readdir;

  try {
    mock.method(fsp, "readdir", async (target) => {
      if (target === framesDir) {
        const error = new Error("permission denied reading frames");
        error.code = "EACCES";
        throw error;
      }
      return originalReaddir(target);
    });

    await assert.rejects(
      () => commandPeek({ runDir, options: { latest: true } }),
      /permission denied reading frames|EACCES/
    );
  } finally {
    mock.restoreAll();
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test("commandPeek rejects with ENOENT fallback for missing manifest during --near", async () => {
  const runDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tlc-fs-errors-near-"));
  const framesDir = path.join(runDir, "frames");
  const manifestPath = path.join(runDir, "manifest.jsonl");
  await fsp.mkdir(framesDir, { recursive: true });
  const originalReaddir = fsp.readdir;
  const originalReadFile = fsp.readFile;

  try {
    mock.method(fsp, "readdir", async (target) => {
      if (target === framesDir) return [createFrameDirent("frame-0001.png")];
      return originalReaddir(target);
    });
    mock.method(fsp, "readFile", async (target, encoding) => {
      if (target === manifestPath) {
        const error = new Error("missing manifest");
        error.code = "ENOENT";
        throw error;
      }
      return originalReadFile(target, encoding);
    });

    await assert.rejects(
      () => commandPeek({ runDir, options: { near: "2026-05-09T12:00:00Z" } }),
      /No captured frame timestamps are available for --near\./
    );
  } finally {
    mock.restoreAll();
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test("commandPeek surfaces non-ENOENT errors when reading manifest during --near", async () => {
  const runDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tlc-fs-errors-near-"));
  const framesDir = path.join(runDir, "frames");
  const manifestPath = path.join(runDir, "manifest.jsonl");
  await fsp.mkdir(framesDir, { recursive: true });
  const originalReaddir = fsp.readdir;
  const originalReadFile = fsp.readFile;

  try {
    mock.method(fsp, "readdir", async (target) => {
      if (target === framesDir) return [createFrameDirent("frame-0001.png")];
      return originalReaddir(target);
    });
    mock.method(fsp, "readFile", async (target, encoding) => {
      if (target === manifestPath) {
        const error = new Error("permission denied reading manifest");
        error.code = "EACCES";
        throw error;
      }
      return originalReadFile(target, encoding);
    });

    await assert.rejects(
      () => commandPeek({ runDir, options: { near: "2026-05-09T12:00:00Z" } }),
      /permission denied reading manifest|EACCES/
    );
  } finally {
    mock.restoreAll();
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});
