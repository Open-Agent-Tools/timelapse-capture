'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  commandStatus,
  commandPeek,
  validateMP4,
  commandCleanup
} = require('../src/timelapse-capture.mjs');

async function createRunDir() {
  const runDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tlc-err-prop-'));
  await fsp.writeFile(path.join(runDir, 'status.json'), JSON.stringify({ state: 'running', intervalMs: 1000 }, null, 2));
  return runDir;
}

test('commandStatus propagates non-ENOENT frame scan errors', async () => {
  const runDir = await createRunDir();
  const originalReaddir = fsp.readdir;

  try {
    fsp.readdir = async () => {
      const error = new Error('permission denied');
      error.code = 'EACCES';
      throw error;
    };

    await assert.rejects(() => commandStatus({ runDir }), /permission denied/);
  } finally {
    fsp.readdir = originalReaddir;
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test('commandStatus returns default disk usage for missing frames directory (ENOENT fallback)', async () => {
  const runDir = await createRunDir();

  try {
    const result = await commandStatus({ runDir });
    assert.equal(result.framesDiskUsageBytes, 0);
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test('commandPeek with --near surfaces non-ENOENT manifest read errors', async () => {
  const runDir = await createRunDir();
  const framesDir = path.join(runDir, 'frames');
  await fsp.mkdir(framesDir);
  await fsp.writeFile(path.join(framesDir, 'frame-000001.png'), Buffer.from('x'));

  const originalReadFile = fsp.readFile;
  const originalReaddir = fsp.readdir;
  try {
    fsp.readdir = async () => [
      {
        isFile: () => true,
        isDirectory: () => false,
        name: 'frame-000001.png'
      }
    ];

    fsp.readFile = async (file, encoding) => {
      if (file === path.join(runDir, 'manifest.jsonl')) {
        const error = new Error('permission denied');
        error.code = 'EACCES';
        throw error;
      }
      return originalReadFile(file, encoding);
    };

    await assert.rejects(
      () => commandPeek({ runDir, options: { near: '2026-01-01T00:00:00.000Z' } }),
      /permission denied/
    );
  } finally {
    fsp.readFile = originalReadFile;
    fsp.readdir = originalReaddir;
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test('commandPeek keeps ENOENT manifest behavior and reports no --near timestamps', async () => {
  const runDir = await createRunDir();
  const framesDir = path.join(runDir, 'frames');
  await fsp.mkdir(framesDir);
  await fsp.writeFile(path.join(framesDir, 'frame-000001.png'), Buffer.from('x'));

  try {
    await assert.rejects(
      () => commandPeek({ runDir, options: { near: '2026-01-01T00:00:00.000Z' } }),
      /No captured frame timestamps are available for --near\./
    );
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test('validateMP4 surfaces unexpected output file size errors', async () => {
  const runDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tlc-validate-'));
  const outputPath = path.join(runDir, 'output.mp4');
  await fsp.writeFile(outputPath, 'not-an-video');

  const originalStatSync = fs.statSync;
  try {
    fs.statSync = () => {
      const error = new Error('permission denied');
      error.code = 'EACCES';
      throw error;
    };

    const result = validateMP4(outputPath);
    assert.equal(result.exists, true);
    assert.match(result.error, /Failed to read output file size/);
    assert.match(result.error, /permission denied/);
  } finally {
    fs.statSync = originalStatSync;
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test('commandCleanup surfaces unexpected run directory stat errors', async () => {
  const runDir = await createRunDir();
  const originalStat = fsp.stat;

  try {
    fsp.stat = async () => {
      const error = new Error('permission denied');
      error.code = 'EACCES';
      throw error;
    };

    await assert.rejects(() => commandCleanup({ runDir, options: { force: true } }), /permission denied/);
  } finally {
    fsp.stat = originalStat;
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});
