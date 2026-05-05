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

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
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
        assert.match(summary.render.ffmpegCommand, /^ffmpeg /);
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

  test('active run render fails without --force', async () => {
    const runDir = await createRunDir(tempDir);
    const framesDir = await createTestFrames(runDir, 2);
    await writeJson(path.join(runDir, 'status.json'), {
      runDir,
      state: 'running',
      frameCount: 2,
      failedFrameCount: 0,
      startedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
    });

    await assert.rejects(
      commandRender({ runDir, options: {} }),
      /Cannot render while capture is active\. Use --force to override\./,
    );

    const files = await fs.readdir(framesDir);
    assert.strictEqual(files.length, 2);
  });

  test('forced active render preserves raw frames', async () => {
    const runDir = await createRunDir(tempDir);
    const framesDir = await createTestFrames(runDir, 2);
    await writeJson(path.join(runDir, 'status.json'), {
      runDir,
      state: 'running',
      frameCount: 2,
      failedFrameCount: 0,
      startedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
    });

    const oldPath = process.env.PATH;
    try {
      await withFakeFFmpeg(async (manager) => {
        process.env.PATH = manager.getPATHEnv();

        const result = await commandRender({ runDir, options: { force: true } });
        assert.strictEqual(result.path, path.join(runDir, 'output.mp4'));

        const files = await fs.readdir(framesDir);
        assert.strictEqual(files.length, 2);
        const summary = JSON.parse(await fs.readFile(path.join(runDir, 'run-summary.json'), 'utf8'));
        assert.strictEqual(summary.cleanup.reason, 'active-run-force-render');
        assert.strictEqual(summary.cleanup.removed, 0);
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

  test('--frames removes raw frames and latest.png but preserves rendered artifacts', async () => {
    const runDir = await createRunDir(tempDir);
    const framesDir = await createTestFrames(runDir, 3);
    await fs.writeFile(path.join(runDir, 'latest.png'), 'latest');
    await fs.writeFile(path.join(runDir, 'poster.png'), 'poster');
    await fs.writeFile(path.join(runDir, 'latest-retained.png'), 'retained');
    await fs.writeFile(path.join(runDir, 'output.mp4'), 'rendered');

    const result = await commandCleanup({ runDir, options: { frames: true } });

    assert.match(result.message, /Frame cleanup complete/);
    assert.strictEqual(result.removed, 4);
    assert.strictEqual(await fs.stat(framesDir).catch(() => null), null);
    await fs.access(path.join(runDir, 'output.mp4'));
    await fs.access(path.join(runDir, 'poster.png'));
    await fs.access(path.join(runDir, 'latest-retained.png'));
    assert.strictEqual(await fs.stat(path.join(runDir, 'latest.png')).catch(() => null), null);
  });

  test('--frames validates configured custom output path', async () => {
    const runDir = await createRunDir(tempDir);
    await createTestFrames(runDir, 2);
    const outputPath = path.join(runDir, 'video', 'custom.mp4');
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, 'rendered');
    await writeJson(path.join(runDir, 'config.json'), { output: { path: outputPath } });

    const result = await commandCleanup({ runDir, options: { frames: true } });

    assert.strictEqual(result.outputPath, outputPath);
    await fs.access(outputPath);
    assert.strictEqual(await fs.stat(path.join(runDir, 'output.mp4')).catch(() => null), null);
  });

  test('--frames requires rendered output unless forced', async () => {
    const runDir = await createRunDir(tempDir);
    await createTestFrames(runDir, 2);

    await assert.rejects(
      commandCleanup({ runDir, options: { frames: true } }),
      /Rendered output not found/,
    );

    const result = await commandCleanup({ runDir, options: { frames: true, force: true } });
    assert.strictEqual(result.removed, 2);
  });

  test('--all requires force when raw frames remain and deletes run directory with force', async () => {
    const runDir = await createRunDir(tempDir);
    await createTestFrames(runDir, 2);

    await assert.rejects(
      commandCleanup({ runDir, options: { all: true } }),
      /cleanup --all is destructive/,
    );

    const result = await commandCleanup({ runDir, options: { all: true, force: true } });
    assert.strictEqual(result.removedRunDir, true);
    assert.strictEqual(await fs.stat(runDir).catch(() => null), null);
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

  test('peek returns poster after frame cleanup', async () => {
    const runDir = await createRunDir(tempDir);
    await createTestFrames(runDir, 2);
    const posterPath = path.join(runDir, 'poster.png');
    await fs.writeFile(posterPath, 'poster');
    await fs.writeFile(path.join(runDir, 'output.mp4'), 'rendered');

    await commandCleanup({ runDir, options: { frames: true } });

    const result = await commandPeek({ runDir, options: {} });
    assert.strictEqual(result.path, posterPath);
    assert.strictEqual(result.pathCount, 0);
  });

  test('peek returns latest-retained after frame cleanup when poster is absent', async () => {
    const runDir = await createRunDir(tempDir);
    await createTestFrames(runDir, 2);
    const retainedPath = path.join(runDir, 'latest-retained.png');
    await fs.writeFile(retainedPath, 'retained');
    await fs.writeFile(path.join(runDir, 'output.mp4'), 'rendered');

    await commandCleanup({ runDir, options: { frames: true } });

    const result = await commandPeek({ runDir, options: {} });
    assert.strictEqual(result.path, retainedPath);
    assert.strictEqual(result.pathCount, 0);
  });

  test('peek after frame cleanup gives clear error when no fallback exists', async () => {
    const runDir = await createRunDir(tempDir);
    await createTestFrames(runDir, 2);
    await fs.writeFile(path.join(runDir, 'output.mp4'), 'rendered');

    await commandCleanup({ runDir, options: { frames: true } });

    await assert.rejects(
      commandPeek({ runDir, options: {} }),
      /No frames available\. Raw frames were cleaned up\./,
    );
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
