const assert = require('node:assert');
const fs = require('node:fs');
const test = require('node:test');

function read(path) {
  return fs.readFileSync(path, 'utf8');
}

test('README documents tester setup and dogfood workflow', () => {
  const readme = read('README.md');
  for (const required of [
    'Installation',
    'Node >= 20',
    'npm install',
    'npx playwright install chromium',
    'ffmpeg',
    'ffprobe',
    'doctor',
    'Quick Start',
    'Troubleshooting',
    '--keep-frames',
    '--keep-samples',
    '--keep-latest',
    'Artifacts',
  ]) {
    assert.match(readme, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('agent skill requires doctor before capture work', () => {
  const skill = read('skill/SKILL.md');
  assert.match(skill, /Run `timelapse-capture doctor` before any capture work/);
  assert.match(skill, /Node >= 20/);
  assert.match(skill, /npx playwright install chromium/);
  assert.match(skill, /start -> status -> peek -> render/);
  assert.match(skill, /README\.md/);
});
