import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { getOutputPath } from "../src/timelapse-capture.mjs";

const RUN_DIR = "/tmp/run-output-path-helpers";

test("getOutputPath: options.output as CLI string wins", () => {
  assert.equal(
    getOutputPath(RUN_DIR, { output: "cli.mp4" }),
    path.resolve(RUN_DIR, "cli.mp4"),
  );
});

test("getOutputPath: options.output as { path } object resolves", () => {
  assert.equal(
    getOutputPath(RUN_DIR, { output: { path: "a.mp4" } }),
    path.resolve(RUN_DIR, "a.mp4"),
  );
});

test("getOutputPath: wrapped config.output.path resolves", () => {
  assert.equal(
    getOutputPath(RUN_DIR, { config: { output: { path: "b.mp4" } } }),
    path.resolve(RUN_DIR, "b.mp4"),
  );
});

test("getOutputPath: legacy config.outputPath resolves", () => {
  assert.equal(
    getOutputPath(RUN_DIR, { config: { outputPath: "c.mp4" } }),
    path.resolve(RUN_DIR, "c.mp4"),
  );
});

test("getOutputPath: options.output wins over wrapped config.output.path", () => {
  assert.equal(
    getOutputPath(RUN_DIR, {
      output: { path: "win.mp4" },
      config: { output: { path: "lose.mp4" } },
    }),
    path.resolve(RUN_DIR, "win.mp4"),
  );
});

test("getOutputPath: CLI string wins over wrapped config.output.path", () => {
  assert.equal(
    getOutputPath(RUN_DIR, {
      output: "cli-win.mp4",
      config: { output: { path: "lose.mp4" } },
    }),
    path.resolve(RUN_DIR, "cli-win.mp4"),
  );
});

test("getOutputPath: wrapped config.output.path wins over legacy config.outputPath", () => {
  assert.equal(
    getOutputPath(RUN_DIR, {
      config: { output: { path: "new.mp4" }, outputPath: "old.mp4" },
    }),
    path.resolve(RUN_DIR, "new.mp4"),
  );
});

test("getOutputPath: empty options falls back to output.mp4 default", () => {
  assert.equal(
    getOutputPath(RUN_DIR, {}),
    path.resolve(RUN_DIR, "output.mp4"),
  );
});

test("getOutputPath: undefined options falls back to output.mp4 default", () => {
  assert.equal(
    getOutputPath(RUN_DIR, undefined),
    path.resolve(RUN_DIR, "output.mp4"),
  );
});

test("getOutputPath: no second arg falls back to output.mp4 default", () => {
  assert.equal(getOutputPath(RUN_DIR), path.resolve(RUN_DIR, "output.mp4"));
});
