import { test } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const pkgPath = resolve(import.meta.dirname, '../package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

test('package.json bin points at the canonical CLI entrypoint', () => {
  assert.strictEqual(
    pkg.bin['timelapse-capture'],
    './src/timelapse-capture.mjs',
    'bin.timelapse-capture must point at ./src/timelapse-capture.mjs',
  );
});

test('package.json scripts include check, test, and ci', () => {
  assert.strictEqual(
    pkg.scripts.check,
    'node --check ./src/timelapse-capture.mjs',
    'scripts.check must syntax-check the canonical entrypoint',
  );
  assert.ok(pkg.scripts.test, 'scripts.test must be defined');
  assert.match(pkg.scripts.test, /node --test/, 'scripts.test must invoke node --test');
  assert.strictEqual(
    pkg.scripts.ci,
    'npm run check && npm test',
    'scripts.ci must chain check then test',
  );
});

test('package-lock.json bin metadata matches canonical entrypoint', () => {
  const lockPath = resolve(import.meta.dirname, '../package-lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const root = lock.packages[''];
  assert.ok(root, 'package-lock.json must contain a root package entry');
  assert.strictEqual(
    root.bin['timelapse-capture'],
    'src/timelapse-capture.mjs',
    'package-lock.json root bin must reference the canonical entrypoint',
  );
});

test('CI workflow file exists and has required structure', () => {
  const workflowPath = resolve(import.meta.dirname, '../.github/workflows/test.yml');
  assert.ok(existsSync(workflowPath), '.github/workflows/test.yml must exist');

  const workflowContent = readFileSync(workflowPath, 'utf8');
  assert.ok(
    workflowContent.includes('pull_request'),
    'workflow must have pull_request trigger',
  );
  assert.ok(
    workflowContent.includes('push'),
    'workflow must have push trigger',
  );
  assert.ok(
    workflowContent.includes('npm run ci') || (workflowContent.includes('npm run check') && workflowContent.includes('npm test')),
    'workflow must run npm run ci or both npm run check and npm test',
  );
});
