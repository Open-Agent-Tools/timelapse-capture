'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');
const { commandRender, commandCleanup, commandPeek } = require('../src/cli/index');
const { withFakeFFmpeg, hasRealFFmpeg } = require('./helpers/fake-ffmpeg');

// Helper to create test frames
async function createTestFrames(runDir, count = 3) {
  const framesDir = path.join(runDir, 'frames');
  await fs.mkdir(framesDir, { recursive: true });

  const FRAME_PNG_1x1 = Buffer.from(
    '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000b49444154789c636060000000020001d75edeb0000000049454e44ae426082',
    'hex',
  );

  for (let i = 1; i <= count; i += 1) {
    const frameName = `frame-${String(i).padStart(4, '0')}.png`;
    await fs.writeFile(path.join(framesDir, frameName), FRAME_PNG_1x1);
  }

  return framesDir;
}

// Helper to create a run directory structure
async function createRunDir(tempDir) {
  const runDir = path.join(tempDir, `run-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(runDir, { recursive: true });
  return runDir;
}

// Fake ffmpeg tests
describe('render with fake ffmpeg', () => {
  let tempDir;

  before(async () => {
    tempDir = path.join('/tmp', `test-render-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('render failure preserves frames', async () => {
    const runDir = await createRunDir(tempDir);
    const framesDir = await createTestFrames(runDir, 3);

    const oldPath = process.env.PATH;
    try {
      await withFakeFFmpeg(async (manager) => {
        process.env.PATH = manager.getPATHEnv();

        try {
          await commandRender({ runDir, options: {} });
          assert.fail('Should have thrown');
        } catch (error) {
          assert(error.message.includes('render failed'));
        }

        const files = await fs.readdir(framesDir);
        assert.strictEqual(files.length, 3, 'frames should be preserved after render failure');
      }, 'fail');
    } finally {
      process.env.PATH = oldPath;
    }
  });

  test('invalid output preserves frames', async () => {
    const runDir = await createRunDir(tempDir);
    const framesDir = await createTestFrames(runDir, 3);

    const oldPath = process.env.PATH;
    try {
      await withFakeFFmpeg(async (manager) => {
        process.env.PATH = manager.getPATHEnv();

        try {
          await commandRender({ runDir, options: {} });
          assert.fail('Should have thrown');
        } catch (error) {
          assert(error.message.includes('not a valid MP4'));
        }

        const files = await fs.readdir(framesDir);
        assert.strictEqual(files.length, 3, 'frames should be preserved after invalid output');
      }, 'invalid-output');
    } finally {
      process.env.PATH = oldPath;
    }
  });
});

// Cleanup tests
describe('cleanup command', () => {
  let tempDir;

  before(async () => {
    tempDir = path.join('/tmp', `test-cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('--keep-frames preserves all frames', async () => {
    const runDir = await createRunDir(tempDir);
    const framesDir = await createTestFrames(runDir, 3);

    const result = await commandCleanup({ runDir, options: { 'keep-frames': true } });

    assert.match(result.message, /Frames preserved/);
    assert.strictEqual(result.frameCount, 3);

    const files = await fs.readdir(framesDir);
    assert.strictEqual(files.length, 3);
  });

  test('--keep-samples keeps first and last', async () => {
    const runDir = await createRunDir(tempDir);
    const framesDir = await createTestFrames(runDir, 5);

    const result = await commandCleanup({ runDir, options: { 'keep-samples': true } });

    assert.match(result.message, /kept first and last/);
    assert.strictEqual(result.removed, 3);
    assert.strictEqual(result.retained, 2);

    const files = await fs.readdir(framesDir);
    assert.strictEqual(files.length, 2);
    assert(files.includes('frame-0001.png'));
    assert(files.includes('frame-0005.png'));
  });

  test('--keep-latest keeps only last frame', async () => {
    const runDir = await createRunDir(tempDir);
    const framesDir = await createTestFrames(runDir, 5);

    const result = await commandCleanup({ runDir, options: { 'keep-latest': true } });

    assert.match(result.message, /kept latest/);
    assert.strictEqual(result.removed, 4);
    assert.strictEqual(result.retained, 1);

    const files = await fs.readdir(framesDir);
    assert.strictEqual(files.length, 1);
    assert(files.includes('frame-0005.png'));
  });

  test('default cleanup removes all frames', async () => {
    const runDir = await createRunDir(tempDir);
    const framesDir = await createTestFrames(runDir, 3);

    const result = await commandCleanup({ runDir, options: {} });

    assert.strictEqual(result.removed, 3);

    const stat = await fs.stat(framesDir).catch(() => null);
    assert.strictEqual(stat, null, 'frames directory should be removed');
  });

  test('cleanup with no frames returns gracefully', async () => {
    const runDir = await createRunDir(tempDir);
    await fs.mkdir(path.join(runDir, 'frames'), { recursive: true });

    const result = await commandCleanup({ runDir, options: {} });

    assert.match(result.message, /Cleanup complete/);
    assert.strictEqual(result.removed, 0);
  });
});

// Peek behavior tests
describe('peek after cleanup', () => {
  let tempDir;

  before(async () => {
    tempDir = path.join('/tmp', `test-peek-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('peek returns retained frame with --keep-latest', async () => {
    const runDir = await createRunDir(tempDir);
    await createTestFrames(runDir, 3);

    await commandCleanup({ runDir, options: { 'keep-latest': true } });

    const result = await commandPeek({ runDir, options: {} });
    assert(result.path.includes('frame-0003.png'));
    assert.strictEqual(result.pathCount, 1);
  });

  test('peek with no frames throws error', async () => {
    const runDir = await createRunDir(tempDir);
    await fs.mkdir(path.join(runDir, 'frames'), { recursive: true });

    try {
      await commandPeek({ runDir, options: {} });
      assert.fail('Should have thrown');
    } catch (error) {
      assert.match(error.message, /No frames/);
    }
  });

  test('peek --latest works with kept samples', async () => {
    const runDir = await createRunDir(tempDir);
    await createTestFrames(runDir, 5);

    await commandCleanup({ runDir, options: { 'keep-samples': true } });

    const result = await commandPeek({ runDir, options: { latest: true } });
    assert(result.path.includes('frame-0005.png'));
    assert.strictEqual(result.pathCount, 2);
  });
});

// Real ffmpeg tests (skip if binaries unavailable)
if (hasRealFFmpeg()) {
  describe('render with real ffmpeg', () => {
    let tempDir;

    before(async () => {
      tempDir = path.join('/tmp', `test-real-ffmpeg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await fs.mkdir(tempDir, { recursive: true });
    });

    after(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    test('real ffmpeg renders valid MP4', async () => {
      const runDir = await createRunDir(tempDir);
      await createTestFrames(runDir, 3);

      const result = await commandRender({ runDir, options: {} });

      assert(result.path.endsWith('output.mp4'));
      assert.strictEqual(result.frameCount, 3);

      const stat = await fs.stat(result.path);
      assert(stat.size > 0);
    });

    test('real ffmpeg with cleanup flow', async () => {
      const runDir = await createRunDir(tempDir);
      const framesDir = await createTestFrames(runDir, 3);

      await commandRender({ runDir, options: {} });

      const cleanupResult = await commandCleanup({ runDir, options: {} });
      assert.strictEqual(cleanupResult.removed, 3);

      const dirStat = await fs.stat(framesDir).catch(() => null);
      assert.strictEqual(dirStat, null);
    });
  });
} else {
  test('real ffmpeg tests skipped (ffmpeg/ffprobe not found)', () => {
    assert.ok(true);
  });
}
