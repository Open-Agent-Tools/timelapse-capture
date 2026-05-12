import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { cleanupFrames, __test__ } from "../src/timelapse-capture.mjs";

const { countFrameFiles, listFrameFiles, listFrameFilesSync } = __test__;

test("reproduce inconsistency in frame file extension filtering", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "timelapse-repro-311-"));
  const framesDir = path.join(tmpDir, "frames");
  fs.mkdirSync(framesDir, { recursive: true });

  // Create a mix of files
  fs.writeFileSync(path.join(framesDir, "frame-0001.png"), "");
  fs.writeFileSync(path.join(framesDir, "frame-0002.jpg"), "");
  fs.writeFileSync(path.join(framesDir, "frame-0003.jpeg"), "");
  fs.writeFileSync(path.join(framesDir, "frame-0004.PNG"), "");
  fs.writeFileSync(path.join(framesDir, "not-a-frame.txt"), "");

  await t.test(
    "countFrameFiles includes png, jpg, jpeg (case-insensitive)",
    () => {
      const count = countFrameFiles(framesDir);
      assert.strictEqual(
        count,
        4,
        "countFrameFiles should count all frame types",
      );
    },
  );

  await t.test(
    "listFrameFiles includes png, jpg, jpeg (case-insensitive)",
    async () => {
      const files = await listFrameFiles(tmpDir);
      assert.ok(files.includes("frame-0001.png"));
      assert.ok(files.includes("frame-0002.jpg"));
      assert.ok(files.includes("frame-0003.jpeg"));
      assert.ok(files.includes("frame-0004.PNG"));
      assert.strictEqual(
        files.length,
        4,
        "listFrameFiles should find all 4 frames",
      );
    },
  );

  await t.test(
    "listFrameFilesSync includes png, jpg, jpeg (case-insensitive)",
    () => {
      const files = listFrameFilesSync(framesDir);
      assert.ok(files.includes("frame-0001.png"));
      assert.ok(files.includes("frame-0002.jpg"));
      assert.ok(files.includes("frame-0003.jpeg"));
      assert.ok(files.includes("frame-0004.PNG"));
      assert.strictEqual(
        files.length,
        4,
        "listFrameFilesSync should find all 4 frames",
      );
    },
  );

  await t.test(
    "cleanupFrames includes png, jpg, jpeg (case-insensitive)",
    () => {
      const result = cleanupFrames(tmpDir);
      assert.strictEqual(
        result.removed,
        4,
        "cleanupFrames should remove all 4 frames",
      );
    },
  );

  await t.test("copySamplesSync preserves original file extensions", () => {
    const tmpDir2 = fs.mkdtempSync(
      path.join(os.tmpdir(), "timelapse-repro-311-samples-"),
    );
    const framesDir2 = path.join(tmpDir2, "frames");
    fs.mkdirSync(framesDir2, { recursive: true });

    fs.writeFileSync(path.join(framesDir2, "frame-0001.jpg"), "");

    const { cleanupFrames: cleanupFramesInternal } = __test__; // Need to re-import or use internal
    // cleanupFrames actually calls copySamplesSync if keep-samples is set
    const result = cleanupFrames(tmpDir2, { "keep-samples": 1 });

    assert.strictEqual(result.samples.length, 1);
    assert.ok(
      result.samples[0].endsWith(".jpg"),
      "Sample should preserve .jpg extension",
    );
    assert.ok(
      fs.existsSync(path.join(tmpDir2, "samples", "sample-000001.jpg")),
      "Sample file should exist with .jpg extension",
    );

    fs.rmSync(tmpDir2, { recursive: true, force: true });
  });

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
