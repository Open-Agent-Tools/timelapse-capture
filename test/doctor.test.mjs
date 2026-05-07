import assert from "node:assert";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkBinary,
  checkNode,
  commandDoctor,
  formatDoctorHuman,
  runAllChecks
} from "../src/timelapse-capture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, "..", "src", "timelapse-capture.mjs");

test("checkNode passes for supported Node versions", async () => {
  const result = await checkNode({ version: "20.1.0" });
  assert.equal(result.name, "node");
  assert.equal(result.status, "pass");
  assert.equal(result.details.minimumVersion, "20.0.0");
});

test("checkNode fails with fix instructions for old Node versions", async () => {
  const result = await checkNode({ version: "18.19.0" });
  assert.equal(result.status, "fail");
  assert.match(result.error, /Node\.js 20 or newer/);
  assert.match(result.fix, /Install Node\.js 20/);
});

test("checkBinary reports parsed version output", async () => {
  const result = await checkBinary("ffmpeg", {
    execFileSync() {
      return "ffmpeg version 6.1 Copyright";
    }
  });
  assert.equal(result.status, "pass");
  assert.equal(result.details.version, "6.1");
});

test("checkBinary reports missing binaries with actionable fixes", async () => {
  const result = await checkBinary("ffprobe", {
    execFileSync() {
      const error = new Error("spawn ENOENT");
      error.code = "ENOENT";
      throw error;
    }
  });
  assert.equal(result.status, "fail");
  assert.match(result.error, /ffprobe was not found/);
  assert.match(result.fix, /Install FFmpeg/);
});

test("runAllChecks returns summary counts and exit code", async () => {
  const result = await runAllChecks({
    checks: [
      async () => ({ name: "one", status: "pass", message: "ok", fix: null, details: {} }),
      async () => ({ name: "two", status: "fail", message: "bad", error: "bad", fix: "fix it", details: {} })
    ]
  });
  assert.equal(result.ok, false);
  assert.equal(result.summary.pass, 1);
  assert.equal(result.summary.fail, 1);
  assert.equal(result.exitCode, 1);
});

test("commandDoctor JSON result is structured for agents", async () => {
  const result = await commandDoctor({
    checks: [
      async () => ({
        name: "node",
        status: "pass",
        message: "Node.js 25.0.0",
        fix: null,
        details: { version: "25.0.0" }
      })
    ]
  });
  assert.deepEqual(Object.keys(result).sort(), ["checks", "exitCode", "ok", "summary"]);
  assert.equal(result.checks[0].name, "node");
  assert.equal(result.exitCode, 0);
});

test("formatDoctorHuman prints pass/fail lines with fixes", () => {
  const output = formatDoctorHuman({
    checks: [
      { name: "node", status: "pass", message: "Node.js 25.0.0" },
      {
        name: "ffmpeg",
        status: "fail",
        message: "ffmpeg unavailable",
        fix: "Install FFmpeg."
      }
    ],
    summary: { pass: 1, fail: 1, total: 2 }
  });
  assert.match(output, /\[PASS\] node: Node\.js 25\.0\.0/);
  assert.match(output, /\[FAIL\] ffmpeg: ffmpeg unavailable/);
  assert.match(output, /fix: Install FFmpeg\./);
  assert.match(output, /summary: 1 passed, 1 failed, 2 total/);
});

test("doctor --json emits parseable JSON and exits non-zero when a dependency is missing", () => {
  const result = spawnSync(process.execPath, [CLI_PATH, "doctor", "--json"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: ""
    }
  });
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.ok(payload.checks.some((c) => c.name === "ffmpeg" && c.status === "fail"));
});
