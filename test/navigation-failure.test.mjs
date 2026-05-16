import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runCli } from "./helpers/cli.mjs";
import { waitForFailedStatus } from "./helpers/status-waiters.mjs";

test("initial navigation failure should leave diagnostic manifest record", async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "tlc-repro-298-"));
  try {
    // We use a port that is unlikely to be open to trigger navigation failure
    // but pass initial validation.
    const result = runCli(
      [
        "start",
        "http://127.0.0.1:1",
        "--duration",
        "1s",
        "--interval",
        "1s",
        "--out",
        outDir,
        "--json",
      ],
      {
        // We don't want to use simulation here, we want REAL playwright navigation failure
        // unless it's too slow. Let's try with a simulation hook first if we can add one.
        // Actually, let's try a real failure first.
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const startPayload = JSON.parse(result.stdout);
    const runDir = startPayload.runDir;

    // Cold Playwright/Chromium launch can take >5s; allow headroom.
    const status = await waitForFailedStatus(runDir, { timeoutMs: 30_000 });
    assert.equal(status.state, "failed");
    assert.match(status.error, /navigation failed/);

    const manifestPath = path.join(runDir, "manifest.jsonl");
    const manifestExists = await fs
      .access(manifestPath)
      .then(() => true)
      .catch(() => false);

    if (!manifestExists) {
      assert.fail(
        "manifest.jsonl does not exist after initial navigation failure",
      );
    }

    const manifestLines = (await fs.readFile(manifestPath, "utf8"))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    assert.ok(
      manifestLines.length > 0,
      "Manifest should have at least one record",
    );
    assert.equal(manifestLines[0].status, "failed");
    assert.match(manifestLines[0].error, /navigation failed/);
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test("initial navigation failure simulation (playwright backend) should leave diagnostic manifest record", async () => {
  const outDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "tlc-repro-298-sim-pw-"),
  );
  try {
    const result = runCli(
      [
        "start",
        "http://example.com",
        "--duration",
        "1s",
        "--interval",
        "1s",
        "--out",
        outDir,
        "--json",
      ],
      {
        TIMELAPSE_SIMULATE_INITIAL_NAVIGATION_FAILURE: "1",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const startPayload = JSON.parse(result.stdout);
    const runDir = startPayload.runDir;

    // Cold Playwright/Chromium launch can take >5s even when the navigation
    // failure is simulated, since the throw happens after newPage().
    const status = await waitForFailedStatus(runDir, { timeoutMs: 30_000 });
    assert.equal(status.state, "failed");
    assert.match(status.error, /simulated initial navigation failure/);

    const manifestPath = path.join(runDir, "manifest.jsonl");
    const manifestLines = (await fs.readFile(manifestPath, "utf8"))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    assert.ok(manifestLines.length > 0);
    assert.equal(manifestLines[0].status, "failed");
    assert.match(
      manifestLines[0].error,
      /simulated initial navigation failure/,
    );
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test("initial navigation failure simulation (simulated backend) should leave diagnostic manifest record", async () => {
  const outDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "tlc-repro-298-sim-sim-"),
  );
  try {
    const result = runCli(
      [
        "start",
        "http://example.com",
        "--duration",
        "1s",
        "--interval",
        "1s",
        "--out",
        outDir,
        "--json",
      ],
      {
        TIMELAPSE_SIMULATE_FRAMES: "1",
        TIMELAPSE_SIMULATE_INITIAL_NAVIGATION_FAILURE: "1",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const startPayload = JSON.parse(result.stdout);
    const runDir = startPayload.runDir;

    const status = await waitForFailedStatus(runDir);
    assert.equal(status.state, "failed");
    assert.match(status.error, /simulated initial navigation failure/);

    const manifestPath = path.join(runDir, "manifest.jsonl");
    const manifestLines = (await fs.readFile(manifestPath, "utf8"))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    assert.ok(manifestLines.length > 0);
    assert.equal(manifestLines[0].status, "failed");
    assert.match(
      manifestLines[0].error,
      /simulated initial navigation failure/,
    );
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});
