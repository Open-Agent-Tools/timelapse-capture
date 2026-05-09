import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  CANONICAL_STATES,
  migrateLegacyState,
  validateMP4
} from "../src/timelapse-capture.mjs";

const require = createRequire(import.meta.url);
const nodeFs = require("fs");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI = path.join(__dirname, "..", "src", "timelapse-capture.mjs");

test("CANONICAL_STATES exposes the unified vocabulary", () => {
  assert.deepEqual(
    [...CANONICAL_STATES].sort(),
    ["completed", "failed", "render_failed", "rendered", "rendering", "running", "starting"]
  );
});

test("migrateLegacyState rewrites legacy done to completed and leaves canonical states untouched", () => {
  assert.equal(migrateLegacyState("done"), "completed");
  for (const state of CANONICAL_STATES) {
    assert.equal(migrateLegacyState(state), state);
  }
});

test("importing the canonical CLI module has no dispatcher side effects", () => {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(CLI)});`],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("status command migrates legacy done to completed without rewriting status.json", async () => {
  const runDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tlc-status-vocab-"));
  try {
    const statusPath = path.join(runDir, "status.json");
    const configPath = path.join(runDir, "config.json");
    const legacyStatus = {
      state: "done",
      pid: 1234,
      startedAt: "2026-04-30T14:00:00.000Z",
      updatedAt: "2026-04-30T15:00:00.000Z",
      framesAttempted: 5,
      framesCaptured: 5,
      framesFailed: 0,
      latestFrame: null
    };
    await fsp.writeFile(statusPath, `${JSON.stringify(legacyStatus, null, 2)}\n`);
    await fsp.writeFile(configPath, JSON.stringify({ expectedFrames: 5 }));

    const before = await fsp.readFile(statusPath, "utf8");
    const result = spawnSync(process.execPath, [CLI, "status", runDir, "--json"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status.state, "completed");
    assert.deepEqual(payload.status.frames, {
      captured: 5,
      failed: 0,
      totalExpected: 5
    });
    assert.equal(Object.hasOwn(payload.status, "framesCaptured"), false);
    assert.equal(Object.hasOwn(payload.status, "framesFailed"), false);

    const after = await fsp.readFile(statusPath, "utf8");
    assert.equal(before, after, "status.json must not be rewritten by a read-only status migration");
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test("source files do not write the legacy done state", async () => {
  const repoRoot = path.resolve(__dirname, "..");
  const targets = [
    "src/timelapse-capture.mjs",
    "src/doctor.mjs",
    "test/canonical-cli.test.mjs",
    "test/check-script.test.js",
    "test/doctor.test.mjs",
    "README.md",
    "skill/SKILL.md",
    "docs/PRD.md",
    "package.json"
  ];
  const writePatterns = [
    /state:\s*['"]done['"]/,
    /state\s*===\s*['"]done['"]/,
    /['"]state['"]\s*:\s*['"]done['"]/
  ];

  for (const relative of targets) {
    const absolute = path.join(repoRoot, relative);
    const content = await fsp.readFile(absolute, "utf8").catch((error) => {
      if (error?.code === "ENOENT") return "";
      throw error;
    });
    if (!content) continue;
    for (const pattern of writePatterns) {
      const match = content.match(pattern);
      assert.equal(match, null, `Forbidden legacy "done" state write in ${relative}: ${match?.[0] ?? ""}`);
    }
  }
});

test("validateMP4 surfaces non-ENOENT stat errors in validation output", async () => {
  const runDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tlc-status-vocab-mp4-"));
  const outputPath = path.join(runDir, "output.mp4");
  const originalStatSync = nodeFs.statSync;

  try {
    await fsp.writeFile(outputPath, Buffer.from("not a video"));
    nodeFs.statSync = (target) => {
      if (target === outputPath) {
        const error = new Error("permission denied reading output.mp4");
        error.code = "EACCES";
        throw error;
      }
      return originalStatSync(target);
    };

    const result = validateMP4(outputPath);
    assert.equal(result.exists, true);
    assert.equal(result.error, "Failed to stat output file: permission denied reading output.mp4");
    assert.notEqual(result.error, "Output file is empty");
  } finally {
    nodeFs.statSync = originalStatSync;
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test("validateMP4 surfaces ENOENT stat errors instead of reporting an empty output file", async () => {
  const runDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tlc-status-vocab-mp4-enoent-"));
  const outputPath = path.join(runDir, "output.mp4");
  const originalStatSync = nodeFs.statSync;

  try {
    await fsp.writeFile(outputPath, Buffer.from("not a video"));
    nodeFs.statSync = (target) => {
      if (target === outputPath) {
        const error = new Error("output file vanished before stat");
        error.code = "ENOENT";
        throw error;
      }
      return originalStatSync(target);
    };

    const result = validateMP4(outputPath);
    assert.equal(result.exists, true);
    assert.equal(result.error, "Failed to stat output file: output file vanished before stat");
  } finally {
    nodeFs.statSync = originalStatSync;
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});
