import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";

const claudePath = new URL("../CLAUDE.md", import.meta.url);
const readmePath = new URL("../README.md", import.meta.url);
const pkgPath = new URL("../package.json", import.meta.url);

async function readIfExists(url) {
  try {
    return await fs.readFile(url, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

test("README documents the quality gates and references npm run ci", async () => {
  const readmeMd = await fs.readFile(readmePath, "utf8");

  assert.match(readmeMd, /npm run ci/);
  assert.match(readmeMd, /quality gates/i);
});

test("CLAUDE.md npm run ci description matches package.json gates exactly", async () => {
  const [claudeMd, pkgText] = await Promise.all([
    readIfExists(claudePath),
    fs.readFile(pkgPath, "utf8"),
  ]);

  if (claudeMd === null) {
    // CLAUDE.md is gitignored — only present in local checkouts.
    return;
  }

  const pkg = JSON.parse(pkgText);
  const ciScript = pkg.scripts?.ci;
  assert.ok(ciScript, "Expected package.json to define scripts.ci");

  // Extract gate names from scripts.ci, e.g.:
  //   "npm run check && npm run format:check && npm run typecheck && npm test"
  // Handles both "npm run <name>" and "npm <name>" for built-in shorthands like "npm test".
  const scriptGates = [...ciScript.matchAll(/npm (?:run )?(\S+)/g)].map(
    (m) => m[1],
  );

  const ciLine = claudeMd
    .split("\n")
    .find((line) => line.trim().startsWith("npm run ci"));
  assert.ok(ciLine, "Expected CLAUDE.md to document npm run ci");

  // Token-split the gate list from the comment, e.g. "# check + format:check + typecheck + test".
  // Splitting on " + " gives exact token names and avoids substring false positives where
  // "check" would match inside "format:check" or "typecheck" with a bare regex test.
  const commentMatch = ciLine.match(/#\s*([\w:.-]+(?:\s*\+\s*[\w:.-]+)*)/);
  assert.ok(
    commentMatch,
    `Expected "npm run ci" line to have a comment listing gates separated by +, got: ${ciLine.trim()}`,
  );
  const docGates = commentMatch[1]
    .split(/\s*\+\s*/)
    .map((g) => g.trim())
    .filter(Boolean);

  assert.deepEqual(
    [...docGates].sort(),
    [...scriptGates].sort(),
    `CLAUDE.md documents gates [${docGates.join(", ")}] but package.json scripts.ci runs [${scriptGates.join(", ")}]`,
  );
});
