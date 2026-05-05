'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const { commandRender, commandStatus } = require('../src/cli/index');
const { withFakeFFmpeg } = require('./helpers/fake-ffmpeg');

const CLI_PATH = path.join(__dirname, '..', 'src', 'cli', 'index.js');

const FRAME_PNG_1x1 = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000b49444154789c636060000000020001d75edeb0000000049454e44ae426082',
  'hex',
);

async function makeRunDirWithFrames(count) {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tlc-vocab-'));
  const framesDir = path.join(runDir, 'frames');
  await fs.mkdir(framesDir, { recursive: true });
  for (let i = 1; i <= count; i += 1) {
    await fs.writeFile(path.join(framesDir, `frame-${String(i).padStart(4, '0')}.png`), FRAME_PNG_1x1);
  }
  return runDir;
}

async function readStatus(runDir) {
  return JSON.parse(await fs.readFile(path.join(runDir, 'status.json'), 'utf8'));
}

test('commandRender writes "rendered" state on success', async () => {
  const runDir = await makeRunDirWithFrames(3);
  const oldPath = process.env.PATH;
  try {
    await withFakeFFmpeg(async (manager) => {
      process.env.PATH = manager.getPATHEnv();
      await commandRender({ runDir, options: {} });
      const status = await readStatus(runDir);
      assert.strictEqual(status.state, 'rendered');
      assert.ok(status.renderedAt, 'renderedAt should be set');
    }, 'success');
  } finally {
    process.env.PATH = oldPath;
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test('commandRender writes "render_failed" state on ffmpeg failure', async () => {
  const runDir = await makeRunDirWithFrames(3);
  const oldPath = process.env.PATH;
  try {
    await withFakeFFmpeg(async (manager) => {
      process.env.PATH = manager.getPATHEnv();
      await assert.rejects(
        commandRender({ runDir, options: {} }),
        /render failed/,
      );
      const status = await readStatus(runDir);
      assert.strictEqual(status.state, 'render_failed');
      assert.ok(status.renderError, 'renderError should be set');
    }, 'fail');
  } finally {
    process.env.PATH = oldPath;
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test('commandRender writes "render_failed" state on invalid MP4 output', async () => {
  const runDir = await makeRunDirWithFrames(3);
  const oldPath = process.env.PATH;
  try {
    await withFakeFFmpeg(async (manager) => {
      process.env.PATH = manager.getPATHEnv();
      await assert.rejects(
        commandRender({ runDir, options: {} }),
        /not a valid MP4/,
      );
      const status = await readStatus(runDir);
      assert.strictEqual(status.state, 'render_failed');
    }, 'invalid-output');
  } finally {
    process.env.PATH = oldPath;
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test('commandStatus normalizes legacy "done" state to "completed"', async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tlc-vocab-legacy-'));
  try {
    await fs.writeFile(path.join(runDir, 'status.json'), `${JSON.stringify({
      runDir,
      state: 'done',
      frameCount: 3,
      failedFrameCount: 0,
      latestFrame: null,
      intervalMs: 1000,
      targetFrames: 3,
      startedAt: new Date(Date.now() - 5000).toISOString(),
      lastUpdatedAt: new Date().toISOString(),
    })}\n`);

    const status = await commandStatus({ runDir });
    assert.strictEqual(status.state, 'completed');
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test('grep guard: no "done" state is written by the CLI', () => {
  const result = spawnSync('grep', ['-RIn', "'done'", CLI_PATH], { encoding: 'utf8' });
  const matches = (result.stdout || '').split('\n').filter(Boolean);
  const writeSites = matches.filter((line) => /\.state\s*=\s*'done'|state:\s*'done'|return\s*'done'/.test(line));
  assert.deepStrictEqual(
    writeSites,
    [],
    `Expected no write site for legacy 'done' state, found:\n${writeSites.join('\n')}`,
  );
});
