import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";

const claudePath = new URL("../CLAUDE.md", import.meta.url);
const readmePath = new URL("../README.md", import.meta.url);

test("docs explain that quality gates are local-only because there is no remote CI", async () => {
  const [claudeMd, readmeMd] = await Promise.all([
    fs.readFile(claudePath, "utf8"),
    fs.readFile(readmePath, "utf8"),
  ]);

  assert.match(claudeMd, /no remote CI/i);
  assert.match(readmeMd, /no remote CI/i);
  assert.match(readmeMd, /npm run ci/);
});

test("CLAUDE.md npm run ci description matches package.json gates", async () => {
  const claudeMd = await fs.readFile(claudePath, "utf8");
  const ciLine = claudeMd
    .split("\n")
    .find((line) => line.trim().startsWith("npm run ci"));

  assert.ok(ciLine, "Expected CLAUDE.md to document npm run ci");
  for (const gate of ["check", "format:check", "typecheck", "test"]) {
    assert.match(
      ciLine,
      new RegExp(gate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `Expected npm run ci description to include ${gate}`,
    );
  }
});
