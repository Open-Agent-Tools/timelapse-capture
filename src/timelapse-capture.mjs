#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const VERSION = "0.1.0";

class ParseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ParseError";
    this.code = code;
  }
}

const COMMAND_SCHEMAS = {
  start: {
    positionals: ["url"],
    valueFlags: [
      "url",
      "duration",
      "interval",
      "video-length",
      "fps",
      "viewport",
      "out",
      "cleanup",
      "keep-samples",
      "wait-until",
      "backend"
    ],
    boolFlags: ["headed", "json", "keep-frames", "keep-latest", "help"]
  },
  capture: {
    positionals: [],
    valueFlags: ["run"],
    boolFlags: ["help"]
  },
  status: {
    positionals: ["runDir"],
    valueFlags: [],
    boolFlags: ["json", "help"]
  },
  peek: {
    positionals: ["runDir"],
    valueFlags: ["index", "near"],
    boolFlags: ["latest", "json", "help"]
  },
  render: {
    positionals: ["runDir"],
    valueFlags: ["output"],
    boolFlags: ["json", "force", "help"]
  },
  cleanup: {
    positionals: ["runDir"],
    valueFlags: [],
    boolFlags: ["force", "frames", "all", "help"]
  },
  doctor: {
    positionals: [],
    valueFlags: [],
    boolFlags: ["json", "help"]
  }
};

