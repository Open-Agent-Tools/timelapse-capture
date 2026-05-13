import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { __test__ } from "../src/timelapse-capture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

async function readProjectFile(...segments) {
  return fs.readFile(path.join(ROOT, ...segments), "utf8");
}

test("README start synopsis lists every COMMAND_SCHEMAS.start flag", async () => {
  const readme = await readProjectFile("README.md");

  const segments = readme.split("```");
  const synopsisBlocks = [];
  for (let i = 1; i < segments.length; i += 2) {
    const block = segments[i];
    // The first line of a fenced block is the language label (e.g. "bash"),
    // so skip it and look at the first non-empty content line.
    const lines = block.split("\n");
    const contentLines = lines.slice(1);
    const firstNonEmpty = contentLines
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (
      firstNonEmpty &&
      firstNonEmpty.startsWith("timelapse-capture start <url>")
    ) {
      synopsisBlocks.push(block);
    }
  }

  assert.strictEqual(
    synopsisBlocks.length,
    1,
    `Expected exactly one fenced code block starting with "timelapse-capture start <url>" in README.md, found ${synopsisBlocks.length}`,
  );

  const synopsisBlock = synopsisBlocks[0];
  const startSchema = __test__.COMMAND_SCHEMAS.start;
  const flags = [...startSchema.valueFlags, ...startSchema.boolFlags].filter(
    (flag) => flag !== "help",
  );

  for (const flag of flags) {
    assert.ok(
      synopsisBlock.includes(`--${flag}`),
      `--${flag} missing from README start synopsis`,
    );
  }
});

