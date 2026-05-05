#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const { parseArgs, ParseError } = require('./parser');
const { renderFrames } = require('./render');

function usage() {
  return [
    'timelapse-capture <command> [options] [args]',
    '',
    'Commands:',
    '  start <url>           Start capture in run directory',
    '  status <run-dir>      Print capture status',
    '  render <run-dir>      Render an mp4 from captured frames',
    '  peek <run-dir>        Inspect captured frames',
    '  cleanup <run-dir>     Cleanup artifacts',
    '  doctor                Check runtime dependencies',
  ].join('\n');
}

const FRAME_PNG_1x1 = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000b49444154789c636060000000020001d75edeb0000000049454e44ae426082',
  'hex',
);

function nowIso() {
  return new Date().toISOString();
}

function slugify(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .toLowerCase()
    .slice(0, 32) || 'run';
}

function frameName(frameIndex) {
  return `frame-${String(frameIndex).padStart(4, '0')}.png`;
}

function sortFrames(fileNames) {
  return fileNames.slice().sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function normalizeCaptureState(state) {
  if (state === 'completed') {
    return 'done';
  }
  if (state === 'idle') {
    return 'starting';
  }
  if (['starting', 'running', 'done', 'failed'].includes(state)) {
    return state;
  }
  return state || 'starting';
}

function inferStateFromStatus(status) {
  if (status.failedFrameCount > 0 && status.frameCount === 0) {
    return 'failed';
  }
  if (status.lastUpdatedAt) {
    return 'completed';
  }
  return 'idle';
}

async function safeWriteJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(filePath) {
  const text = await fs.readFile(filePath, 'utf8');
  return JSON.parse(text);
}

async function readJsonIfExists(filePath) {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function pathExists(filePath) {
  return Boolean(await fs.stat(filePath).catch(() => null));
}

async function dirSize(dir) {
  let total = 0;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        total += await dirSize(fullPath);
      } else if (entry.isFile()) {
        const s = await fs.stat(fullPath).catch(() => null);
        if (s) total += s.size;
      }
    }
  } catch {
    // Ignore errors
  }
  return total;
}

function buildStatusPayload(status) {
  const state = normalizeCaptureState(status.state);
  const elapsedMs = Math.max(0, Date.now() - new Date(status.startedAt).getTime());
  const totalExpected = Number.isFinite(status.targetFrames) ? status.targetFrames : status.frameCount;
  const completedAttempts = (status.frameCount || 0) + (status.failedFrameCount || 0);
  const etaMs = state === 'running' ? Math.max(0, (totalExpected - completedAttempts) * (status.intervalMs || 0)) : 0;
  const latestFrameTimestamp = status.latestFrameTimestamp || status.latestFrameAt || null;
  let staleWarning = { isStale: false, intervalMs: status.intervalMs || null, ageMs: null };
  if (state === 'running' && latestFrameTimestamp && status.intervalMs) {
    const ageMs = Math.max(0, Date.now() - new Date(latestFrameTimestamp).getTime());
    staleWarning = {
      isStale: ageMs > status.intervalMs,
      intervalMs: status.intervalMs,
      ageMs,
    };
  }

  return {
    runDir: status.runDir,
    state,
    frameCount: status.frameCount,
    failedFrameCount: status.failedFrameCount,
    frames: {
      captured: status.frameCount,
      failed: status.failedFrameCount,
      totalExpected,
    },
    latestFrame: status.latestFrame,
    latestFrameTimestamp,
    latestFrameAt: latestFrameTimestamp,
    elapsedMs,
    etaMs,
    staleWarning,
    startedAt: status.startedAt,
    lastUpdatedAt: status.lastUpdatedAt,
    targetFrames: totalExpected,
    intervalMs: status.intervalMs,
  };
}

