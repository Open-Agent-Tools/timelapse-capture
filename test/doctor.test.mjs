import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_CHECKS,
  checkBinary,
  checkChromium,
  checkNode,
  checkPlaywright,
  commandDoctor,
  formatDoctorHuman,
  runAllChecks
} from "../src/doctor.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI = path.join(__dirname, "..", "src", "timelapse-capture.mjs");

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
  assert.match(result.message, /ffprobe is missing from PATH/);
  assert.match(result.message, /tests and captures that require ffprobe should be skipped/);
});

test("DEFAULT_CHECKS locks the canonical doctor check order", () => {
  assert.deepEqual(
    DEFAULT_CHECKS.map((fn) => fn.name),
    ["checkNode", "checkPlaywright", "checkChromium", "checkFfmpeg", "checkFfprobe"]
  );
});

test("checkPlaywright passes when the package can be required", async () => {
  let factoryCalls = 0;
  let resolveCalls = 0;
  const stub = (specifier) => {
    if (specifier === "playwright") {
      factoryCalls += 1;
      return { sentinel: true };
    }
    throw new Error(`unexpected specifier ${specifier}`);
  };
  stub.resolve = (specifier) => {
    if (specifier === "playwright") {
      resolveCalls += 1;
      return "/fake/playwright";
    }
    throw new Error(`unexpected resolve specifier ${specifier}`);
  };

  const result = await checkPlaywright({ requireFn: stub });

  assert.equal(result.name, "playwright");
  assert.equal(result.status, "pass");
  assert.equal(result.details.resolvedPath, "/fake/playwright");
  assert.equal(factoryCalls, 1);
  assert.equal(resolveCalls, 1);
});

