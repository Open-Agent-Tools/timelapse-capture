#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commandDoctor, formatDoctorHuman } from "./doctor.mjs";

const __filename = fileURLToPath(import.meta.url);
const VERSION = "0.1.0";

export const CANONICAL_STATES = Object.freeze([
  "starting",
  "running",
  "completed",
  "failed",
  "rendering",
  "rendered",
  "render_failed"
]);

const LEGACY_STATE_MIGRATIONS = Object.freeze({ done: "completed" });

export function migrateLegacyState(state) {
  if (state && Object.prototype.hasOwnProperty.call(LEGACY_STATE_MIGRATIONS, state)) {
    return LEGACY_STATE_MIGRATIONS[state];
  }
  return state;
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case "start":
      return startCommand(parseArgs(rest));
    case "capture":
      return captureCommand(parseArgs(rest));
    case "status":
      return statusCommand(parseArgs(rest), rest);
    case "peek":
      return peekCommand(parseArgs(rest), rest);
    case "render":
      return renderCommand(parseArgs(rest), rest);
    case "cleanup":
      return cleanupCommand(parseArgs(rest), rest);
    case "doctor":
      return doctorCommand(parseArgs(rest));
    case "help":
    case "--help":
    case "-h":
    case undefined:
      return printHelp();
    default:
      throw new Error(`Unknown command: ${command}\nRun "timelapse-capture help".`);
  }
}

async function startCommand(args) {
  const url = args.url ?? args._?.[0];
  if (!url) {
    throw new Error("Missing URL. Pass it positionally (start <url>) or via --url.");
  }
  args.url = url;

  const durationSeconds = parseDuration(required(args.duration, "--duration"));
  const fps = Number(args.fps ?? 24);
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error("--fps must be a positive number.");
  }

  let intervalSeconds;
  if (args.interval) {
    intervalSeconds = parseDuration(args.interval);
  } else if (args["video-length"]) {
    const videoLengthSeconds = parseDuration(args["video-length"]);
    const targetFrames = Math.max(1, Math.round(videoLengthSeconds * fps));
    intervalSeconds = durationSeconds / targetFrames;
  } else {
    throw new Error("Provide --interval or --video-length.");
  }

  if (intervalSeconds < 0.25) {
    throw new Error("Computed interval is below 250ms. Use a longer interval or shorter final video.");
  }

  const viewport = parseViewport(args.viewport ?? "1440x900");
  const outDir = path.resolve(args.out ?? defaultRunDir(args.url));
  const cleanup = args["keep-frames"] ? "never" : (args.cleanup ?? "after-render");
  if (!["after-render", "never"].includes(cleanup)) {
    throw new Error('--cleanup must be "after-render" or "never".');
  }

  await ensureDir(outDir);
  await ensureDir(path.join(outDir, "frames"));

  const config = {
    version: VERSION,
    backend: args.backend ?? "playwright-url",
    url: args.url,
    durationSeconds,
    intervalSeconds,
    expectedFrames: Math.ceil(durationSeconds / intervalSeconds),
    fps,
    viewport,
    outDir,
    cleanup,
    keepSamples: Number(args["keep-samples"] ?? 0),
    keepLatest: Boolean(args["keep-latest"]),
    waitUntil: args["wait-until"] ?? "domcontentloaded",
    headed: Boolean(args.headed),
    createdAt: new Date().toISOString()
  };

  await writeJsonAtomic(path.join(outDir, "config.json"), config);
  await writeJsonAtomic(path.join(outDir, "status.json"), {
    state: "starting",
    pid: null,
    startedAt: null,
    updatedAt: new Date().toISOString(),
    framesAttempted: 0,
    framesCaptured: 0,
    framesFailed: 0,
    latestFrame: null
  });

  const logFd = fs.openSync(path.join(outDir, "capture.log"), "a");
  const child = spawn(process.execPath, [__filename, "capture", "--run", outDir], {
    detached: true,
    stdio: ["ignore", logFd, logFd]
  });
  child.unref();
  fs.closeSync(logFd);

  await writeJsonAtomic(path.join(outDir, "job.json"), {
    pid: child.pid,
    command: [process.execPath, __filename, "capture", "--run", outDir],
    startedAt: new Date().toISOString()
  });

  const statusPath = path.join(outDir, "status.json");
  const status = await readJson(statusPath);
  status.pid = child.pid;
  if (status.state === "starting") {
    status.state = "running";
    status.startedAt = new Date().toISOString();
    status.updatedAt = status.startedAt;
  }
  await writeJsonAtomic(statusPath, status);

  console.log(`Started timelapse capture: ${outDir}`);
  console.log(`PID: ${child.pid}`);
  console.log(`Status: timelapse-capture status ${shellQuote(outDir)}`);
  console.log(`Peek:   timelapse-capture peek ${shellQuote(outDir)} --latest`);
}

