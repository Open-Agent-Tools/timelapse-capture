import assert from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CANONICAL_STATES,
  commandStatus,
  normalizeStatusState
} from "../src/timelapse-capture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const legacyCompletedState = ["d", "one"].join("");

test("canonical capture and render states are exported in one vocabulary", () => {
  assert.deepEqual(CANONICAL_STATES, [
    "starting",
    "running",
    "completed",
    "failed",
    "rendering",
    "rendered",
    "render_failed"
  ]);

  for (const state of CANONICAL_STATES) {
    assert.equal(normalizeStatusState(state), state);
  }
});

test("legacy completed state is migrated when reading status without rewriting the file", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "timelapse-status-vocab-"));
  const statusPath = path.join(runDir, "status.json");
  const originalStatus = {
    runDir,
    state: legacyCompletedState,
    frameCount: 2,
    failedFrameCount: 0,
    startedAt: "2026-05-07T00:00:00.000Z",
    lastUpdatedAt: "2026-05-07T00:00:01.000Z"
  };
  const originalText = `${JSON.stringify(originalStatus, null, 2)}\n`;

  try {
    await fs.mkdir(path.join(runDir, "frames"));
    await fs.writeFile(statusPath, originalText);

    const status = await commandStatus({ runDir });
    assert.equal(status.state, "completed");
    assert.equal(await fs.readFile(statusPath, "utf8"), originalText);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("source and fixtures do not write the legacy completed state", async () => {
  const scanTargets = ["src", "test", "README.md", "skill", "docs", "package.json"];
  const forbidden = [
    /state:\s*["']d(?=one["'])one["']/,
    /state\s*===\s*["']d(?=one["'])one["']/,
    /["']d(?=one["'])one["']/
  ];
  const allowList = new Set(["test/status-vocabulary.test.mjs"]);
  const hits = [];

  async function scanFile(filePath) {
    const relativePath = path.relative(repoRoot, filePath);
    if (allowList.has(relativePath)) return;
    const text = await fs.readFile(filePath, "utf8");
    for (const pattern of forbidden) {
      if (pattern.test(text)) {
        hits.push(relativePath);
        return;
      }
    }
  }

  async function scanPath(target) {
    const absolute = path.join(repoRoot, target);
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat) return;
    if (stat.isFile()) {
      await scanFile(absolute);
      return;
    }
    const entries = await fs.readdir(absolute, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      await scanPath(path.join(target, entry.name));
    }
  }

  for (const target of scanTargets) {
    await scanPath(target);
  }

  assert.deepEqual(hits, []);
});
