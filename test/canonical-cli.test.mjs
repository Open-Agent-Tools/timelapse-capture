import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  ParseError,
  parseCli,
} from '../src/timelapse-capture.mjs';

const CLI_PATH = path.resolve(import.meta.dirname, '..', 'src', 'timelapse-capture.mjs');

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...options.env,
    },
  });
}

test('canonical parser raises structured ParseError codes', () => {
  assert.throws(
    () => parseCli(['start', 'https://example.com', '--duration', '99x', '--interval', '1s']),
    {
      name: 'ParseError',
      code: 'E_BAD_DURATION',
    },
  );

  assert.throws(
    () => parseCli(['status', 'runs/current', '--bogus']),
    {
      name: 'ParseError',
      code: 'E_UNKNOWN_FLAG',
    },
  );
});

test('canonical parser supports command positionals and boolean negation', () => {
  const parsed = parseCli([
    'start',
    'https://example.com',
    '--duration',
    '10s',
    '--interval',
    '1s',
    '--keep-latest',
    '--no-keep-latest',
  ]);

  assert.equal(parsed.command, 'start');
  assert.equal(parsed.args.url, 'https://example.com');
  assert.equal(parsed.args.duration, '10s');
  assert.equal(parsed.args.interval, '1s');
  assert.equal(parsed.args['keep-latest'], false);

  const legacyUrlFlag = parseCli(['start', '--url', 'https://example.com', '--duration', '10s', '--interval', '1s']);
  assert.equal(legacyUrlFlag.args.url, 'https://example.com');
});

test('ParseError is exported for canonical parser consumers', () => {
  const error = new ParseError('E_TEST', 'test message');
  assert.equal(error.name, 'ParseError');
  assert.equal(error.code, 'E_TEST');
});

test('doctor command reports runtime dependency checks', () => {
  const result = runCli(['doctor', '--json']);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.node.ok, true);
  assert.equal(payload.playwright.ok, true);
  assert.equal(typeof payload.ffmpeg.ok, 'boolean');
});

test('status reports enriched JSON and human stale-frame details', async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'timelapse-canonical-status-'));
  const framesDir = path.join(runDir, 'frames');
  await fs.mkdir(framesDir);
  await fs.writeFile(path.join(framesDir, 'frame-000001.png'), 'first');
  await fs.writeFile(path.join(framesDir, 'frame-000002.png'), 'second');
  await fs.writeFile(path.join(runDir, 'output.mp4'), 'rendered');

  const startedAt = new Date(Date.now() - 20_000).toISOString();
  const updatedAt = new Date(Date.now() - 10_000).toISOString();
  const latestFrame = {
    index: 2,
    capturedAt: updatedAt,
    path: 'frames/frame-000002.png',
    status: 'captured',
  };

  await fs.writeFile(path.join(runDir, 'config.json'), `${JSON.stringify({
    expectedFrames: 5,
    intervalSeconds: 1,
    fps: 24,
  }, null, 2)}\n`);
  await fs.writeFile(path.join(runDir, 'status.json'), `${JSON.stringify({
    state: 'running',
    startedAt,
    updatedAt,
    framesAttempted: 3,
    framesCaptured: 2,
    framesFailed: 1,
    expectedFrames: 5,
    latestFrame,
    output: path.join(runDir, 'output.mp4'),
  }, null, 2)}\n`);
  await fs.writeFile(path.join(runDir, 'latest-frame.json'), `${JSON.stringify(latestFrame, null, 2)}\n`);

  try {
    const jsonResult = runCli(['status', runDir, '--json']);
    assert.equal(jsonResult.status, 0, jsonResult.stderr);
    const payload = JSON.parse(jsonResult.stdout);

    assert.equal(payload.frames.captured, 2);
    assert.equal(payload.frames.failed, 1);
    assert.equal(payload.frames.totalExpected, 5);
    assert.ok(payload.elapsedMs >= 0);
    assert.ok(payload.etaMs > 0);
    assert.equal(payload.staleWarning.isStale, true);
    assert.ok(payload.diskUsage.runDirBytes > payload.diskUsage.framesBytes);
    assert.equal(payload.diskUsage.framesBytes, 11);

    const humanResult = runCli(['status', runDir]);
    assert.equal(humanResult.status, 0, humanResult.stderr);
    assert.match(humanResult.stdout, /State: running/);
    assert.match(humanResult.stdout, /Elapsed:/);
    assert.match(humanResult.stdout, /ETA:/);
    assert.match(humanResult.stdout, /Warning: latest successful frame is stale/);
    assert.match(humanResult.stdout, /Run disk use:/);
    assert.match(humanResult.stdout, /Frame disk use:/);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});
