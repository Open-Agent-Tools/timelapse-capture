'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { chmodSync, existsSync, mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

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
  assert.strictEqual(pkg.scripts['check:local'], 'bash ./scripts/local-check.sh');
  assert.match(pkg.scripts.test, /^node --test\b/);
  assert.strictEqual(pkg.scripts.typecheck, 'tsc --noEmit');
  assert.strictEqual(pkg.scripts.ci, 'npm run check && npm run typecheck && npm test');
});

test('local-check script exists and is executable', () => {
  const scriptPath = resolve(REPO_ROOT, 'scripts', 'local-check.sh');
  assert.strictEqual(existsSync(scriptPath), true);
  const mode = statSync(scriptPath).mode;
  assert.ok((mode & 0o111) !== 0, 'local-check.sh must be executable');
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

test('local-check prints SKIP messages when ffmpeg and ffprobe are absent from PATH', () => {
  const tempDir = mkdtempSync(join(os.tmpdir(), 'tlc-local-check-'));
  const shimPath = resolve(tempDir, 'npm');
  const logPath = resolve(tempDir, 'npm-invocations.log');

  try {
    const shim = `#!/bin/sh\nprintf '%s\n' \"$*\" >> '${logPath}'\n`;
    writeFileSync(shimPath, shim);
    chmodSync(shimPath, 0o755);

    const result = spawnSync(
      '/bin/bash',
      [resolve(REPO_ROOT, 'scripts', 'local-check.sh')],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          PATH: tempDir,
        },
        encoding: 'utf8',
        timeout: 10000,
      }
    );

    assert.ifError(result.error);

    assert.strictEqual(result.status, 0, `local-check failed; stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(
      result.stdout,
      /SKIP: real binary checks requiring ffmpeg are disabled because ffmpeg is not available on PATH\./
    );
    assert.match(
      result.stdout,
      /SKIP: real binary checks requiring ffprobe are disabled because ffprobe is not available on PATH\./
    );

    const log = readFileSync(logPath, 'utf8');
    const invocations = log.split('\n').filter(Boolean);
    assert.ok(invocations.includes('run check'), 'npm shim should record npm run check');
    assert.ok(invocations.includes('test'), 'npm shim should record npm test');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
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

test('local-check.sh exports only the consumed TIMELAPSE_HAS_REAL_FFMPEG_SUITE env var', () => {
  const script = readFileSync(resolve(REPO_ROOT, 'scripts', 'local-check.sh'), 'utf8');
  assert.ok(!script.includes('TIMELAPSE_HAS_REAL_FFMPEG_BINARIES'), 'TIMELAPSE_HAS_REAL_FFMPEG_BINARIES must not be exported');
  assert.ok(!script.includes('TIMELAPSE_HAS_REAL_FFPROBE_BINARIES'), 'TIMELAPSE_HAS_REAL_FFPROBE_BINARIES must not be exported');
  assert.ok(script.includes('TIMELAPSE_HAS_REAL_FFMPEG_SUITE'), 'TIMELAPSE_HAS_REAL_FFMPEG_SUITE must still be exported');
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
