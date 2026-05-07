import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { commandPeek } from "../src/timelapse-capture.mjs";

test("commandPeek finds closest frame by ISO timestamp", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "peek-test-"));
  const framesDir = path.join(tmpDir, "frames");
  await fs.mkdir(framesDir);
  
  const manifestPath = path.join(tmpDir, "manifest.jsonl");
  
  const t1 = "2026-05-07T10:00:00Z";
  const t2 = "2026-05-07T10:10:00Z";
  const t3 = "2026-05-07T10:20:00Z";
  
  await fs.writeFile(path.join(framesDir, "frame-0001.png"), "f1");
  await fs.writeFile(path.join(framesDir, "frame-0002.png"), "f2");
  await fs.writeFile(path.join(framesDir, "frame-0003.png"), "f3");
  
  const manifest = [
    { index: 1, capturedAt: t1, path: path.join(framesDir, "frame-0001.png"), status: "captured" },
    { index: 2, capturedAt: t2, path: path.join(framesDir, "frame-0002.png"), status: "captured" },
    { index: 3, capturedAt: t3, path: path.join(framesDir, "frame-0003.png"), status: "captured" },
  ].map(r => JSON.stringify(r)).join("\n");
  
  await fs.writeFile(manifestPath, manifest);
  
  // Test 1: Near t1
  const r1 = await commandPeek({ runDir: tmpDir, options: { near: "2026-05-07T10:01:00Z" } });
  assert.ok(r1.path.endsWith("frame-0001.png"), `Expected frame-0001, got ${r1.path}`);
  
  // Test 2: Near t2
  const r2 = await commandPeek({ runDir: tmpDir, options: { near: "2026-05-07T10:09:00Z" } });
  assert.ok(r2.path.endsWith("frame-0002.png"), `Expected frame-0002, got ${r2.path}`);
  
  // Test 3: Near t3
  const r3 = await commandPeek({ runDir: tmpDir, options: { near: "2026-05-07T10:25:00Z" } });
  assert.ok(r3.path.endsWith("frame-0003.png"), `Expected frame-0003, got ${r3.path}`);

  await fs.rm(tmpDir, { recursive: true });
});