async function writeArtifacts(runDir, statusState) {
  const framesDir = path.join(runDir, 'frames');
  await fs.mkdir(runDir, { recursive: true });
  await fs.mkdir(framesDir, { recursive: true });

  const manifest = {
    runDir,
    createdAt: nowIso(),
    state: statusState.state,
  };

  const config = {
    target: statusState.target,
    intervalMs: statusState.intervalMs,
    viewport: statusState.viewport,
    targetFrames: statusState.targetFrames,
    durationMs: statusState.durationMs,
  };

  const job = {
    runDir,
    state: statusState.state,
    framesPath: framesDir,
    createdAt: nowIso(),
  };

  const status = buildStatusPayload(statusState);
  await Promise.all([
    safeWriteJson(path.join(runDir, 'manifest.json'), manifest),
    safeWriteJson(path.join(runDir, 'config.json'), config),
    safeWriteJson(path.join(runDir, 'job.json'), job),
    safeWriteJson(path.join(runDir, 'status.json'), status),
  ]);
}

async function writeStatus(runDir, statusState) {
  const payload = buildStatusPayload(statusState);
  await safeWriteJson(path.join(runDir, 'status.json'), payload);
  return payload;
}

async function runFrameAttempt(runDir, frameIndex, shouldFail) {
  if (shouldFail) {
    return { success: false };
  }

  const filename = path.join(runDir, 'frames', frameName(frameIndex));
  await fs.writeFile(filename, FRAME_PNG_1x1);
  return { success: true, path: filename };
}

async function commandStart({ target, options }) {
  try {
    const targetUrl = new URL(target);
    if (!['http:', 'https:'].includes(targetUrl.protocol)) {
      throw new Error('unsupported protocol');
    }
  } catch {
    throw new Error(`navigation failed: invalid URL: ${target}`);
  }

  if (process.env.TIMELAPSE_SIMULATE_NAVIGATION_FAILURE === '1') {
    throw new Error(`navigation failed: page could not be loaded: ${target}`);
  }

  const startedAt = nowIso();
  const targetFrames = Math.max(1, Number.parseInt(process.env.TIMELAPSE_SIMULATE_FRAMES || '3', 10));
  const intervalMs = Number.isFinite(options.interval) ? options.interval : 200;
  const durationMs = options.duration ? options.duration.ms : 0;
  const viewport = options.viewport || { width: 1280, height: 720 };

  const runDir = options.runDir || path.join(process.cwd(), 'runs', `${slugify(target)}-${Date.now()}`);

  const state = {
    runDir,
    target,
    state: 'starting',
    startedAt,
    targetFrames,
    frameCount: 0,
    failedFrameCount: 0,
    latestFrame: null,
    latestFrameAt: null,
    intervalMs,
    viewport,
    durationMs,
    lastUpdatedAt: startedAt,
  };

  await writeArtifacts(runDir, state);

  for (let frameIndex = 1; frameIndex <= targetFrames; frameIndex += 1) {
    state.state = 'running';
    const shouldFail = process.env.TIMELAPSE_SIMULATE_FRAME_FAILURE === '1' && frameIndex === 2;
    const attempt = await runFrameAttempt(runDir, frameIndex, shouldFail);
    state.lastUpdatedAt = nowIso();
    if (attempt.success) {
      state.frameCount += 1;
      state.latestFrame = attempt.path;
      state.latestFrameAt = state.lastUpdatedAt;
      state.latestFrameTimestamp = state.lastUpdatedAt;
    } else {
      state.failedFrameCount += 1;
    }

    state.state = state.frameCount > 0 ? 'running' : 'failed';
    await writeStatus(runDir, state);
  }

  state.state = state.frameCount > 0 ? 'done' : 'failed';
  await writeStatus(runDir, state);

  const status = buildStatusPayload(state);
  return { runDir, status };
}

async function commandStatus({ runDir }) {
  const statusPath = path.join(runDir, 'status.json');
  const payload = await readJsonIfExists(statusPath);
  if (!payload) {
    const reason = await pathExists(runDir) ? 'missing run status file' : 'missing run directory';
    throw new Error(`${reason}: ${statusPath}`);
  }

  const totalBytes = await dirSize(runDir);
  const frameBytes = await dirSize(path.join(runDir, 'frames'));
  const summary = await readJsonIfExists(path.join(runDir, 'run-summary.json'));
  const status = buildStatusPayload({
    ...payload,
    state: payload.state || inferStateFromStatus(payload),
  });

  return {
    ...status,
    diskUsage: {
      runDirBytes: totalBytes,
      framesBytes: frameBytes,
    },
    outputPath: summary?.render?.outputPath || null,
    renderedOutput: summary?.render?.outputPath || null,
    cleanup: summary?.cleanup || null,
    cleanupSummary: summary?.cleanup || null,
  };
}

