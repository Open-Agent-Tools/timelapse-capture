import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, "..", "src", "timelapse-capture.mjs");

test("peek --near finds closest frame by ISO timestamp", async () => {
  const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "near-test-"));
  const runDir = path.join(tmpdir, "test-run");
  const framesDir = path.join(runDir, "frames");
  await fs.mkdir(framesDir, { recursive: true });

  const t1 = "2026-05-07T10:00:00Z";
  const t2 = "2026-05-07T10:10:00Z";
  const t3 = "2026-05-07T10:20:00Z";

  const frames = [
    { index: 1, capturedAt: t1, path: "frame-0001.png" },
    { index: 2, capturedAt: t2, path: "frame-0002.png" },
    { index: 3, capturedAt: t3, path: "frame-0003.png" },
  ];

  const manifestPath = path.join(runDir, "manifest.jsonl");
  for (const f of frames) {
    const framePath = path.join(framesDir, f.path);
    await fs.writeFile(framePath, "fake content");
    const record = {
      index: f.index,
      capturedAt: f.capturedAt,
      path: framePath,
      status: "captured"
    };
    await fs.appendFile(manifestPath, JSON.stringify(record) + "\n");
  }

  // Exact match
  let result = spawnSync(process.execPath, [CLI_PATH, "peek", runDir, "--near", t2, "--json"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  let data = JSON.parse(result.stdout);
  assert.ok(data.path.endsWith("frame-0002.png"));

  // Near match (closer to t1)
  result = spawnSync(process.execPath, [CLI_PATH, "peek", runDir, "--near", "2026-05-07T10:04:00Z", "--json"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  data = JSON.parse(result.stdout);
  assert.ok(data.path.endsWith("frame-0001.png"));

  // Near match (closer to t2)
  result = spawnSync(process.execPath, [CLI_PATH, "peek", runDir, "--near", "2026-05-07T10:06:00Z", "--json"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  data = JSON.parse(result.stdout);
  assert.ok(data.path.endsWith("frame-0002.png"));

  // Cleanup
  await fs.rm(tmpdir, { recursive: true, force: true });
});