test("checkChromium reports browser close failures", async () => {
  const result = await checkChromium({
    requireFn() {
      return {
        chromium: {
          async launch() {
            return {
              async close() {
                throw new Error("close failed");
              }
            };
          }
        }
      };
    }
  });

  assert.equal(result.status, "fail");
  assert.match(result.message, /could not close cleanly/);
  assert.match(result.error, /close failed/);
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

test("commandDoctor returns the structured agent payload", async () => {
  const result = await commandDoctor({
    checks: [
      async () => ({
        name: "node",
        status: "pass",
        message: "Node.js 25.0.0",
        details: { version: "25.0.0" }
      })
    ]
  });

  assert.deepEqual(Object.keys(result).sort(), ["checks", "exitCode", "ok", "summary"]);
  assert.equal(result.checks[0].name, "node");
  assert.equal(result.exitCode, 0);
  assert.equal(result.checks[0].details.version, "25.0.0");
  assert.equal(result.checks[0].error, null);
  assert.equal(result.checks[0].fix, null);
});

test("commandDoctor normalizes custom check payloads to the stable contract", async () => {
  const result = await commandDoctor({
    checks: [
      async () => ({ name: "custom-pass", status: "pass", message: "ok" }),
      async () => ({ name: "custom-fail", status: "fail", message: "broken", error: "broken", details: { reason: "bad" } })
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.summary.pass, 1);
  assert.equal(result.summary.fail, 1);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.checks[0], {
    name: "custom-pass",
    status: "pass",
    message: "ok",
    details: {},
    error: null,
    fix: null
  });
  assert.deepEqual(result.checks[1], {
    name: "custom-fail",
    status: "fail",
    message: "broken",
    details: { reason: "bad" },
    error: "broken",
    fix: null
  });
});

test("checkPlaywright reports missing dependency with manual fix guidance", async () => {
  const error = new Error("Cannot find module 'playwright'");
  const calls = [];
  const result = await checkPlaywright({
    requireFn: Object.assign(
      () => {
        calls.push("require-playwright");
        throw error;
      },
      {
        resolve() {
          calls.push("resolve-playwright");
          throw error;
        }
      }
    )
  });

  assert.equal(result.status, "fail");
  assert.equal(result.name, "playwright");
  assert.equal(result.error, error.message);
  assert.equal(result.fix, "Run npm install in this project. Do not rely on doctor to install dependencies.");
  assert.equal(calls.includes("resolve-playwright"), true);
  assert.equal(result.message, "Playwright package cannot be imported");
});

test("checkBinary attempts only version check command for missing ffmpeg/ffprobe", async () => {
  const execCalls = [];
  const result = await checkBinary("ffmpeg", {
    execFileSync(binary, args) {
      execCalls.push({ binary, args });
      const error = new Error("missing");
      error.code = "ENOENT";
      throw error;
    }
  });

  assert.equal(result.status, "fail");
  assert.equal(execCalls.length, 1);
  assert.deepEqual(execCalls[0], { binary: "ffmpeg", args: ["-version"] });
  assert.equal(result.fix, "Install FFmpeg and ensure ffmpeg is available on PATH.");
  assert.match(result.message, /missing from PATH/);
});

test("formatDoctorHuman prints pass/fail lines with fixes", () => {
  const output = formatDoctorHuman({
    checks: [
      { name: "node", status: "pass", message: "Node.js 25.0.0" },
      { name: "ffmpeg", status: "fail", message: "ffmpeg unavailable", fix: "Install FFmpeg." }
    ],
    summary: { pass: 1, fail: 1, total: 2 }
  });

  assert.match(output, /\[PASS\] node: Node\.js 25\.0\.0/);
  assert.match(output, /\[FAIL\] ffmpeg: ffmpeg unavailable/);
  assert.match(output, /fix: Install FFmpeg\./);
  assert.match(output, /summary: 1 passed, 1 failed, 2 total/);
});

test("runAllChecks normalizes a check returning an empty object", async () => {
  const result = await runAllChecks({ checks: [async () => ({})] });
  assert.equal(result.checks[0].name, "unknown");
  assert.equal(result.checks[0].status, "fail");
  assert.equal(typeof result.checks[0].message, "string");
  assert.ok(result.checks[0].message.length > 0);
  assert.equal(result.summary.pass, 0);
  assert.equal(result.summary.fail, 1);
  assert.equal(result.summary.total, 1);
  assert.equal(result.summary.pass + result.summary.fail, result.summary.total);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
});

test("runAllChecks coerces unknown status values to fail", async () => {
  const result = await runAllChecks({
    checks: [async () => ({ name: "x", status: "weird", message: "hi" })]
  });
  assert.equal(result.checks[0].status, "fail");
  assert.equal(result.summary.fail, 1);
  assert.equal(result.summary.pass, 0);
  assert.equal(result.exitCode, 1);
});

test("formatDoctorHuman never prints \"undefined\" for malformed checks", async () => {
  const result = await runAllChecks({ checks: [async () => ({})] });
  const output = formatDoctorHuman(result);
  assert.ok(output.includes("[FAIL] unknown:"), `Expected "[FAIL] unknown:" in output: ${output}`);
  assert.ok(!output.includes("undefined"), `Expected no "undefined" in output: ${output}`);
});

test("doctor --json emits parseable JSON and exits non-zero when a dependency is missing", () => {
  const result = spawnSync(process.execPath, [CLI, "doctor", "--json"], {
    encoding: "utf8",
    env: { ...process.env, PATH: "" }
  });

  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.ok(payload.checks.some((check) => check.name === "ffmpeg" && check.status === "fail"));
  assert.equal(result.stderr, "");
  assert.equal(payload.exitCode, result.status);
});

test("doctor without --json emits human-readable output and summary", () => {
  const result = spawnSync(process.execPath, [CLI, "doctor"], {
    encoding: "utf8",
    env: { ...process.env, PATH: "" }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /\[PASS\] node:/);
  assert.match(result.stdout, /\[FAIL\]/);
  assert.match(result.stdout, /summary: \d+ passed, \d+ failed, \d+ total/);
  assert.equal(result.stderr, "");
  assert.notEqual(result.stdout.trim()[0], "{");
});
