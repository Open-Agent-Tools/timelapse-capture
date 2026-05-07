const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');

async function readProjectFile(...segments) {
  return fs.readFile(path.join(ROOT, ...segments), 'utf8');
}

test('README documents dogfood tester setup and capture workflow', async () => {
  const readme = await readProjectFile('README.md');
  const requiredSnippets = [
    '## Installation',
    'Node.js 20',
    'npm install',
    'npx playwright install chromium',
    'ffmpeg',
    'ffprobe',
    '## Doctor',
    'timelapse-capture doctor',
    '## Dogfood Walkthrough',
    'timelapse-capture start',
    'timelapse-capture status',
    'timelapse-capture peek',
    'timelapse-capture render',
    '## Troubleshooting',
    '## Retention Examples',
    '## Artifacts',
  ];

  for (const snippet of requiredSnippets) {
    assert.match(readme, new RegExp(snippet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('skill requires doctor before capture and describes the agent workflow', async () => {
  const skill = await readProjectFile('skill', 'SKILL.md');

  assert.match(skill, /## Prerequisites/);
  assert.match(skill, /Node\.js 20/);
  assert.match(skill, /npm install/);
  assert.match(skill, /npx playwright install chromium/);
  assert.match(skill, /ffmpeg/);
  assert.match(skill, /ffprobe/);
  assert.match(skill, /Run `timelapse-capture doctor` before any capture work/);
  assert.match(skill, /start .*status .*peek .*render .*report artifact paths/is);
  assert.match(skill, /README\.md/);
});
