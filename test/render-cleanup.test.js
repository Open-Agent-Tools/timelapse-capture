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

  test('valid render writes metadata summary and deletes frames', async () => {
    const runDir = await createRunDir(tempDir);
    const framesDir = await createTestFrames(runDir, 3);

    const oldPath = process.env.PATH;
    try {
      await withFakeFFmpeg(async (manager) => {
        process.env.PATH = manager.getPATHEnv();

        const result = await commandRender({ runDir, options: {} });
        assert.strictEqual(result.path, path.join(runDir, 'output.mp4'));
        assert.strictEqual(result.frameCount, 3);

        await assert.rejects(fs.readdir(framesDir), /ENOENT/);
        const summary = JSON.parse(await fs.readFile(path.join(runDir, 'run-summary.json'), 'utf8'));
        assert.strictEqual(summary.render.outputPath, path.join(runDir, 'output.mp4'));
        assert(summary.render.bytes > 0);
        assert.strictEqual(summary.render.duration, 10);
        assert.deepStrictEqual(summary.render.dimensions, { width: 1280, height: 720 });
        assert.strictEqual(summary.render.sourceFrameCount, 3);
        assert.ok(Array.isArray(summary.render.ffmpegCommand), 'render.ffmpegCommand should be an array');
        assert.strictEqual(summary.render.ffmpegCommand[0], 'ffmpeg');
        assert.strictEqual(summary.duration, 10);
        assert.deepStrictEqual(summary.dimensions, { width: 1280, height: 720 });
        assert.ok(Array.isArray(summary.ffmpegCommand), 'ffmpegCommand should be an array');
        assert.strictEqual(summary.ffmpegCommand[0], 'ffmpeg');
        assert.strictEqual(summary.cleanup.success, true);
        assert.strictEqual(summary.cleanup.removed, 3);
      }, 'success');
    } finally {
      process.env.PATH = oldPath;
    }
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
        const summary = JSON.parse(await fs.readFile(path.join(runDir, 'run-summary.json'), 'utf8'));
        assert.strictEqual(summary.cleanup.reason, 'render-or-validation-failed');
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
        const summary = JSON.parse(await fs.readFile(path.join(runDir, 'run-summary.json'), 'utf8'));
        assert.match(summary.lastRenderAttempt.error, /not a valid MP4|MP4 validation failed/);
      }, 'invalid-output');
    } finally {
      process.env.PATH = oldPath;
    }
  });
});