test("README documents dogfood tester setup and capture workflow", async () => {
  const readme = await readProjectFile("README.md");
  const requiredSnippets = [
    "## Installation",
    "Node.js 20",
    "npm install",
    "npx playwright install chromium",
    "ffmpeg",
    "ffprobe",
    "## Doctor",
    "timelapse-capture doctor",
    "## Dogfood Walkthrough",
    "timelapse-capture start",
    "timelapse-capture status",
    "timelapse-capture peek",
    "timelapse-capture render",
    "## Troubleshooting",
    "## Retention Examples",
    "## Artifacts",
  ];

  for (const snippet of requiredSnippets) {
    assert.match(
      readme,
      new RegExp(snippet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }

  // Troubleshooting subsection for ffprobe specifically
  assert.match(readme, /### .*ffprobe/i);
  // Rendered artifact path is documented
  assert.match(readme, /output\.mp4/);
  // Both manifest files must be documented in the Artifacts section
  assert.match(readme, /manifest\.jsonl/);
  assert.match(readme, /manifest\.json/);
  assert.match(readme, /latest-frame\.json/);
  assert.match(readme, /capture\.log/);
  assert.match(readme, /render\.log/);
  assert.match(readme, /samples\//);
  assert.match(
    readme,
    /- `samples\/`: retained sample frames copied by `render` or `cleanup` when `--keep-samples` is used, named `sample-NNNNNN\.png`\./,
  );
  assert.match(readme, /poster\.png/);
  // manifest.jsonl must be described as the per-frame log near its filename
  assert.match(readme, /manifest\.jsonl[\s\S]{0,400}per-frame/i);
  // manifest.json must be described as start-time metadata near its filename
  assert.match(
    readme,
    /manifest\.json[^l][\s\S]{0,400}(start-time|run metadata|capture start)/i,
  );
  assert.doesNotMatch(readme, /latest-retained\.png/);
});

test("skill requires doctor before capture and describes the agent workflow", async () => {
  const skill = await readProjectFile("skill", "SKILL.md");

  assert.match(skill, /## Prerequisites/);
  assert.match(skill, /Node\.js 20/);
  assert.match(skill, /npm install/);
  assert.match(skill, /npx playwright install chromium/);
  assert.match(skill, /ffmpeg/);
  assert.match(skill, /ffprobe/);
  assert.match(skill, /Run `timelapse-capture doctor` before any capture work/);
  assert.match(
    skill,
    /start .*status .*peek .*render .*report artifact paths/is,
  );
  assert.match(skill, /README\.md/);

  // Frame inspection discipline: inspect single path, not full frames dir
  assert.match(
    skill,
    /inspect only the returned image path|Do not load the (full|whole) [`']?frames\/?[`']? directory/i,
  );
  // Explicit rendered MP4 path format
  assert.match(skill, /<run-dir>\/output\.mp4/);
  // Report artifact paths instruction
  assert.match(skill, /report.*artifact path/i);
  // Example run-dir paths should match the canonical README shape.
  assert.match(skill, /\.\/timelapse-runs\//);
  assert.doesNotMatch(skill, /\.\/runs\/localhost/);
  assert.doesNotMatch(
    skill,
    /timelapse-capture (status|peek|render) [^\n]*-\d{13}/,
  );
});

test("dogfood-protocol.md covers install checklist, all three scenarios, feedback section, and key CLI coverage", async () => {
  const doc = await readProjectFile("docs", "dogfood-protocol.md");

  // Install checklist
  assert.match(doc, /## Tester Install Steps/);
  assert.match(doc, /Node\.js 20/);
  assert.match(doc, /npm install/);
  assert.match(doc, /npx playwright install chromium/);
  assert.match(doc, /ffmpeg/);

  // Three scenario sections
  assert.match(doc, /## Scenario 1/);
  assert.match(doc, /## Scenario 2/);
  assert.match(doc, /## Scenario 3/);

  // Feedback section
  assert.match(doc, /## Tester Feedback Template/);

  // Key CLI flag and artifact coverage
  assert.match(doc, /--keep-frames/);
  assert.match(doc, /manifest\.jsonl/);

  // Explicit Expected outcomes throughout (not just Confirm prose)
  const expectedCount = (doc.match(/\*\*Expected:\*\*/g) || []).length;
  assert.ok(
    expectedCount >= 10,
    `Expected at least 10 **Expected:** outcome blocks, found ${expectedCount}`,
  );

  // Scenario 2 must use render --keep-frames, not the broken render+cleanup pattern
  assert.match(
    doc,
    /render "[^"]*" --keep-frames|render \$\w+ --keep-frames|render.*--keep-frames/,
  );
  assert.doesNotMatch(
    doc,
    /render "\$RUN_DIR"\s*\ntimelapse-capture cleanup "\$RUN_DIR" --keep-frames/,
  );
  assert.doesNotMatch(doc, /latest-retained\.png/);
  assert.match(doc, /poster\.png.*run produced[\s\S]*at least one frame\./);
});

test("CLAUDE.md contains concrete project guidance instead of template placeholders", async () => {
  const claudeMd = await readProjectFile("CLAUDE.md");

  // Must NOT contain any template placeholder text
  assert.doesNotMatch(claudeMd, /_Add your build and test commands here_/);
  assert.doesNotMatch(
    claudeMd,
    /_Add a brief overview of your project architecture_/,
  );
  assert.doesNotMatch(claudeMd, /_Add your project-specific conventions here_/);
  assert.doesNotMatch(claudeMd, /# Example:/);

  // Must document real build and validation commands
  assert.match(claudeMd, /npm run check/);
  assert.match(claudeMd, /npm run typecheck/);
  assert.match(claudeMd, /npm test/);
  assert.match(claudeMd, /npm run check:local/);
  assert.match(claudeMd, /npm test\s+#[^\n]*test\/\*\*\/\*\.test\.\{js,mjs\}/);
  assert.match(
    claudeMd,
    /npm run ci\s+#[^\n]*check \+ format:check \+ typecheck \+ test/,
  );

  // Must reference canonical source files
  assert.match(claudeMd, /src\/timelapse-capture\.mjs/);
  assert.match(claudeMd, /src\/doctor\.mjs/);
  assert.match(claudeMd, /test\//);

  // Architecture Overview bullet for src/timelapse-capture.mjs must list
  // the canonical command set and must not name a nonexistent `report`
  // command. Source of truth: the `main` switch in src/timelapse-capture.mjs.
  const cliBulletMatch = claudeMd.match(/`src\/timelapse-capture\.mjs`[^\n]*/);
  assert.ok(
    cliBulletMatch,
    "Expected an Architecture Overview bullet referencing `src/timelapse-capture.mjs`",
  );
  const cliBullet = cliBulletMatch[0];
  for (const cmd of [
    "start",
    "capture",
    "status",
    "peek",
    "render",
    "cleanup",
    "doctor",
  ]) {
    assert.match(
      cliBullet,
      new RegExp("`" + cmd + "`"),
      `Expected \`${cmd}\` in the src/timelapse-capture.mjs command list`,
    );
  }
  assert.doesNotMatch(
    cliBullet,
    /`report`/,
    "src/timelapse-capture.mjs has no `report` command; remove it from the CLAUDE.md command list",
  );
});
