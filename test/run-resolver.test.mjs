import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { aliasFor } from "../src/aliases.mjs";
import {
  listRuns,
  pickLatestRun,
  resolveRunDir,
} from "../src/run-resolver.mjs";

function makeRunsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tlc-resolver-"));
}

function makeRun(baseDir, name, mtime) {
  const full = path.join(baseDir, name);
  fs.mkdirSync(full);
  if (mtime !== undefined) {
    fs.utimesSync(full, mtime / 1000, mtime / 1000);
  }
  return full;
}

test("listRuns returns empty array when base dir is missing", () => {
  const missing = path.join(os.tmpdir(), `tlc-missing-${Date.now()}`);
  assert.deepEqual(listRuns(missing), []);
});

test("listRuns returns entries with alias and mtime", () => {
  const base = makeRunsDir();
  try {
    makeRun(base, "localhost-3000-20260518-181109");
    makeRun(base, "localhost-3000-20260518-181210");
    const runs = listRuns(base);
    assert.equal(runs.length, 2);
    for (const run of runs) {
      assert.equal(run.alias, aliasFor(run.name));
      assert.ok(typeof run.mtime === "number");
      assert.ok(run.path.startsWith(base));
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("pickLatestRun returns null when no runs exist", () => {
  const base = makeRunsDir();
  try {
    assert.equal(pickLatestRun(base), null);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("pickLatestRun returns the run with the newest mtime", () => {
  const base = makeRunsDir();
  try {
    const older = makeRun(base, "older-run", Date.now() - 60_000);
    const newer = makeRun(base, "newer-run", Date.now());
    const latest = pickLatestRun(base);
    assert.equal(latest.path, newer);
    assert.notEqual(latest.path, older);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("resolveRunDir returns latest run when input is empty", () => {
  const base = makeRunsDir();
  try {
    makeRun(base, "older-run", Date.now() - 60_000);
    const newer = makeRun(base, "newer-run", Date.now());
    assert.equal(resolveRunDir(undefined, base), newer);
    assert.equal(resolveRunDir("", base), newer);
    assert.equal(resolveRunDir(null, base), newer);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("resolveRunDir throws when no runs exist and no input given", () => {
  const base = makeRunsDir();
  try {
    assert.throws(() => resolveRunDir(undefined, base), /No runs found/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("resolveRunDir resolves an alias to its run path", () => {
  const base = makeRunsDir();
  try {
    const runPath = makeRun(base, "localhost-3000-20260518-181109");
    const alias = aliasFor("localhost-3000-20260518-181109");
    assert.equal(resolveRunDir(alias, base), runPath);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("resolveRunDir throws when alias does not match any run", () => {
  const base = makeRunsDir();
  try {
    makeRun(base, "localhost-3000-20260518-181109");
    assert.throws(
      () => resolveRunDir("brave-falcon-001", base),
      /No run matches alias/,
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("resolveRunDir passes paths through unchanged", () => {
  const base = makeRunsDir();
  try {
    const input = "/absolute/path/to/run";
    assert.equal(resolveRunDir(input, base), input);
    const relative = "./some-run";
    assert.equal(resolveRunDir(relative, base), relative);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