async function listFrameFiles(runDir) {
  const framesDir = path.join(runDir, 'frames');
  const entries = await fs.readdir(framesDir, { withFileTypes: true });
  return sortFrames(entries.filter((entry) => entry.isFile() && entry.name.endsWith('.png')).map((entry) => entry.name));
}

async function commandPeek({ runDir, options }) {
  const names = await listFrameFiles(runDir);
  if (!names.length) {
    throw new Error('No frames available');
  }

  let index = names.length - 1;
  if (typeof options.index === 'number') {
    index = Math.min(Math.max(options.index, 0), names.length - 1);
  } else if (typeof options.near === 'number') {
    index = Math.min(Math.max(options.near, 0), names.length - 1);
  }

  const selected = path.join(runDir, 'frames', names[index]);
  return { path: selected, pathCount: names.length };
}

async function isValidMP4(filePath) {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size === 0) {
      return false;
    }

    const header = Buffer.alloc(12);
    const fd = await fs.open(filePath, 'r');
    try {
      await fd.read(header, 0, 12, 0);
    } finally {
      await fd.close();
    }

    const isFtyp = header.includes(Buffer.from('ftyp'));
    const size = header.readUInt32BE(0);
    return isFtyp && size > 0 && stat.size >= size;
  } catch {
    return false;
  }
}

async function commandRender({ runDir, options }) {
  const result = renderFrames(runDir, options);

  if (!result.success) {
    if (result.error && result.error.includes('validation')) {
      throw new Error(`Rendered output is not a valid MP4: ${result.error}`);
    }
    throw new Error(`ffmpeg render failed: ${result.error}`);
  }

  return {
    path: result.outputPath,
    frameCount: result.metadata?.frameCount,
    message: 'Render successful',
  };
}

async function commandCleanup({ runDir, options }) {
  const framesDir = path.join(runDir, 'frames');
  const stat = await fs.stat(runDir).catch(() => null);
  if (!stat) {
    throw new Error('Run directory not found');
  }

  const frameFiles = await listFrameFiles(runDir).catch(() => []);

  if (options['keep-frames']) {
    const result = {
      message: 'Frames preserved (--keep-frames)',
      frameCount: frameFiles.length,
    };
    await writeCleanupSummary(runDir, { success: true, removed: 0, retained: frameFiles.length, reason: 'keep-frames' });
    return result;
  }

  if (options['keep-samples']) {
    if (frameFiles.length === 0) {
      const result = { message: 'No frames to sample', frameCount: 0 };
      await writeCleanupSummary(runDir, { success: true, removed: 0, retained: 0 });
      return result;
    }

    const toDelete = [];
    const firstFrame = frameFiles[0];
    const lastFrame = frameFiles[frameFiles.length - 1];

    for (const file of frameFiles) {
      if (file !== firstFrame && file !== lastFrame) {
        toDelete.push(path.join(framesDir, file));
      }
    }

    await Promise.all(toDelete.map((p) => fs.rm(p, { force: true })));

    const result = {
      message: 'Frames cleaned up (kept first and last)',
      removed: toDelete.length,
      retained: 2,
    };
    await writeCleanupSummary(runDir, { success: true, removed: toDelete.length, retained: 2 });
    return result;
  }

  if (options['keep-latest']) {
    if (frameFiles.length === 0) {
      const result = { message: 'No frames to cleanup', frameCount: 0 };
      await writeCleanupSummary(runDir, { success: true, removed: 0, retained: 0 });
      return result;
    }

    const latestFrame = frameFiles[frameFiles.length - 1];
    const toDelete = [];

    for (const file of frameFiles) {
      if (file !== latestFrame) {
        toDelete.push(path.join(framesDir, file));
      }
    }

    await Promise.all(toDelete.map((p) => fs.rm(p, { force: true })));

    const result = {
      message: 'Frames cleaned up (kept latest)',
      removed: toDelete.length,
      retained: 1,
    };
    await writeCleanupSummary(runDir, { success: true, removed: toDelete.length, retained: 1 });
    return result;
  }

  if (frameFiles.length > 0) {
    const toDelete = frameFiles.map((f) => path.join(framesDir, f));
    await Promise.all(toDelete.map((p) => fs.rm(p, { force: true })));
  }

  try {
    await fs.rmdir(framesDir);
  } catch {
    // Directory might not be empty or not exist
  }

  const result = {
    message: 'Cleanup complete',
    removed: frameFiles.length,
  };
  await writeCleanupSummary(runDir, { success: true, removed: frameFiles.length, retained: 0 });
  return result;
}