const isMainModule = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMainModule) {
  main().catch((error) => {
    if (error instanceof ParseError) {
      console.error(`error: ${error.message}`);
      console.error(`code: ${error.code}`);
      process.exitCode = 2;
      return;
    }
    console.error(error?.message || String(error));
    process.exitCode = 1;
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const [rawCommand] = argv;

  if (!rawCommand || rawCommand === "help" || rawCommand === "--help" || rawCommand === "-h") {
    return printHelp();
  }

  const parsed = parseArgs(argv);
  if (parsed.options.help) {
    return printHelp();
  }

  switch (parsed.command) {
    case "start":
      return startCommand(parsed);
    case "capture":
      return captureCommand(parsed);
    case "status":
      return statusCommand(parsed);
    case "peek":
      return peekCommand(parsed);
    case "render":
      return renderCommand(parsed);
    case "cleanup":
      return cleanupCommand(parsed);
    case "doctor":
      return doctorCommand(parsed);
    default:
      throw new ParseError("E_UNKNOWN_COMMAND", `Unknown command: ${parsed.command}`);
  }
}

async function startCommand(parsed) {
  const args = parsed.options;
  const url = parsed.positionals[0] ?? args.url;
  if (!url) {
    throw new ParseError("E_MISSING_ARGUMENT", "Missing <url>. Usage: timelapse-capture start <url> --duration <d> (--interval <i> | --video-length <l>)");
  }

  const durationValue = args.duration;
  if (!durationValue) {
    throw new ParseError("E_MISSING_VALUE", "Missing --duration.");
  }
  const durationSeconds = typeof durationValue === "object" && durationValue !== null
    ? durationValue.ms / 1000
    : parseDurationSeconds(durationValue);
  const fps = Number(args.fps ?? 24);
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new ParseError("E_BAD_VALUE", "--fps must be a positive number.");
  }

  let intervalSeconds;
  if (args.interval !== undefined) {
    intervalSeconds = typeof args.interval === "number" ? args.interval / 1000 : parseDurationSeconds(args.interval);
  } else if (args["video-length"]) {
    const videoLengthSeconds = parseDurationSeconds(args["video-length"]);
    const targetFrames = Math.max(1, Math.round(videoLengthSeconds * fps));
    intervalSeconds = durationSeconds / targetFrames;
  } else {
    throw new ParseError("E_MISSING_VALUE", "Provide --interval or --video-length.");
  }

  if (intervalSeconds < 0.25) {
    throw new ParseError("E_BAD_INTERVAL", "Computed interval is below 250ms. Use a longer interval or shorter final video.");
  }

  const viewport = typeof args.viewport === "object" && args.viewport !== null
    ? { width: args.viewport.width, height: args.viewport.height }
    : parseViewport(args.viewport ?? "1440x900");
  const outDir = path.resolve(args.out ?? defaultRunDir(url));
  const cleanup = args["keep-frames"] ? "never" : (args.cleanup ?? "after-render");
  if (!["after-render", "never"].includes(cleanup)) {
    throw new ParseError("E_BAD_VALUE", '--cleanup must be "after-render" or "never".');
  }

  await ensureDir(outDir);
  await ensureDir(path.join(outDir, "frames"));

  const config = {
    version: VERSION,
    backend: args.backend ?? "playwright-url",
    url,
    durationSeconds,
    intervalSeconds,
    intervalMs: Math.round(intervalSeconds * 1000),
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

  if (args.json) {
    const payload = {
      runDir: outDir,
      pid: child.pid,
      url,
      startedAt: status.startedAt,
      statusCommand: ["timelapse-capture", "status", outDir],
      peekCommand: ["timelapse-capture", "peek", outDir, "--latest"]
    };
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`Started timelapse capture: ${outDir}`);
  console.log(`PID: ${child.pid}`);
  console.log(`Status: timelapse-capture status ${shellQuote(outDir)}`);
  console.log(`Peek:   timelapse-capture peek ${shellQuote(outDir)} --latest`);
}

async function captureCommand(parsed) {
  const args = parsed.options;
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

async function statusCommand(parsed) {
  const args = parsed.options;
  const runDir = path.resolve(parsed.positionals[0] ?? args.run ?? required(undefined, "<run-dir>"));
  const status = await readJson(path.join(runDir, "status.json"));
  const config = await readJson(path.join(runDir, "config.json"));
  const latest = await readJsonOptional(path.join(runDir, "latest-frame.json"));
  const summary = await readJsonOptional(path.join(runDir, "run-summary.json"));
  const framesDir = path.join(runDir, "frames");
  const framesBytes = await directorySize(framesDir).catch(() => 0);
  const runDirBytes = await directorySize(runDir).catch(() => 0);

  const payload = buildStatusPayload({
    runDir,
    config,
    status,
    latest,
    summary,
    framesBytes,
    runDirBytes
  });

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  printHumanStatus(payload);
}

async function peekCommand(parsed) {
  const args = parsed.options;
  const runDir = path.resolve(parsed.positionals[0] ?? required(undefined, "<run-dir>"));
  let record;

  const indexValue = args.index;
  const nearValue = args.near;

  if (args.latest || (indexValue === undefined && nearValue === undefined)) {
    record = await readJsonOptional(path.join(runDir, "latest-frame.json"));
  } else {
    const records = await readManifest(path.join(runDir, "manifest.jsonl"));
    const captured = records.filter((item) => item.status === "captured" && item.path);
    if (indexValue !== undefined) {
      const index = Number(indexValue);
      record = captured.find((item) => item.index === index);
    } else if (nearValue !== undefined) {
      const target = Date.parse(nearValue);
      if (Number.isNaN(target)) {
        throw new ParseError("E_BAD_VALUE", `Invalid --near timestamp: ${nearValue}`);
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
  const payload = {
    runDir,
    framePath: absolutePath,
    path: absolutePath,
    exists,
    frame: record
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(absolutePath);
  console.log(`Index: ${record.index}`);
  console.log(`Captured: ${record.capturedAt}`);
  console.log(`Exists: ${exists ? "yes" : "no"}`);
}

async function renderCommand(parsed) {
  const args = parsed.options;
  const runDir = path.resolve(parsed.positionals[0] ?? required(undefined, "<run-dir>"));
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

async function cleanupCommand(parsed) {
  const args = parsed.options;
  const runDir = path.resolve(parsed.positionals[0] ?? required(undefined, "<run-dir>"));
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

function printHelp() {
  console.log(`timelapse-capture ${VERSION}

Usage:
  timelapse-capture start --url <url> --duration <2h> (--interval <5s> | --video-length <1m>) [--out <dir>]
  timelapse-capture status <run-dir> [--json]
  timelapse-capture peek <run-dir> [--latest | --index <n> | --near <iso>] [--json]
  timelapse-capture render <run-dir> [--output <file>] [--json]
  timelapse-capture cleanup <run-dir> [--force]

Examples:
  timelapse-capture start --url http://localhost:3000 --duration 2h --video-length 1m --fps 24
  timelapse-capture peek ./timelapse-runs/localhost-20260430-101500 --latest
`);
}

function parseArgs(argv = process.argv.slice(2)) {
  const tokens = Array.isArray(argv) ? [...argv] : [];
  if (tokens.length === 0) {
    return { command: "help", options: {}, positionals: [] };
  }

  const command = tokens[0];
  if (command === "help" || command === "--help" || command === "-h") {
    return { command: "help", options: {}, positionals: [] };
  }

  const schema = COMMAND_SCHEMAS[command];
  if (!schema) {
    throw new ParseError("E_UNKNOWN_COMMAND", `Unknown command: ${command}`);
  }

  const options = {};
  const positionals = [];
  const rest = tokens.slice(1);

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];

    if (token === "--") {
      positionals.push(...rest.slice(index + 1));
      break;
    }

    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--no-")) {
      const key = token.slice(5);
      if (!schema.boolFlags.includes(key)) {
        throw new ParseError("E_UNKNOWN_FLAG", `Unknown flag for ${command}: ${token}`);
      }
      options[key] = false;
      continue;
    }

    let key;
    let inlineValue;
    if (token.startsWith("--")) {
      const eqIndex = token.indexOf("=");
      if (eqIndex >= 0) {
        key = token.slice(2, eqIndex);
        inlineValue = token.slice(eqIndex + 1);
      } else {
        key = token.slice(2);
      }
    } else {
      throw new ParseError("E_UNKNOWN_FLAG", `Unknown flag format: ${token}`);
    }

    if (schema.boolFlags.includes(key)) {
      if (inlineValue !== undefined) {
        throw new ParseError("E_BAD_VALUE", `Boolean flag --${key} does not accept a value`);
      }
      options[key] = true;
      continue;
    }

    if (!schema.valueFlags.includes(key)) {
      throw new ParseError("E_UNKNOWN_FLAG", `Unknown flag for ${command}: --${key}`);
    }

    let value = inlineValue;
    if (value === undefined) {
      const next = rest[index + 1];
      if (next === undefined || next.startsWith("-")) {
        throw new ParseError("E_MISSING_VALUE", `Missing value for --${key}`);
      }
      value = next;
      index += 1;
    }

    options[key] = parseValueFlag(key, value);
  }

  if (positionals.length > schema.positionals.length) {
    throw new ParseError("E_EXTRA_ARGUMENT", `Too many positional arguments for ${command}`);
  }

  const result = { command, options, positionals };
  if (schema.positionals[0] === "url" && positionals[0]) {
    result.target = positionals[0];
  }
  if (schema.positionals[0] === "runDir" && positionals[0]) {
    result.runDir = positionals[0];
  }
  return result;
}

function parseValueFlag(flag, value) {
  if (value === undefined || value === "") {
    throw new ParseError("E_MISSING_VALUE", `Missing value for --${flag}`);
  }

  if (flag === "duration" || flag === "video-length") {
    return parseDuration(value);
  }

  if (flag === "interval") {
    const parsed = parseDuration(value);
    if (parsed.ms === 0) {
      throw new ParseError("E_BAD_INTERVAL", `Invalid interval: ${value}`);
    }
    return parsed.ms;
  }

  if (flag === "viewport") {
    return parseViewport(value);
  }

  if (flag === "fps" || flag === "keep-samples") {
    if (!/^\d+$/.test(value)) {
      throw new ParseError("E_BAD_VALUE", `Invalid numeric value for --${flag}: ${value}`);
    }
    return Number.parseInt(value, 10);
  }

  if (flag === "index") {
    if (!/^\d+$/.test(value)) {
      throw new ParseError("E_BAD_INDEX", `Invalid numeric value for --${flag}: ${value}`);
    }
    return Number.parseInt(value, 10);
  }

  return value;
}

function required(value, name) {
  if (value === undefined || value === null || value === "") {
    throw new ParseError("E_MISSING_ARGUMENT", `Missing ${name}.`);
  }
  return value;
}

function parseDurationSeconds(input) {
  const parsed = parseDuration(input);
  if (typeof parsed === "object" && parsed !== null && typeof parsed.ms === "number") {
    return parsed.ms / 1000;
  }
  return parsed;
}

function parseDuration(input) {
  if (typeof input === "number") {
    return { input: String(input), ms: Math.round(input * 1000) };
  }
  if (input === null || input === undefined) {
    throw new ParseError("E_BAD_DURATION", `Invalid duration: ${input}`);
  }
  const value = String(input).trim();
  if (value === "") {
    throw new ParseError("E_BAD_DURATION", `Invalid duration: ${input}`);
  }
  const compoundMatch = value.toLowerCase().match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?(?:(\d+)ms)?$/);
  const decimalMatch = value.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/i);

  if (compoundMatch && compoundMatch.slice(1).some((part) => part !== undefined)) {
    const hours = Number.parseInt(compoundMatch[1] || "0", 10);
    const minutes = Number.parseInt(compoundMatch[2] || "0", 10);
    const seconds = Number.parseInt(compoundMatch[3] || "0", 10);
    const ms = Number.parseInt(compoundMatch[4] || "0", 10);
    const total = (hours * 3_600_000) + (minutes * 60_000) + (seconds * 1000) + ms;
    return { input: value, ms: total };
  }

  if (decimalMatch) {
    const amount = Number(decimalMatch[1]);
    const unit = decimalMatch[2].toLowerCase();
    const multipliers = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    return { input: value, ms: Math.round(amount * multipliers[unit]) };
  }

  throw new ParseError("E_BAD_DURATION", `Invalid duration: ${input}`);
}

function parseViewport(input) {
  if (input === null || input === undefined) {
    throw new ParseError("E_BAD_VIEWPORT", `Invalid viewport: ${input}`);
  }
  const value = String(input);
  const match = value.match(/^(\d+)x(\d+)$/i);
  if (!match) {
    throw new ParseError("E_BAD_VIEWPORT", `Invalid viewport: ${input}`);
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width <= 0 || height <= 0) {
    throw new ParseError("E_BAD_VIEWPORT", `Invalid viewport: ${input}`);
  }
  return { input: value, width, height };
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

function buildStatusPayload({ runDir, config, status, latest, summary, framesBytes, runDirBytes }) {
  const state = status.state ?? "starting";
  const startedAtMs = status.startedAt ? new Date(status.startedAt).getTime() : Date.now();
  const elapsedMs = Math.max(0, Date.now() - startedAtMs);
  const intervalMs = config.intervalMs ?? Math.round((config.intervalSeconds ?? 0) * 1000);
  const totalExpected = Number.isFinite(config.expectedFrames) ? config.expectedFrames : (status.framesAttempted ?? 0);
  const captured = status.framesCaptured ?? 0;
  const failed = status.framesFailed ?? 0;
  const completedAttempts = captured + failed;

  let etaMs = 0;
  if (state === "running" && intervalMs > 0) {
    etaMs = Math.max(0, (totalExpected - completedAttempts) * intervalMs);
  }

  const latestFramePath = latest?.path ? path.join(runDir, latest.path) : null;
  const latestFrameTimestamp = latest?.capturedAt ?? null;

  let staleWarning = { isStale: false, intervalMs: intervalMs || null, ageMs: null };
  if (state === "running" && latestFrameTimestamp && intervalMs > 0) {
    const ageMs = Math.max(0, Date.now() - new Date(latestFrameTimestamp).getTime());
    staleWarning = {
      isStale: ageMs > intervalMs,
      intervalMs,
      ageMs
    };
  }

  return {
    runDir,
    state,
    frameCount: captured,
    failedFrameCount: failed,
    frames: {
      captured,
      failed,
      totalExpected
    },
    targetFrames: totalExpected,
    intervalMs,
    latestFrame: latestFramePath,
    latestFrameTimestamp,
    elapsedMs,
    etaMs,
    staleWarning,
    diskUsage: {
      runDirBytes,
      framesBytes
    },
    startedAt: status.startedAt ?? null,
    updatedAt: status.updatedAt ?? null,
    outputPath: summary?.output ?? summary?.render?.outputPath ?? null,
    cleanup: summary?.cleanup ?? null,
    error: status.error ?? null
  };
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.round((ms || 0) / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function printHumanStatus(payload) {
  const lines = [];
  lines.push(`run-dir: ${payload.runDir}`);
  lines.push(`state: ${payload.state}`);
  lines.push(`elapsed: ${formatDuration(payload.elapsedMs)}`);
  if (payload.state === "running") {
    lines.push(`eta: ${formatDuration(payload.etaMs)}`);
  }
  lines.push(`frames: ${payload.frames.captured} captured, ${payload.frames.failed} failed, ${payload.frames.totalExpected} expected`);
  if (payload.latestFrame) {
    lines.push(`latest successful frame: ${payload.latestFrame}`);
  }
  if (payload.latestFrameTimestamp) {
    lines.push(`latest successful frame at: ${payload.latestFrameTimestamp}`);
  }
  if (payload.staleWarning?.isStale) {
    lines.push(`warning: latest successful frame is stale (${formatDuration(payload.staleWarning.ageMs)} old)`);
  }
  lines.push(`disk usage: run-dir ${formatBytes(payload.diskUsage.runDirBytes)}, frames ${formatBytes(payload.diskUsage.framesBytes)}`);
  if (payload.outputPath) {
    lines.push(`output: ${payload.outputPath}`);
  }
  if (payload.cleanup) {
    const removed = payload.cleanup.filesDeleted ?? payload.cleanup.removed ?? 0;
    const retained = payload.cleanup.retained ?? 0;
    lines.push(`cleanup: removed ${removed}, retained ${retained}`);
  }
  if (payload.error) {
    lines.push(`error: ${payload.error}`);
  }
  console.log(lines.join("\n"));
}

async function doctorCommand(parsed) {
  const args = parsed?.options ?? {};
  const checks = [];

  const nodeMajor = Number.parseInt((process.version ?? "v0").replace(/^v/, "").split(".")[0], 10);
  checks.push({
    name: "node",
    ok: nodeMajor >= 20,
    detail: process.version,
    required: true
  });

  let playwrightOk = false;
  let playwrightDetail = null;
  try {
    const mod = await import("playwright");
    playwrightOk = Boolean(mod?.chromium);
    playwrightDetail = playwrightOk ? "playwright module loaded" : "playwright module did not export chromium";
  } catch (error) {
    playwrightDetail = `playwright import failed: ${error?.message ?? String(error)}`;
  }
  checks.push({ name: "playwright", ok: playwrightOk, detail: playwrightDetail, required: true });

  let chromiumOk = false;
  let chromiumDetail = "skipped (playwright unavailable)";
  if (playwrightOk) {
    try {
      const { chromium } = await import("playwright");
      const browser = await chromium.launch({ headless: true });
      chromiumOk = true;
      chromiumDetail = "chromium launched";
      await browser.close().catch(() => {});
    } catch (error) {
      chromiumDetail = `chromium launch failed: ${error?.message ?? String(error)}`;
    }
  }
  checks.push({ name: "chromium", ok: chromiumOk, detail: chromiumDetail, required: true });

  const ffmpegResult = spawnSync("ffmpeg", ["-version"], { stdio: ["ignore", "pipe", "pipe"] });
  checks.push({
    name: "ffmpeg",
    ok: ffmpegResult.status === 0,
    detail: ffmpegResult.error ? ffmpegResult.error.message : (ffmpegResult.status === 0 ? "ffmpeg available" : `ffmpeg exited ${ffmpegResult.status}`),
    required: true
  });

  const ffprobeResult = spawnSync("ffprobe", ["-version"], { stdio: ["ignore", "pipe", "pipe"] });
  checks.push({
    name: "ffprobe",
    ok: ffprobeResult.status === 0,
    detail: ffprobeResult.error ? ffprobeResult.error.message : (ffprobeResult.status === 0 ? "ffprobe available" : `ffprobe exited ${ffprobeResult.status}`),
    required: true
  });

  const allRequiredOk = checks.filter((check) => check.required).every((check) => check.ok);

  if (args.json) {
    console.log(JSON.stringify({ ok: allRequiredOk, checks }, null, 2));
  } else {
    for (const check of checks) {
      const symbol = check.ok ? "ok" : "fail";
      console.log(`[${symbol}] ${check.name}: ${check.detail}`);
    }
    console.log(`\n${allRequiredOk ? "All required checks passed." : "Some required checks failed."}`);
  }

  if (!allRequiredOk) {
    process.exitCode = 1;
  }
  return { ok: allRequiredOk, checks };
}

export {
  ParseError,
  parseArgs,
  parseDuration,
  parseViewport,
  buildStatusPayload,
  startCommand,
  captureCommand,
  statusCommand,
  peekCommand,
  renderCommand,
  cleanupCommand,
  doctorCommand,
  main
};
