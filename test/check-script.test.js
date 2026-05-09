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
  assert.match(pkg.scripts.check, /node --check \.\/src\/doctor\.mjs/);
  assert.match(pkg.scripts.test, /^node --test\b/);
  assert.strictEqual(pkg.scripts.typecheck, 'tsc --noEmit');
  assert.strictEqual(pkg.scripts.ci, 'npm run check && npm test');
});

test('package.json installs the local TypeScript compiler used by typecheck', () => {
  const pkg = readJson('package.json');
  assert.match(pkg.devDependencies.typescript, /^\^?\d+\.\d+\.\d+/);
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
    !cli.toLowerCase().includes('89504e470d0a1a0a0000000d4948445200000001000000010802'),
    'canonical CLI must not embed the 1x1 PNG scaffold fixture'
  );
});

test('source does not use empty promise catch cleanup handlers', () => {
  const sources = [
    'src/timelapse-capture.mjs',
    'src/doctor.mjs',
  ];
  const emptyPromiseCatch =
    /\.catch\(\s*(?:async\s+)?(?:(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|function(?:\s+[A-Za-z_$][\w$]*)?\s*\([^)]*\))\s*\{\s*\}\s*\)/;
  const rejectedExamples = [
    'cleanup().catch(() => {})',
    'cleanup().catch((_) => {})',
    'cleanup().catch(_ => {})',
    'cleanup().catch(function() {})',
  ];
  const allowedExamples = [
    'cleanup().catch(() => [])',
    'cleanup().catch((error) => { throw error; })',
    'cleanup().catch(function(error) { console.error(error); })',
  ];

  for (const example of rejectedExamples) {
    assert.match(example, emptyPromiseCatch, `${example} must be rejected`);
  }

  for (const example of allowedExamples) {
    assert.doesNotMatch(example, emptyPromiseCatch, `${example} must remain allowed`);
  }

  for (const source of sources) {
    const raw = readFileSync(resolve(REPO_ROOT, source), 'utf8');
    assert.doesNotMatch(raw, emptyPromiseCatch, `${source} must report or propagate cleanup failures`);
  }
});

test('source does not use comment-only catch blocks', () => {
  const sources = [
    'src/timelapse-capture.mjs',
    'src/doctor.mjs',
  ];
  const commentOnlyCatch =
    /catch\s*\{\s*(?:(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))\s*)+\}/;
  const rejectedExamples = [
    'catch { /* ignore */ }',
    'catch {\n  // best effort\n}',
  ];
  const allowedExamples = [
    'catch { return null; }',
    'catch (error) { console.error(error); }',
  ];

  for (const example of rejectedExamples) {
    assert.match(example, commentOnlyCatch, `${example} must be rejected`);
  }

  for (const example of allowedExamples) {
    assert.doesNotMatch(example, commentOnlyCatch, `${example} must remain allowed`);
  }

  for (const source of sources) {
    const raw = readFileSync(resolve(REPO_ROOT, source), 'utf8');
    assert.doesNotMatch(raw, commentOnlyCatch, `${source} must not contain comment-only catch blocks`);
  }
});

test('canonical CLI entrypoint decision is documented and wired', () => {
  const decisionPath = resolve(REPO_ROOT, 'docs/decisions/001-canonical-cli-entrypoint.md');
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
