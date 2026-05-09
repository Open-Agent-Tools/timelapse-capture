import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { commandCleanup, commandPeek, commandStatus, validateMP4 } from "../src/timelapse-capture.mjs";

const FRAME_PNG_1x1 = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000b49444154789c636060000000020001d75edeb0000000049454e44ae426082",
  "hex"
);

async function makeRun({ frameCount = 1 } = {}) {
  const runDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tlc-fs-errors-"));
  const framesDir = path.join(runDir, "frames");
  await fsp.mkdir(framesDir);

  const captured = [];
  for (let index = 1; index <= frameCount; index += 1) {
    const relative = path.join("frames", `frame-${String(index).padStart(6, "0")}.png`);
    const capturedAt = new Date(Date.UTC(2026, 0, 1, 12, index, 0)).toISOString();
    await fsp.writeFile(path.join(runDir, relative), FRAME_PNG_1x1);
    captured.push({
      index,
      scheduledAt: capturedAt,
      capturedAt,
      path: relative,
      status: "captured",
      url: "http://example.test/",
      title: "fixture",
      viewport: { width: 1280, height: 720 },
      error: null
    });
  }

  await fsp.writeFile(path.join(runDir, "config.json"), JSON.stringify({ targetFrames: frameCount }, null, 2));
  await fsp.writeFile(
    path.join(runDir, "status.json"),
    JSON.stringify({
      state: "completed",
      startedAt: captured[0]?.capturedAt ?? new Date().toISOString(),
      updatedAt: captured.at(-1)?.capturedAt ?? new Date().toISOString(),
      framesAttempted: frameCount,
      frames: { captured: frameCount, failed: 0, totalExpected: frameCount },
      latestFrame: captured.at(-1) ?? null
    }, null, 2)
  );
  await fsp.writeFile(
    path.join(runDir, "manifest.jsonl"),
    captured.map((record) => JSON.stringify(record)).join("\n") + "\n"
  );

  return { runDir, framesDir, captured };
}

function fsError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

test("status treats a missing frames directory as zero disk usage", async () => {
  const { runDir, framesDir } = await makeRun();
  try {
    await fsp.rm(framesDir, { recursive: true, force: true });

    const result = await commandStatus({ runDir });

    assert.equal(result.framesDiskUsageBytes, 0);
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test("status propagates unexpected frames directory read failures", async () => {
  const { runDir, framesDir } = await makeRun();
  const originalReaddir = fsp.readdir;
  try {
    fsp.readdir = async (target, options) => {
      if (target === framesDir && options?.withFileTypes) {
        throw fsError("EACCES", "frames directory permission denied");
      }
      return originalReaddir(target, options);
    };

    await assert.rejects(
      commandStatus({ runDir }),
      /frames directory permission denied/
    );
  } finally {
    fsp.readdir = originalReaddir;
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test("peek treats a missing manifest as missing captured timestamps", async () => {
  const { runDir, captured } = await makeRun();
  try {
    await fsp.rm(path.join(runDir, "manifest.jsonl"));

    await assert.rejects(
      commandPeek({ runDir, options: { near: captured[0].capturedAt } }),
      /No captured frame timestamps are available for --near\./
    );
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test("peek propagates unexpected manifest read failures", async () => {
  const { runDir, captured } = await makeRun();
  const manifestPath = path.join(runDir, "manifest.jsonl");
  const originalReadFile = fsp.readFile;
  try {
    fsp.readFile = async (target, options) => {
      if (target === manifestPath) {
        throw fsError("EIO", "manifest storage failed");
      }
      return originalReadFile(target, options);
    };

    await assert.rejects(
      commandPeek({ runDir, options: { near: captured[0].capturedAt } }),
      /manifest storage failed/
    );
  } finally {
    fsp.readFile = originalReadFile;
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test("peek propagates unexpected frames directory read failures", async () => {
  const { runDir, framesDir } = await makeRun();
  const originalReaddir = fsp.readdir;
  try {
    fsp.readdir = async (target, options) => {
      if (target === framesDir && options?.withFileTypes) {
        throw fsError("EACCES", "frames listing denied");
      }
      return originalReaddir(target, options);
    };

    await assert.rejects(
      commandPeek({ runDir, options: { latest: true } }),
      /frames listing denied/
    );
  } finally {
    fsp.readdir = originalReaddir;
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test("validateMP4 reports unexpected stat failures instead of calling the file empty", async () => {
  const outputPath = path.join(os.tmpdir(), "tlc-output-permission-denied.mp4");
  const originalExistsSync = fs.existsSync;
  const originalStatSync = fs.statSync;
  try {
    fs.existsSync = (target) => target === outputPath || originalExistsSync(target);
    fs.statSync = (target, options) => {
      if (target === outputPath) {
        throw fsError("EACCES", "output size permission denied");
      }
      return originalStatSync(target, options);
    };

    const result = validateMP4(outputPath);

    assert.equal(result.exists, true);
    assert.equal(result.bytes, 0);
    assert.match(result.error, /output size permission denied/);
    assert.doesNotMatch(result.error, /empty/);
  } finally {
    fs.existsSync = originalExistsSync;
    fs.statSync = originalStatSync;
  }
});

test("cleanup still treats a missing run directory as not found", async () => {
  const missingRunDir = path.join(os.tmpdir(), `tlc-missing-${process.pid}-${Date.now()}`);

  await assert.rejects(
    commandCleanup({ runDir: missingRunDir, options: { force: true } }),
    /Run directory not found/
  );
});

test("cleanup propagates unexpected run directory stat failures", async () => {
  const runDir = path.join(os.tmpdir(), `tlc-stat-denied-${process.pid}-${Date.now()}`);
  const originalStat = fsp.stat;
  try {
    fsp.stat = async (target, options) => {
      if (target === runDir) {
        throw fsError("EACCES", "run directory stat denied");
      }
      return originalStat(target, options);
    };

    await assert.rejects(
      commandCleanup({ runDir, options: { force: true } }),
      /run directory stat denied/
    );
  } finally {
    fsp.stat = originalStat;
  }
});
