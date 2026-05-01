#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const { parseArgs, ParseError } = require('./parser');

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

function buildStatusPayload(status) {
  const elapsedMs = Math.max(0, Date.now() - new Date(status.startedAt).getTime());
  const etaMs = Math.max(0, (status.targetFrames - status.frameCount) * status.intervalMs);

  return {
    runDir: status.runDir,
    state: status.state,
    frameCount: status.frameCount,
    failedFrameCount: status.failedFrameCount,
    latestFrame: status.latestFrame,
    elapsedMs,
    etaMs,
    startedAt: status.startedAt,
    lastUpdatedAt: status.lastUpdatedAt,
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
  const startedAt = nowIso();
  const targetFrames = Math.max(1, Number.parseInt(process.env.TIMELAPSE_SIMULATE_FRAMES || '3', 10));
  const intervalMs = Number.isFinite(options.interval) ? options.interval : 200;
  const durationMs = options.duration ? options.duration.ms : 0;
  const viewport = options.viewport || { width: 1280, height: 720 };

  const runDir = options.runDir || path.join(process.cwd(), 'runs', `${slugify(target)}-${Date.now()}`);

  const state = {
    runDir,
    target,
    state: 'completed',
    startedAt,
    targetFrames,
    frameCount: 0,
    failedFrameCount: 0,
    latestFrame: null,
    intervalMs,
    viewport,
    durationMs,
    lastUpdatedAt: startedAt,
  };

  await writeArtifacts(runDir, state);

  for (let frameIndex = 1; frameIndex <= targetFrames; frameIndex += 1) {
    const shouldFail = process.env.TIMELAPSE_SIMULATE_FRAME_FAILURE === '1' && frameIndex === 2;
    const attempt = await runFrameAttempt(runDir, frameIndex, shouldFail);
    state.lastUpdatedAt = nowIso();
    if (attempt.success) {
      state.frameCount += 1;
      state.latestFrame = attempt.path;
    } else {
      state.failedFrameCount += 1;
    }

    state.state = state.frameCount > 0 ? 'completed' : 'failed';
    await writeStatus(runDir, state);
  }

  const status = buildStatusPayload(state);
  return { runDir, status };
}

async function commandStatus({ runDir }) {
  const statusPath = path.join(runDir, 'status.json');
  const payload = await readJson(statusPath);
  return {
    ...payload,
    state: payload.state || inferStateFromStatus(payload),
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

async function commandDoctor() {
  return {
    node: true,
    command: 'timelapse-capture',
  };
}

async function main(argv) {
  try {
    const parsed = parseArgs(argv);
    return execute(parsed);
  } catch (error) {
    if (error instanceof ParseError) {
      console.error(`error: ${error.message}`);
      console.error(`code: ${error.code}`);
      process.exitCode = 2;
      return;
    }

    throw error;
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
    output = { message: 'not implemented yet' };
  } else if (parsed.command === 'cleanup') {
    output = { message: 'not implemented yet' };
  } else if (parsed.command === 'doctor') {
    output = await commandDoctor();
  }

  if (parsed.options.json) {
    console.log(JSON.stringify(output, null, 2));
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
};
