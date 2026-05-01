const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');

const { commandStatus } = require('../src/cli/index');

async function createTempRunDir(overrides = {}) {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'timelapse-status-'));
  const framesDir = path.join(runDir, 'frames');
  await fs.mkdir(framesDir, { recursive: true });

  const baseStatus = {
    runDir,
    state: 'running',
    frameCount: 1,
    failedFrameCount: 0,
    latestFrame: path.join(framesDir, 'frame-0001.png'),
    elapsedMs: 1000,
    etaMs: 2000,
    startedAt: new Date(Date.now() - 1000).toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    targetFrames: 5,
    intervalMs: 500,
    latestFrameAt: new Date().toISOString(),
    staleWarning: false,
    diskUsageBytes: 0,
    framesDiskUsageBytes: 0,
    renderedOutputPath: null,
    cleanupSummary: null,
    ...overrides,
  };

  await fs.writeFile(path.join(runDir, 'status.json'), JSON.stringify(baseStatus, null, 2));
  return { runDir, baseStatus };
}

test('commandStatus includes targetFrames and intervalMs', async () => {
  const { runDir, baseStatus } = await createTempRunDir();
  try {
    const result = await commandStatus({ runDir });
    assert.equal(result.targetFrames, baseStatus.targetFrames);
    assert.equal(result.intervalMs, baseStatus.intervalMs);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test('commandStatus includes latestFrameAt', async () => {
  const { runDir, baseStatus } = await createTempRunDir();
  try {
    const result = await commandStatus({ runDir });
    assert.ok(result.latestFrameAt !== undefined);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test('commandStatus computes staleWarning when capture is stale', async () => {
  const { runDir } = await createTempRunDir({
    state: 'running',
    latestFrameAt: new Date(Date.now() - 3000).toISOString(),
    intervalMs: 500,
  });
  try {
    const result = await commandStatus({ runDir });
    assert.ok(result.staleWarning);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test('commandStatus does not warn when capture is fresh', async () => {
  const { runDir } = await createTempRunDir({
    state: 'running',
    latestFrameAt: new Date().toISOString(),
    intervalMs: 500,
  });
  try {
    const result = await commandStatus({ runDir });
    assert.ok(!result.staleWarning);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test('commandStatus includes disk usage bytes', async () => {
  const { runDir } = await createTempRunDir();
  try {
    await fs.writeFile(
      path.join(runDir, 'frames', 'frame-0001.png'),
      Buffer.alloc(100),
    );
    const result = await commandStatus({ runDir });
    assert.equal(typeof result.diskUsageBytes, 'number');
    assert.ok(result.diskUsageBytes >= 0);
    assert.equal(typeof result.framesDiskUsageBytes, 'number');
    assert.ok(result.framesDiskUsageBytes >= 0);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test('commandStatus includes renderedOutputPath and cleanupSummary from run-summary.json', async () => {
  const { runDir } = await createTempRunDir();
  try {
    const runSummary = {
      render: { outputPath: '/tmp/output.mp4' },
      cleanup: { removed: 3 },
    };
    await fs.writeFile(
      path.join(runDir, 'run-summary.json'),
      JSON.stringify(runSummary, null, 2),
    );
    const result = await commandStatus({ runDir });
    assert.equal(result.renderedOutputPath, '/tmp/output.mp4');
    assert.deepEqual(result.cleanupSummary, { removed: 3 });
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test('commandStatus defaults to null for renderedOutputPath and cleanupSummary when run-summary.json is missing', async () => {
  const { runDir } = await createTempRunDir();
  try {
    const result = await commandStatus({ runDir });
    assert.equal(result.renderedOutputPath, null);
    assert.equal(result.cleanupSummary, null);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test('commandStatus throws clear error for missing run directory', async () => {
  const nonexistentDir = path.join(os.tmpdir(), 'nonexistent-run-' + Date.now());
  try {
    await commandStatus({ runDir: nonexistentDir });
    assert.fail('expected error');
  } catch (error) {
    assert.match(error.message, /not found|no such file/i);
  }
});
