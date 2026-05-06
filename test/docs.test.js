const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const root = resolve(__dirname, '..');
const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
const skill = readFileSync(resolve(root, 'skill/SKILL.md'), 'utf8');

test('README documents the dogfood tester path', () => {
  for (const required of [
    'Installation',
    'doctor',
    'Quick Start',
    'Commands',
    'Troubleshooting',
    'Retention',
    'Artifacts',
    '--keep-frames',
  ]) {
    assert.ok(readme.includes(required), `README.md must include ${required}`);
  }

  assert.match(readme, /Node\s+>=\s+20/);
  assert.match(readme, /npx playwright install chromium/);
  assert.match(readme, /ffmpeg/);
  assert.match(readme, /ffprobe/);
});

test('skill requires doctor before capture work', () => {
  assert.match(skill, /Run `timelapse-capture doctor` before any capture work/);
  assert.match(skill, /start -> status -> peek .*-> render -> report artifact paths/);
  assert.match(skill, /README\.md/);
});
