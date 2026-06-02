import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { waitForTerminalStatus } from "./helpers/status-waiters.mjs";

import { commandStart } from "../src/timelapse-capture.mjs";

const TARGET = "http://example.test/";
const VIEWPORT = { width: 1440, height: 900 };

async function runSimulated(frames, extraEnv = {}) {
  const runDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "tlc-record-helpers-"),
  );
  const savedEnv = {};
  const envOverrides = {
    TIMELAPSE_SIMULATE_FRAMES: String(frames),
    ...extraEnv,
  };
  for (const [k, v] of Object.entries(envOverrides)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    await commandStart({
      target: TARGET,
      options: { out: runDir, interval: 0, "no-render": true },
    });
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  await waitForTerminalStatus(runDir, { expectedAttempts: frames });
  return runDir;
}

async function readManifest(runDir) {
  const raw = await fs.readFile(path.join(runDir, "manifest.jsonl"), "utf8");
  return raw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test("recordCapturedFrame: manifest records have required fields for all captured frames", async () => {
  const runDir = await runSimulated(3);
  try {
    const records = await readManifest(runDir);
    assert.equal(records.length, 3);
    for (const [i, r] of records.entries()) {
      assert.equal(r.status, "captured", `record ${i} status`);
      assert.equal(r.index, i + 1, `record ${i} index`);
      assert.ok(
        typeof r.capturedAt === "string",
        `record ${i} capturedAt is string`,
      );
      assert.ok(
        typeof r.scheduledAt === "string",
        `record ${i} scheduledAt is string`,
      );
      assert.ok(typeof r.path === "string", `record ${i} path is string`);
      assert.equal(
        r.path,
        `frames/frame-${String(i + 1).padStart(4, "0")}.jpeg`,
        `record ${i} path is run-relative with forward slashes`,
      );
      assert.equal(r.url, TARGET, `record ${i} url`);
      assert.ok("title" in r, `record ${i} has title field`);
      assert.equal(r.title, null, `record ${i} title is null for simulated`);
      assert.deepEqual(r.viewport, VIEWPORT, `record ${i} viewport`);
      assert.equal(r.error, null, `record ${i} error is null`);
    }
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("recordCapturedFrame: latest-frame.json and latest.jpeg are written after each frame", async () => {
  const runDir = await runSimulated(2);
  try {
    const latestFrame = JSON.parse(
      await fs.readFile(path.join(runDir, "latest-frame.json"), "utf8"),
    );
    assert.equal(latestFrame.index, 2);
    assert.equal(latestFrame.status, "captured");
    assert.equal(latestFrame.path, "frames/frame-0002.jpeg");
    const stat = await fs.stat(path.join(runDir, "latest.jpeg"));
    assert.ok(stat.size > 0, "latest.jpeg exists and is non-empty");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("status.json latestFrame field is run-relative", async () => {
  const runDir = await runSimulated(2);
  try {
    const status = JSON.parse(
      await fs.readFile(path.join(runDir, "status.json"), "utf8"),
    );
    assert.equal(status.latestFrame, "frames/frame-0002.jpeg");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("recordFailedFrame: failure record has required fields and state is updated", async () => {
  const runDir = await runSimulated(3, {
    TIMELAPSE_SIMULATE_FRAME_FAILURE: "1",
  });
  try {
    const records = await readManifest(runDir);
    assert.equal(records.length, 3);

    const failedRecord = records.find((r) => r.status === "failed");
    assert.ok(failedRecord, "failure record exists");
    assert.equal(failedRecord.index, 2);
    assert.equal(failedRecord.capturedAt, null);
    assert.equal(failedRecord.path, null);
    assert.equal(failedRecord.url, TARGET);
    assert.ok("title" in failedRecord, "failure record has title field");
    assert.equal(failedRecord.title, null);
    assert.deepEqual(failedRecord.viewport, VIEWPORT);
    assert.equal(failedRecord.error, "simulated failure");

    const captured = records.filter((r) => r.status === "captured");
    assert.equal(captured.length, 2, "2 captured frames despite 1 failure");
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("recordCapturedFrame: state.frameCount increments correctly across frames", async () => {
  const runDir = await runSimulated(3);
  try {
    const status = JSON.parse(
      await fs.readFile(path.join(runDir, "status.json"), "utf8"),
    );
    assert.equal(status.frames.captured, 3);
    assert.equal(status.frames.failed, 0);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});
