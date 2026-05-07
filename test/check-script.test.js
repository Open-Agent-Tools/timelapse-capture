'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
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

test('canonical CLI entrypoint decision is documented and wired', () => {
  const pkgPath = resolve(__dirname, '../package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

  assert.strictEqual(
    pkg.bin['timelapse-capture'],
    './src/timelapse-capture.mjs',
    'published binary must point at the canonical ESM entrypoint'
  );

  const decisionPath = resolve(__dirname, '../docs/decisions/001-canonical-cli-entrypoint.md');
  const decision = readFileSync(decisionPath, 'utf8');
  const requiredTerms = [
    'src/timelapse-capture.mjs',
    'src/cli/index.js',
    'src/cli/parser.js',
    'src/cli/render.js',
    'doctor',
    'stale-frame',
    'ETA',
    'ParseError',
    'frame-name padding',
  ];

  for (const term of requiredTerms) {
    assert.match(decision, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `ADR must mention ${term}`);
  }
});