async function captureCommand(args) {
  const runDir = path.resolve(required(args.run, "--run"));
  const config = await readJson(path.join(runDir, "config.json"));
  const framesDir = path.join(runDir, "frames");
  const manifestPath = path.join(runDir, "manifest.jsonl");
  const statusPath = path.join(runDir, "status.json");

  await ensureDir(framesDir);
  await appendLog(runDir, `capture started with backend=${config.backend}`);

  const startedAtMs = Date.now();
  const counters = {
    framesAttempted: 0,
    framesCaptured: 0,
    framesFailed: 0
  };

  let browser;
  let page;

  try {
    if (config.backend !== "playwright-url") {
      throw new Error(`Unsupported backend for MVP: ${config.backend}`);
    }

    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: !config.headed });
    page = await browser.newPage({ viewport: config.viewport });
    await page.goto(config.url, { waitUntil: config.waitUntil, timeout: 60_000 });

    await updateStatus(statusPath, {
      state: "running",
      pid: process.pid,
      startedAt: new Date(startedAtMs).toISOString(),
      updatedAt: new Date().toISOString(),
      expectedFrames: config.expectedFrames,
      ...counters
    });

    for (let index = 1; index <= config.expectedFrames; index += 1) {
      const scheduledAtMs = startedAtMs + Math.round((index - 1) * config.intervalSeconds * 1000);
      await sleepUntil(scheduledAtMs);

      counters.framesAttempted += 1;
      const scheduledAt = new Date(scheduledAtMs).toISOString();
      const frameName = `frame-${String(index).padStart(6, "0")}.png`;
      const relativePath = path.join("frames", frameName);
      const framePath = path.join(runDir, relativePath);
      const tempPath = path.join(framesDir, `.tmp-${process.pid}-${frameName}`);

      try {
        await page.screenshot({ path: tempPath, fullPage: false });
        await fsp.rename(tempPath, framePath);

        const capturedAt = new Date().toISOString();
        const title = await safePageTitle(page);
        const record = {
          index,
          scheduledAt,
          capturedAt,
          path: relativePath,
          status: "captured",
          url: page.url(),
          title,
          viewport: config.viewport,
          error: null
        };

        counters.framesCaptured += 1;
        await appendJsonLine(manifestPath, record);
        await writeLatestFrame(runDir, record, framePath);
        await updateStatus(statusPath, {
          state: "running",
          pid: process.pid,
          startedAt: new Date(startedAtMs).toISOString(),
          updatedAt: capturedAt,
          expectedFrames: config.expectedFrames,
          latestFrame: record,
          ...counters
        });
      } catch (error) {
        await removeIfExists(tempPath);
        counters.framesFailed += 1;
        const failedAt = new Date().toISOString();
        const record = {
          index,
          scheduledAt,
          capturedAt: null,
          path: null,
          status: "failed",
          url: page?.url?.() ?? config.url,
          title: await safePageTitle(page),
          viewport: config.viewport,
          error: error?.message || String(error)
        };
        await appendJsonLine(manifestPath, record);
        await updateStatus(statusPath, {
          state: "running",
          pid: process.pid,
          startedAt: new Date(startedAtMs).toISOString(),
          updatedAt: failedAt,
          expectedFrames: config.expectedFrames,
          latestFrame: null,
          ...counters
        });
      }
    }

    await updateStatus(statusPath, {
      state: "completed",
      pid: process.pid,
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expectedFrames: config.expectedFrames,
      ...counters
    });
    await appendLog(runDir, "capture completed");
  } catch (error) {
    await updateStatus(statusPath, {
      state: "failed",
      pid: process.pid,
      updatedAt: new Date().toISOString(),
      error: error?.message || String(error),
      ...counters
    });
    await appendLog(runDir, `capture failed: ${error?.stack || error}`);
    process.exitCode = 1;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

async function statusCommand(args, rawArgs) {
  const runDir = path.resolve(positionalRunDir(args, rawArgs));
  const rawStatus = await readJson(path.join(runDir, "status.json"));
  const status = { ...rawStatus, state: migrateLegacyState(rawStatus.state) };
  const config = await readJson(path.join(runDir, "config.json"));
  const latest = await readJsonOptional(path.join(runDir, "latest-frame.json"));
  const framesDir = path.join(runDir, "frames");
  const diskUsage = await directorySize(framesDir).catch(() => 0);

  const payload = {
    runDir,
    config,
    status,
    latestFrame: latest,
    framesDiskUsageBytes: diskUsage
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`Run: ${runDir}`);
  console.log(`State: ${status.state}`);
  console.log(`Frames: ${status.framesCaptured ?? 0} captured / ${status.framesAttempted ?? 0} attempted / ${status.framesFailed ?? 0} failed`);
  console.log(`Expected: ${config.expectedFrames}`);
  console.log(`Updated: ${status.updatedAt ?? "unknown"}`);
  console.log(`Latest: ${latest?.path ? path.join(runDir, latest.path) : "none"}`);
  console.log(`Frame disk use: ${formatBytes(diskUsage)}`);
  if (status.error) {
    console.log(`Error: ${status.error}`);
  }
}

async function peekCommand(args, rawArgs) {
  const runDir = path.resolve(positionalRunDir(args, rawArgs));
  let record;

  if (args.latest || (!args.index && !args.near)) {
    record = await readJsonOptional(path.join(runDir, "latest-frame.json"));
  } else {
    const records = await readManifest(path.join(runDir, "manifest.jsonl"));
    const captured = records.filter((item) => item.status === "captured" && item.path);
    if (args.index) {
      const index = Number(args.index);
      record = captured.find((item) => item.index === index);
    } else if (args.near) {
      const target = Date.parse(args.near);
      if (Number.isNaN(target)) {
        throw new Error(`Invalid --near timestamp: ${args.near}`);
      }
      record = captured.toSorted((a, b) => {
        return Math.abs(Date.parse(a.capturedAt) - target) - Math.abs(Date.parse(b.capturedAt) - target);
      })[0];
    }
  }

  if (!record?.path) {
    throw new Error("No matching captured frame is available yet.");
  }

  const absolutePath = path.join(runDir, record.path);
  const exists = fs.existsSync(absolutePath);
  const payload = { runDir, framePath: absolutePath, exists, frame: record };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(absolutePath);
  console.log(`Index: ${record.index}`);
  console.log(`Captured: ${record.capturedAt}`);
  console.log(`Exists: ${exists ? "yes" : "no"}`);
}

async function renderCommand(args, rawArgs) {
  const runDir = path.resolve(positionalRunDir(args, rawArgs));
  const config = await readJson(path.join(runDir, "config.json"));
  const manifest = await readManifest(path.join(runDir, "manifest.jsonl"));
  const captured = manifest.filter((record) => record.status === "captured" && record.path);
  if (captured.length === 0) {
    throw new Error("No captured frames found to render.");
  }

  const output = path.resolve(args.output ?? path.join(runDir, "output.mp4"));
  const stageDir = path.join(runDir, ".render-frames");
  const samplesDir = path.join(runDir, "samples");
  const renderLogPath = path.join(runDir, "render.log");

  await updateStatus(path.join(runDir, "status.json"), {
    state: "rendering",
    updatedAt: new Date().toISOString()
  });

  try {
    await removeDirIfExists(stageDir);
    await ensureDir(stageDir);

    const usableFrames = [];
    for (const record of captured) {
      const source = path.join(runDir, record.path);
      if (fs.existsSync(source)) {
        usableFrames.push({ record, source });
      }
    }

    if (usableFrames.length === 0) {
      throw new Error("Captured frame metadata exists, but no frame files are present.");
    }

    for (let index = 0; index < usableFrames.length; index += 1) {
      const target = path.join(stageDir, `frame-${String(index + 1).padStart(6, "0")}.png`);
      await linkOrCopy(usableFrames[index].source, target);
    }

    await ensureDir(path.dirname(output));
    const logFd = fs.openSync(renderLogPath, "a");
    const result = spawnSync("ffmpeg", [
      "-y",
      "-framerate",
      String(config.fps),
      "-start_number",
      "1",
      "-i",
      path.join(stageDir, "frame-%06d.png"),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      output
    ], {
      stdio: ["ignore", logFd, logFd]
    });
    fs.closeSync(logFd);

    if (result.error) {
      throw new Error(`ffmpeg failed to start: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(`ffmpeg exited with status ${result.status}. See ${renderLogPath}`);
    }

    const outputStat = await fsp.stat(output);
    if (outputStat.size === 0) {
      throw new Error(`Render output is empty: ${output}`);
    }

    await copyPosterAndSamples(runDir, usableFrames, config, samplesDir);

    let cleanupSummary = null;
    if (config.cleanup === "after-render") {
      cleanupSummary = await deleteFramesAfterRender(runDir);
    }

    await removeDirIfExists(stageDir);

    const summary = {
      renderedAt: new Date().toISOString(),
      output,
      fps: config.fps,
      sourceFrames: usableFrames.length,
      outputBytes: outputStat.size,
      cleanup: cleanupSummary
    };
    await writeJsonAtomic(path.join(runDir, "run-summary.json"), summary);
    await updateStatus(path.join(runDir, "status.json"), {
      state: "rendered",
      renderedAt: summary.renderedAt,
      updatedAt: summary.renderedAt,
      output
    });

    if (args.json) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    console.log(`Rendered: ${output}`);
    if (cleanupSummary) {
      console.log(`Cleaned frames: ${cleanupSummary.filesDeleted} files, ${formatBytes(cleanupSummary.bytesFreed)} freed`);
    }
  } catch (error) {
    await removeDirIfExists(stageDir);
    await updateStatus(path.join(runDir, "status.json"), {
      state: "render_failed",
      updatedAt: new Date().toISOString(),
      error: error?.message || String(error)
    });
    throw error;
  }
}

async function cleanupCommand(args, rawArgs) {
  const runDir = path.resolve(positionalRunDir(args, rawArgs));
  const outputPath = path.join(runDir, "output.mp4");
  if (!args.force && !fs.existsSync(outputPath)) {
    throw new Error("Refusing to delete frames before output.mp4 exists. Pass --force to override.");
  }

  const summary = await deleteFramesAfterRender(runDir);
  const existingSummary = await readJsonOptional(path.join(runDir, "run-summary.json")) ?? {};
  await writeJsonAtomic(path.join(runDir, "run-summary.json"), {
    ...existingSummary,
    manualCleanup: summary
  });
  console.log(`Cleaned frames: ${summary.filesDeleted} files, ${formatBytes(summary.bytesFreed)} freed`);
}

async function doctorCommand(args) {
  const result = await commandDoctor();

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatDoctorHuman(result));
  }

  if (result.exitCode) {
    process.exitCode = result.exitCode;
  }
}

function printHelp() {
  console.log(`timelapse-capture ${VERSION}

Usage:
  timelapse-capture start <url> --duration <2h> (--interval <5s> | --video-length <1m>) [--out <dir>]
  timelapse-capture status <run-dir> [--json]
  timelapse-capture peek <run-dir> [--latest | --index <n> | --near <iso>] [--json]
  timelapse-capture render <run-dir> [--output <file>] [--json]
  timelapse-capture cleanup <run-dir> [--force]
  timelapse-capture doctor [--json]

Examples:
  timelapse-capture start http://localhost:3000 --duration 2h --video-length 1m --fps 24
  timelapse-capture peek ./timelapse-runs/localhost-20260430-101500 --latest
`);
}

function parseArgs(tokens) {
  const args = { _: [] };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }

    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    const key = rawKey.trim();
    if (inlineValue !== undefined) {
      args[key] = inlineValue;
      continue;
    }

    const next = tokens[index + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function positionalRunDir(args, rawArgs) {
  if (args.run) {
    return args.run;
  }
  const positional = args._?.[0] ?? rawArgs.find((token) => !token.startsWith("--"));
  return required(positional, "<run-dir>");
}

function required(value, name) {
  if (value === undefined || value === null || value === "") {
    throw new Error(`Missing ${name}.`);
  }
  return value;
}

function parseDuration(input) {
  if (typeof input === "number") {
    return input;
  }
  const value = String(input).trim();
  const match = value.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/i);
  if (!match) {
    throw new Error(`Invalid duration: ${input}`);
  }
  const amount = Number(match[1]);
  const unit = (match[2] ?? "s").toLowerCase();
  const multipliers = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 };
  return amount * multipliers[unit];
}

function parseViewport(input) {
  const match = String(input).match(/^(\d+)x(\d+)$/i);
  if (!match) {
    throw new Error(`Invalid viewport "${input}". Use WIDTHxHEIGHT, such as 1440x900.`);
  }
  return {
    width: Number(match[1]),
    height: Number(match[2])
  };
}

function defaultRunDir(url) {
  const slug = slugify(url.replace(/^https?:\/\//, "").replace(/[:/]+/g, "-"));
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  return path.join(process.cwd(), "timelapse-runs", `${slug}-${stamp}`);
}

function slugify(input) {
  return String(input).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "capture";
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, "utf8"));
}

async function readJsonOptional(file) {
  try {
    return await readJson(file);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeJsonAtomic(file, data) {
  await ensureDir(path.dirname(file));
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(temp, `${JSON.stringify(data, null, 2)}\n`);
  await fsp.rename(temp, file);
}

async function updateStatus(statusPath, patch) {
  const current = await readJsonOptional(statusPath) ?? {};
  await writeJsonAtomic(statusPath, { ...current, ...patch });
}

async function appendJsonLine(file, data) {
  await fsp.appendFile(file, `${JSON.stringify(data)}\n`);
}

async function appendLog(runDir, message) {
  await fsp.appendFile(path.join(runDir, "capture.log"), `[${new Date().toISOString()}] ${message}\n`);
}

async function readManifest(file) {
  const text = await fsp.readFile(file, "utf8").catch((error) => {
    if (error?.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

async function writeLatestFrame(runDir, record, framePath) {
  await writeJsonAtomic(path.join(runDir, "latest-frame.json"), record);
  await fsp.copyFile(framePath, path.join(runDir, "latest.png"));
}

async function safePageTitle(page) {
  if (!page) {
    return null;
  }
  try {
    return await page.title();
  } catch {
    return null;
  }
}

async function sleepUntil(timestampMs) {
  const delay = timestampMs - Date.now();
  if (delay > 0) {
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

async function removeIfExists(file) {
  await fsp.rm(file, { force: true }).catch(() => {});
}

async function removeDirIfExists(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
}

async function directorySize(dir) {
  let total = 0;
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const itemPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(itemPath);
    } else if (entry.isFile()) {
      total += (await fsp.stat(itemPath)).size;
    }
  }
  return total;
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

async function linkOrCopy(source, target) {
  try {
    await fsp.link(source, target);
  } catch {
    await fsp.copyFile(source, target);
  }
}

async function copyPosterAndSamples(runDir, usableFrames, config, samplesDir) {
  const last = usableFrames.at(-1);
  if (last) {
    await fsp.copyFile(last.source, path.join(runDir, "poster.png"));
  }

  if (config.keepLatest && last) {
    await fsp.copyFile(last.source, path.join(runDir, "latest-retained.png"));
  }

  const keepSamples = Number(config.keepSamples ?? 0);
  if (keepSamples <= 0) {
    return;
  }

  await ensureDir(samplesDir);
  const count = Math.min(keepSamples, usableFrames.length);
  for (let index = 0; index < count; index += 1) {
    const sourceIndex = count === 1 ? usableFrames.length - 1 : Math.round(index * (usableFrames.length - 1) / (count - 1));
    const target = path.join(samplesDir, `sample-${String(index + 1).padStart(6, "0")}.png`);
    await fsp.copyFile(usableFrames[sourceIndex].source, target);
  }
}

async function deleteFramesAfterRender(runDir) {
  const framesDir = path.join(runDir, "frames");
  const beforeBytes = await directorySize(framesDir).catch(() => 0);
  const filesDeleted = await countFiles(framesDir).catch(() => 0);
  await removeDirIfExists(framesDir);
  await removeIfExists(path.join(runDir, "latest.png"));
  return {
    cleanedAt: new Date().toISOString(),
    framesDir,
    filesDeleted,
    bytesFreed: beforeBytes
  };
}

async function countFiles(dir) {
  let count = 0;
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const itemPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      count += await countFiles(itemPath);
    } else if (entry.isFile()) {
      count += 1;
    }
  }
  return count;
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}
