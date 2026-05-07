'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const REPO_ROOT = resolve(__dirname, '..');
const CANONICAL_BIN = './src/timelapse-capture.mjs';

function readJson(relative) {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, relative), 'utf8'));
}

test('package.json bin points at the canonical CLI entrypoint', () => {
  const pkg = readJson('package.json');
  assert.strictEqual(pkg.bin['timelapse-capture'], CANONICAL_BIN);
});

test('package.json scripts target the canonical entry and run Node\'s test runner', () => {
  const pkg = readJson('package.json');
  assert.strictEqual(pkg.scripts.start, `node ${CANONICAL_BIN}`);
  assert.match(pkg.scripts.check, /node --check \.\/src\/timelapse-capture\.mjs/);
  assert.match(pkg.scripts.test, /^node --test\b/);
  assert.strictEqual(pkg.scripts.ci, 'npm run check && npm test');
});

test('package.json scripts no longer reference the demoted src/cli implementation', () => {
  const raw = readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8');
  assert.ok(!raw.includes('src/cli'), 'package.json must not reference src/cli');
});

test('package-lock.json root bin matches package.json', () => {
  const lock = readJson('package-lock.json');
  assert.strictEqual(lock.packages[''].bin['timelapse-capture'], 'src/timelapse-capture.mjs');
});

test('the demoted src/cli directory has been removed', () => {
  assert.strictEqual(existsSync(resolve(REPO_ROOT, 'src/cli')), false);
});

test('canonical entry uses real Playwright (not the scaffold 1x1 PNG fixture)', () => {
  const cli = readFileSync(resolve(REPO_ROOT, 'src/timelapse-capture.mjs'), 'utf8');
  assert.match(cli, /chromium\.launch/);
  assert.match(cli, /page\.screenshot/);
  assert.ok(
    !cli.includes('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de'),
    'canonical CLI must not embed the 1x1 PNG scaffold fixture'
  );
});
