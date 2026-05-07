import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const SKILL = readFileSync(new URL("../skill/SKILL.md", import.meta.url), "utf8");

function assertIncludesAll(text, terms, label) {
  for (const term of terms) {
    assert.ok(text.includes(term), `${label} must mention ${term}`);
  }
}

test("README covers zero-to-MP4 tester workflow", () => {
  assertIncludesAll(
    README,
    [
      "## Installation",
      "Node >= 20",
      "npm install",
      "npx playwright install chromium",
      "ffmpeg",
      "ffprobe",
      "## Doctor",
      "timelapse-capture doctor",
      "## Quick Start",
      "timelapse-capture start",
      "timelapse-capture peek",
      "timelapse-capture render",
      "output.mp4",
      "## Commands",
      "## Troubleshooting",
      "## Retention",
      "--keep-frames",
      "--keep-samples",
      "--keep-latest",
      "## Artifacts"
    ],
    "README.md"
  );
});

test("skill instructs agents to run doctor before capture", () => {
  assertIncludesAll(
    SKILL,
    [
      "## Prerequisites",
      "Node >= 20",
      "npm install",
      "npx playwright install chromium",
      "ffmpeg",
      "ffprobe",
      "Run `timelapse-capture doctor` before any capture work",
      "## Agent Workflow",
      "status",
      "peek",
      "render",
      "Report artifact paths",
      "README.md",
      "--keep-frames"
    ],
    "skill/SKILL.md"
  );
});
