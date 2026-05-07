import assert from "node:assert";
import test from "node:test";
import { parseArgs } from "../src/timelapse-capture.mjs";

test("parser supports ISO timestamp for --near", () => {
  const timestamp = "2026-05-07T10:00:00Z";
  const parsed = parseArgs(["peek", "runs/test", "--near", timestamp]);
  assert.equal(parsed.options.near, timestamp);
});

test("parser still supports numeric index for --near", () => {
  const parsed = parseArgs(["peek", "runs/test", "--near", "5"]);
  assert.equal(parsed.options.near, 5);
});