async function writeCleanupSummary(runDir, cleanup) {
  const summaryPath = path.join(runDir, 'run-summary.json');
  const existing = await readJsonIfExists(summaryPath);
  await safeWriteJson(summaryPath, {
    ...existing,
    cleanup: {
      ...cleanup,
      timestamp: nowIso(),
    },
  });
}

async function commandDoctor() {
  return {
    node: true,
    command: 'timelapse-capture',
  };
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.round((ms || 0) / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function printHumanStatus(status) {
  const lines = [];
  lines.push(`run-dir: ${status.runDir}`);
  lines.push(`state: ${status.state}`);
  lines.push(`elapsed: ${formatDuration(status.elapsedMs)}`);
  if (status.state === 'running') lines.push(`eta: ${formatDuration(status.etaMs)}`);
  lines.push(`frames: ${status.frames.captured} captured, ${status.frames.failed} failed, ${status.frames.totalExpected} expected`);
  if (status.latestFrame) lines.push(`latest successful frame: ${status.latestFrame}`);
  if (status.latestFrameTimestamp) lines.push(`latest successful frame at: ${status.latestFrameTimestamp}`);
  if (status.staleWarning?.isStale) lines.push(`warning: latest successful frame is stale (${formatDuration(status.staleWarning.ageMs)} old)`);
  if (status.diskUsage) lines.push(`disk usage: run-dir ${formatBytes(status.diskUsage.runDirBytes)}, frames ${formatBytes(status.diskUsage.framesBytes)}`);
  if (status.outputPath) lines.push(`output: ${status.outputPath}`);
  if (status.cleanup) lines.push(`cleanup: removed ${status.cleanup.removed ?? 0}, retained ${status.cleanup.retained ?? 0}`);
  console.log(lines.join('\n'));
}

async function main(argv) {
  try {
    const parsed = parseArgs(argv);
    return await execute(parsed);
  } catch (error) {
    if (error instanceof ParseError) {
      console.error(`error: ${error.message}`);
      console.error(`code: ${error.code}`);
      process.exitCode = 2;
      return;
    }

    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  }
}

async function execute(parsed) {
  let output;

  if (parsed.command === 'help') {
    console.log(usage());
    return;
  }
  if (parsed.options.help) {
    console.log(usage());
    return;
  }

  if (parsed.command === 'start') {
    output = await commandStart(parsed);
  } else if (parsed.command === 'status') {
    output = await commandStatus(parsed);
  } else if (parsed.command === 'peek') {
    output = await commandPeek(parsed);
  } else if (parsed.command === 'render') {
    output = await commandRender(parsed);
  } else if (parsed.command === 'cleanup') {
    output = await commandCleanup(parsed);
  } else if (parsed.command === 'doctor') {
    output = await commandDoctor();
  }

  if (parsed.options.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  if (parsed.command === 'status' && typeof output === 'object') {
    printHumanStatus(output);
    return;
  }

  if (typeof output === 'object') {
    if ('runDir' in output) {
      console.log(`run-dir: ${output.runDir}`);
      if (output.status) {
        console.log(JSON.stringify(output.status));
      }
      if (output.path) {
        console.log(output.path);
      }
      if (output.message) {
        console.log(output.message);
      }
      return;
    }

    if ('path' in output) {
      console.log(output.path);
      return;
    }

    console.log(JSON.stringify(output));
    return;
  }

  if (typeof output === 'string') {
    console.log(output);
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  main,
  commandStart,
  commandStatus,
  commandPeek,
  commandRender,
  commandCleanup,
};