// Render state safety tests
describe('render state safety checks', () => {
  let tempDir;

  before(async () => {
    tempDir = path.join('/tmp', `test-render-state-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('render blocks when state is running without --force', async () => {
    const runDir = await createRunDir(tempDir);
    const framesDir = await createTestFrames(runDir, 3);
    const statusPath = path.join(runDir, 'status.json');
    await fs.writeFile(statusPath, JSON.stringify({ state: 'running' }, null, 2));

    try {
      await commandRender({ runDir, options: {} });
      assert.fail('Should have thrown');
    } catch (error) {
      assert(error.message.includes('Cannot render while capture is active'));
    }
  });

  test('render with --force on active run preserves frames', async () => {
    const runDir = await createRunDir(tempDir);
    const framesDir = await createTestFrames(runDir, 3);
    const statusPath = path.join(runDir, 'status.json');
    await fs.writeFile(statusPath, JSON.stringify({ state: 'running' }, null, 2));

    const oldPath = process.env.PATH;
    try {
      await withFakeFFmpeg(async (manager) => {
        process.env.PATH = manager.getPATHEnv();

        const result = await commandRender({ runDir, options: { force: true } });
        assert.strictEqual(result.path, path.join(runDir, 'output.mp4'));

        const files = await fs.readdir(framesDir);
        assert.strictEqual(files.length, 3, 'frames should be preserved with --force on active run');
      }, 'success');
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

  test('cleanup --frames removes raw frames and latest.png', async () => {
    const runDir = await createRunDir(tempDir);
    const framesDir = await createTestFrames(runDir, 3);
    const latestPath = path.join(runDir, 'latest.png');
    const FRAME_PNG = Buffer.from(
      '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000b49444154789c636060000000020001d75edeb0000000049454e44ae426082',
      'hex',
    );
    await fs.writeFile(latestPath, FRAME_PNG);

    const result = await commandCleanup({ runDir, options: { frames: true } });

    assert.match(result.message, /Raw frames and latest.png cleaned up/);
    assert.strictEqual(result.removed, 3);

    const files = await fs.readdir(framesDir).catch(() => []);
    assert.strictEqual(files.length, 0, 'all frames should be deleted');
    const latestStat = await fs.stat(latestPath).catch(() => null);
    assert.strictEqual(latestStat, null, 'latest.png should be deleted');
  });

  test('cleanup --frames preserves MP4 and special images', async () => {
    const runDir = await createRunDir(tempDir);
    const framesDir = await createTestFrames(runDir, 3);
    const mp4Path = path.join(runDir, 'output.mp4');
    const posterPath = path.join(runDir, 'poster.png');
    const retainedPath = path.join(runDir, 'latest-retained.png');
    const FRAME_PNG = Buffer.from(
      '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000b49444154789c636060000000020001d75edeb0000000049454e44ae426082',
      'hex',
    );

    await fs.writeFile(mp4Path, Buffer.from('fake mp4'));
    await fs.writeFile(posterPath, FRAME_PNG);
    await fs.writeFile(retainedPath, FRAME_PNG);

    await commandCleanup({ runDir, options: { frames: true } });

    const mp4Stat = await fs.stat(mp4Path).catch(() => null);
    assert(mp4Stat, 'output.mp4 should be preserved');
    const posterStat = await fs.stat(posterPath).catch(() => null);
    assert(posterStat, 'poster.png should be preserved');
    const retainedStat = await fs.stat(retainedPath).catch(() => null);
    assert(retainedStat, 'latest-retained.png should be preserved');
  });

  test('cleanup --all removes entire run directory', async () => {
    const runDir = await createRunDir(tempDir);
    await createTestFrames(runDir, 3);
    await fs.writeFile(path.join(runDir, 'output.mp4'), Buffer.from('fake mp4'));

    const result = await commandCleanup({ runDir, options: { all: true, force: true } });

    assert.match(result.message, /Entire run directory deleted/);
    const stat = await fs.stat(runDir).catch(() => null);
    assert.strictEqual(stat, null, 'run directory should be deleted');
  });

  test('cleanup --all blocks without --force if frames exist', async () => {
    const runDir = await createRunDir(tempDir);
    await createTestFrames(runDir, 3);

    try {
      await commandCleanup({ runDir, options: { all: true } });
      assert.fail('Should have thrown');
    } catch (error) {
      assert(error.message.includes('Raw frames still exist'));
    }
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

  test('peek returns poster.png when frames are cleaned up', async () => {
    const runDir = await createRunDir(tempDir);
    const posterPath = path.join(runDir, 'poster.png');
    const FRAME_PNG = Buffer.from(
      '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000b49444154789c636060000000020001d75edeb0000000049454e44ae426082',
      'hex',
    );
    const framesDir = await createTestFrames(runDir, 3);
    await fs.writeFile(posterPath, FRAME_PNG);

    await commandCleanup({ runDir, options: { frames: true } });

    const result = await commandPeek({ runDir, options: {} });
    assert.strictEqual(result.path, posterPath);
  });

  test('peek returns latest-retained.png when no frames and no poster', async () => {
    const runDir = await createRunDir(tempDir);
    const retainedPath = path.join(runDir, 'latest-retained.png');
    const FRAME_PNG = Buffer.from(
      '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000b49444154789c636060000000020001d75edeb0000000049454e44ae426082',
      'hex',
    );
    const framesDir = await createTestFrames(runDir, 3);
    await fs.writeFile(retainedPath, FRAME_PNG);

    await commandCleanup({ runDir, options: { frames: true } });

    const result = await commandPeek({ runDir, options: {} });
    assert.strictEqual(result.path, retainedPath);
  });

  test('peek with no frames and no fallback images throws clear error', async () => {
    const runDir = await createRunDir(tempDir);
    await fs.mkdir(path.join(runDir, 'frames'), { recursive: true });

    try {
      await commandPeek({ runDir, options: {} });
      assert.fail('Should have thrown');
    } catch (error) {
      assert(error.message.includes('Raw frames were cleaned up'));
      assert(error.message.includes('poster.png'));
      assert(error.message.includes('latest-retained.png'));
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

      const summary = JSON.parse(await fs.readFile(path.join(runDir, 'run-summary.json'), 'utf8'));
      assert(typeof summary.duration === 'number' && summary.duration > 0, 'top-level duration should be a positive number');
      assert(typeof summary.dimensions?.width === 'number' && summary.dimensions.width > 0, 'dimensions.width should be a positive number');
      assert(typeof summary.dimensions?.height === 'number' && summary.dimensions.height > 0, 'dimensions.height should be a positive number');
      assert(Array.isArray(summary.ffmpegCommand), 'top-level ffmpegCommand should be an array');
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
