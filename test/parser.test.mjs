import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ParseError,
  parseArgs,
  parseDuration,
  parseViewport,
} from "../src/timelapse-capture.mjs";

test("parseDuration accepts combined and unit-formatted values", () => {
  assert.deepEqual(parseDuration("30s"), { input: "30s", ms: 30000 });
  assert.deepEqual(parseDuration("5m"), { input: "5m", ms: 300000 });
  assert.deepEqual(parseDuration("2h"), { input: "2h", ms: 7200000 });
  assert.deepEqual(parseDuration("500ms"), { input: "500ms", ms: 500 });
  assert.deepEqual(parseDuration("1h30m"), { input: "1h30m", ms: 5400000 });
});

test("parseDuration rejects malformed values", () => {
  assert.throws(
    () => parseDuration(""),
    (error) => error instanceof ParseError && error.code === "E_BAD_DURATION",
  );
  assert.throws(
    () => parseDuration("abc"),
    (error) => error instanceof ParseError && error.code === "E_BAD_DURATION",
  );
  assert.throws(
    () => parseDuration("30x"),
    (error) => error instanceof ParseError && error.code === "E_BAD_DURATION",
  );
});

test("parseViewport accepts valid viewport and rejects invalid dimensions", () => {
  assert.deepEqual(parseViewport("1280x720"), {
    input: "1280x720",
    width: 1280,
    height: 720,
  });
  assert.throws(
    () => parseViewport("0x720"),
    (error) => error instanceof ParseError && error.code === "E_BAD_VIEWPORT",
  );
  assert.throws(
    () => parseViewport("abc"),
    (error) => error instanceof ParseError && error.code === "E_BAD_VIEWPORT",
  );
});

test("parseArgs maps positional arguments for core run-dir commands", () => {
  const statusParsed = parseArgs(["status", "/tmp/run"]);
  assert.equal(statusParsed.command, "status");
  assert.equal(statusParsed.runDir, "/tmp/run");

  const peekParsed = parseArgs(["peek", "/tmp/run"]);
  assert.equal(peekParsed.command, "peek");
  assert.equal(peekParsed.runDir, "/tmp/run");

  const renderParsed = parseArgs(["render", "/tmp/run"]);
  assert.equal(renderParsed.command, "render");
  assert.equal(renderParsed.runDir, "/tmp/run");
});

test("parseArgs maps capture --run for the internal child entrypoint", () => {
  const parsed = parseArgs(["capture", "--run", "/tmp/run"]);
  assert.equal(parsed.command, "capture");
  assert.equal(parsed.options.run, "/tmp/run");
});

test("parseArgs parses start target and required duration", () => {
  const parsed = parseArgs([
    "start",
    "http://example.com",
    "--duration",
    "30s",
  ]);
  assert.equal(parsed.command, "start");
  assert.equal(parsed.target, "http://example.com");
  assert.equal(parsed.options.duration.ms, 30000);
});

test("parseArgs parses start --url target and required duration", () => {
  const parsed = parseArgs([
    "start",
    "--url",
    "http://example.test",
    "--duration",
    "30s",
  ]);
  assert.equal(parsed.command, "start");
  assert.equal(parsed.target, "http://example.test");
  assert.equal(parsed.options.duration.ms, 30000);
});

test("parseArgs rejects conflicting positional and --url start targets", () => {
  assert.throws(
    () =>
      parseArgs([
        "start",
        "http://one.test",
        "--url",
        "http://two.test",
        "--duration",
        "30s",
      ]),
    (error) =>
      error instanceof ParseError &&
      /conflicting start targets/i.test(error.message),
  );
});

test("parseArgs handles json boolean flags and short aliases", () => {
  const enabled = parseArgs([
    "start",
    "http://example.com",
    "--duration",
    "30s",
    "--json",
  ]);
  assert.equal(enabled.options.json, true);

  const negated = parseArgs([
    "start",
    "http://example.com",
    "--duration",
    "30s",
    "--no-json",
  ]);
  assert.equal(negated.options.json, false);

  const short = parseArgs([
    "start",
    "http://example.com",
    "--duration",
    "30s",
    "-j",
  ]);
  assert.equal(short.options.json, true);
});

test("parseArgs validates unknown command and unknown flag", () => {
  assert.throws(
    () => parseArgs(["bogus"]),
    (error) =>
      error instanceof ParseError && error.code === "E_UNKNOWN_COMMAND",
  );
  assert.throws(
    () =>
      parseArgs([
        "start",
        "http://example.com",
        "--duration",
        "30s",
        "--unknown",
      ]),
    (error) => error instanceof ParseError && error.code === "E_UNKNOWN_FLAG",
  );
});

test("parseArgs validates index and near values", () => {
  const parsed = parseArgs([
    "peek",
    "/tmp/run",
    "--index",
    "5",
    "--near",
    "2026-05-10T12:00:00Z",
  ]);
  assert.equal(parsed.options.index, 5);
  assert.equal(parsed.options.near, "2026-05-10T12:00:00.000Z");

  assert.throws(
    () => parseArgs(["peek", "/tmp/run", "--index", "abc"]),
    (error) => error instanceof ParseError && error.code === "E_BAD_INDEX",
  );
  assert.throws(
    () => parseArgs(["peek", "/tmp/run", "--near", "not-a-date"]),
    (error) => error instanceof ParseError && error.code === "E_BAD_TIMESTAMP",
  );
});

test("parseArgs validates required arguments and arity", () => {
  assert.throws(
    () => parseArgs(["start"]),
    (error) =>
      error instanceof ParseError && error.code === "E_MISSING_ARGUMENT",
  );
  assert.throws(
    () => parseArgs(["start", "http://example.com", "--duration"]),
    (error) => error instanceof ParseError && error.code === "E_MISSING_VALUE",
  );
  assert.throws(
    () => parseArgs(["status", "/tmp/run", "extra"]),
    (error) => error instanceof ParseError && error.code === "E_EXTRA_ARGUMENT",
  );
});
