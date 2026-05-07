'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const CANONICAL_BIN = './src/timelapse-capture.mjs';
const CANONICAL_BIN_NORMALIZED = 'src/timelapse-capture.mjs';
// Scaffold-only 1x1 PNG fixture used by the demoted CLI. The canonical entry
// must produce real screenshots, so this byte sequence must not appear in it.
const SCAFFOLD_FRAME_PNG_HEX_PREFIX =
  '89504e470d0a1a0a0000000d4948445200000001000000010802';

test('package.json has ci script that chains check and test', () => {
  const pkgPath = resolve(__dirname, '../package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  assert.strictEqual(
    pkg.scripts.ci,
    'npm run check && npm test',
    'scripts.ci must be exactly "npm run check && npm test"'
  );
});

test('package.json bin points at canonical CLI entrypoint', () => {
  const pkgPath = resolve(__dirname, '../package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  assert.strictEqual(
    pkg.bin['timelapse-capture'],
    CANONICAL_BIN,
    `package.json#bin.timelapse-capture must be "${CANONICAL_BIN}"`
  );
});

test('package.json check script validates only the canonical entrypoint', () => {
  const pkgPath = resolve(__dirname, '../package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  assert.strictEqual(
    pkg.scripts.check,
    `node --check ${CANONICAL_BIN}`,
    `scripts.check must be "node --check ${CANONICAL_BIN}" so CI does not validate demoted scaffold files`
  );
});

test('package.json test script runs node --test against test/*.test.{js,mjs}', () => {
  const pkgPath = resolve(__dirname, '../package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  assert.match(
    pkg.scripts.test,
    /^node --test\b/,
    'scripts.test must invoke node --test'
  );
  assert.match(
    pkg.scripts.test,
    /test\/\*\*\/\*\.test\.mjs/,
    'scripts.test must include the .mjs canonical test glob'
  );
});

test('package-lock.json bin metadata matches canonical entrypoint', () => {
  const lockPath = resolve(__dirname, '../package-lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const rootBin = lock.packages?.['']?.bin?.['timelapse-capture'];
  assert.strictEqual(
    rootBin,
    CANONICAL_BIN_NORMALIZED,
    `package-lock.json root package bin must be "${CANONICAL_BIN_NORMALIZED}"`
  );
});

test('canonical entrypoint is not the 1x1 PNG scaffold', () => {
  const canonicalPath = resolve(__dirname, '..', CANONICAL_BIN_NORMALIZED);
  const source = readFileSync(canonicalPath, 'utf8');
  assert.ok(
    !source.toLowerCase().includes(SCAFFOLD_FRAME_PNG_HEX_PREFIX),
    'canonical CLI must not embed the scaffold 1x1 PNG fixture'
  );
  assert.match(
    source,
    /chromium\.launch/,
    'canonical CLI must launch a real browser to capture screenshots'
  );
  assert.match(
    source,
    /page\.screenshot/,
    'canonical CLI must call page.screenshot to capture real frames'
  );
});
