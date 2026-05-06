'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');

test('package.json has ci script that chains check and test', () => {
  const pkgPath = resolve(__dirname, '../package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  assert.strictEqual(
    pkg.scripts.ci,
    'npm run check && npm test',
    'scripts.ci must be exactly "npm run check && npm test"'
  );
});
test('package metadata and ADR document the canonical CLI entrypoint', () => {
  const pkgPath = resolve(__dirname, '../package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  assert.strictEqual(
    pkg.bin['timelapse-capture'],
    './src/timelapse-capture.mjs',
    'published bin must use the canonical ESM entrypoint'
  );

  const adrPath = resolve(__dirname, '../docs/decisions/001-canonical-cli-entrypoint.md');
  assert.ok(existsSync(adrPath), 'canonical CLI ADR must exist');

  const adr = readFileSync(adrPath, 'utf8');
  for (const requiredText of [
    'src/timelapse-capture.mjs',
    'src/cli/index.js',
    'src/cli/parser.js',
    'src/cli/render.js',
    'ParseError',
    '--no-<flag>',
    'doctor',
    'stale-frame',
    'ETA',
    'runDirBytes',
    'framesBytes',
    'frame-name padding'
  ]) {
    assert.ok(
      adr.includes(requiredText),
      `canonical CLI ADR must mention ${requiredText}`
    );
  }
});
