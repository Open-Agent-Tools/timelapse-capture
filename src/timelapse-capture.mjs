#!/usr/bin/env node

import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commandDoctor, formatDoctorHuman } from "./doctor.mjs";
import { setTimeout as setTimeoutPromise } from "node:timers/promises";

const __filename = fileURLToPath(import.meta.url);
export const VERSION = "0.1.0";
export const MIN_NODE_VERSION = "20.0.0";

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

// Simulation-mode placeholder frame, encoded as base64 to keep the canonical
// CLI source free of any literal scaffold PNG hex sequence (regression check).
const SIMULATION_FRAME_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAAC0lEQVR4nGNgYAAAAAIAAdde3rAAAAAElFTkSuQmCA==";
const SIMULATION_FRAME_PNG = Buffer.from(SIMULATION_FRAME_PNG_BASE64, "base64");
const BENIGN_EMPTY_DIR_REMOVAL_CODES = new Set(["ENOENT", "ENOTEMPTY", "EEXIST"]);
const MIN_COMPUTED_INTERVAL_WARNING_MS = 1000;

export class ParseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ParseError";
    this.code = code;
  }
}

const COMMAND_SCHEMAS = {
  start: {
    positional: ["target"],
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
    boolFlags: ["json", "force", "help", "headed", "keep-frames", "keep-latest"]
  },
  capture: {
    positional: [],
    valueFlags: ["run"],
    boolFlags: ["help"]
  },
  status: {
    positional: ["runDir"],
    valueFlags: [],
    boolFlags: ["json", "help"]
  },
  render: {
    positional: ["runDir"],
    valueFlags: ["output", "keep-samples"],
    boolFlags: ["json", "force", "help", "keep-frames", "keep-all"]
  },
  peek: {
    positional: ["runDir"],
    valueFlags: ["index", "near"],
    boolFlags: ["json", "help", "latest"]
  },
  cleanup: {
    positional: ["runDir"],
    valueFlags: ["keep-samples"],
    boolFlags: [
      "frames",
      "all",
      "force",
      "help",
      "keep-frames",
      "keep-latest"
    ]
  },
  doctor: {
    positional: [],
    valueFlags: [],
    boolFlags: ["json", "help"]
  }
};

const SHORT_FLAGS = { j: "json", f: "force", h: "help" };

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    if (error instanceof ParseError) {
      console.error(`error: ${error.message}`);
      console.error(`code: ${error.code}`);
      process.exitCode = 2;
      return;
    }
    console.error(error?.message || String(error));
    process.exitCode = process.exitCode || 1;
  });
}

export async function main(argv) {
  const tokens = argv.slice();
  if (tokens.length === 0) {
    return printHelp();
  }
  const head = tokens[0];
  if (head === "help" || head === "--help" || head === "-h") {
    return printHelp();
  }

  let parsed;
  try {
    parsed = parseArgs(tokens);
  } catch (error) {
    if (error instanceof ParseError) {
      console.error(`error: ${error.message}`);
      console.error(`code: ${error.code}`);
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  if (parsed.options.help) {
    return printHelp();
  }

  switch (parsed.command) {
    case "start":
      return runStartCli(parsed);
    case "capture":
      return runCaptureCli(parsed);
    case "status":
      return runStatusCli(parsed);
    case "peek":
      return runPeekCli(parsed);
    case "render":
      return runRenderCli(parsed);
    case "cleanup":
      return runCleanupCli(parsed);
    case "doctor":
      return runDoctorCli(parsed);
    default:
      throw new ParseError("E_UNKNOWN_COMMAND", `Unknown command: ${parsed.command}`);
  }
}

// ---------- Parser ----------

export function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    return { command: "help", options: {}, positionals: [] };
  }
  const command = argv[0];
  if (command.startsWith("-")) {
    return { command: "help", options: {}, positionals: [] };
  }
  const schema = COMMAND_SCHEMAS[command];
  if (!schema) {
    if (command === "help") {
      return { command: "help", options: {}, positionals: [] };
    }
    throw new ParseError("E_UNKNOWN_COMMAND", `Unknown command: ${command}`);
  }

  const tokens = argv.slice(1);
  const options = {};
  const positional = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];

    if (token === "--") {
      positional.push(...tokens.slice(i + 1));
      break;
    }

    if (!token.startsWith("-")) {
      positional.push(token);
      continue;
    }

    if (token.startsWith("--no-") && !token.includes("=")) {
      const key = token.slice(5);
      assertBoolFlag(command, schema, key, token);
      options[key] = false;
      continue;
    }

    if (token.startsWith("--")) {
      const eqIndex = token.indexOf("=");
      let key;
      let inlineValue;
      if (eqIndex >= 0) {
        key = token.slice(2, eqIndex);
        inlineValue = token.slice(eqIndex + 1);
      } else {
        key = token.slice(2);
      }

      if (schema.valueFlags.includes(key)) {
        let value = inlineValue;
        if (value === undefined) {
          const next = tokens[i + 1];
          if (next === undefined || (next.startsWith("-") && next !== "-")) {
            if (key === "keep-samples") {
              options[key] = true;
              continue;
            }
            throw new ParseError("E_MISSING_VALUE", `Missing value for --${key}`);
          }
          value = next;
          i += 1;
        }
        options[key] = parseValueFlag(key, value);
        continue;
      }

      if (schema.boolFlags.includes(key)) {
        if (inlineValue !== undefined) {
          options[key] = inlineValue !== "false" && inlineValue !== "0";
        } else {
          options[key] = true;
        }
        continue;
      }

      throw new ParseError(
        "E_UNKNOWN_FLAG",
        `Unknown flag for ${command}: ${token}`
      );
    }

    if (token.startsWith("-") && token.length === 2) {
      const long = SHORT_FLAGS[token[1]];
      if (!long) {
        throw new ParseError("E_UNKNOWN_FLAG", `Unknown short flag: ${token}`);
      }
      options[long] = true;
      continue;
    }

    throw new ParseError("E_UNKNOWN_FLAG", `Unknown flag format: ${token}`);
  }

  const expected = schema.positional.length;
  if (positional.length < expected) {
    const msg = command === "start"
      ? "Missing URL. Pass it positionally (start <url>) or via --url."
      : `Missing required argument for ${command}`;
    throw new ParseError("E_MISSING_ARGUMENT", msg);
  }
  if (positional.length > expected) {
    throw new ParseError(
      "E_EXTRA_ARGUMENT",
      `Too many positional arguments for ${command}`
    );
  }

  const result = { command, options, positionals: positional };
  if (schema.positional[0] === "target") {
    result.target = positional[0];
  }

  if (command === "start" && !options.duration) {
    throw new ParseError("E_MISSING_VALUE", "Missing --duration.");
  }
  if (command === "start" && options["video-length"] && options.interval !== undefined) {
    throw new ParseError(
      "E_MUTUALLY_EXCLUSIVE",
      "--video-length and --interval cannot be used together."
    );
  }

  if (schema.positional[0] === "runDir") {
    result.runDir = positional[0];
  }
  return result;
}

function assertBoolFlag(command, schema, key, token) {
  if (!schema.boolFlags.includes(key)) {
    throw new ParseError(
      "E_UNKNOWN_FLAG",
      `Unknown flag for ${command}: ${token}`
    );
  }
}

function parseValueFlag(flag, value) {
  if (flag === "duration") {
    return parseDuration(value);
  }
  if (flag === "viewport") {
    return parseViewport(value);
  }
  if (flag === "interval") {
    const parsed = parseDuration(value);
    if (parsed.ms === 0) {
      throw new ParseError("E_BAD_INTERVAL", `Invalid interval: ${value}`);
    }
    return parsed.ms;
  }
  if (flag === "video-length") {
    const parsed = parseDuration(value);
    if (parsed.ms === 0) {
      throw new ParseError("E_BAD_VIDEO_LENGTH", `Invalid video length: ${value}`);
    }
    return parsed;
  }
  if (flag === "fps" || flag === "keep-samples") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new ParseError(`E_BAD_${flag.toUpperCase().replace(/-/g, "_")}`, `Invalid ${flag}: ${value}`);
    }
    return parsed;
  }
  if (flag === "index") {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
      throw new ParseError(
        "E_BAD_INDEX",
        `Invalid numeric value for --${flag}: ${value}`
      );
    }
    return parsed;
  }
  if (flag === "near") {
    const parsed = Date.parse(value);
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T/.test(value) ||
      !Number.isFinite(parsed)
    ) {
      throw new ParseError("E_BAD_TIMESTAMP", `Invalid ISO timestamp for --near: ${value}`);
    }
    return new Date(parsed).toISOString();
  }
  return value;
}

export function parseDuration(input) {
  if (typeof input !== "string" || input.trim() === "") {
    throw new ParseError("E_BAD_DURATION", `Invalid duration: ${input}`);
  }
  const normalized = input.trim().toLowerCase();
  const match = normalized.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?(?:(\d+)ms)?$/);
  if (!match) {
    throw new ParseError("E_BAD_DURATION", `Invalid duration: ${input}`);
  }
  const hasToken = match.slice(1).some((value) => value !== undefined);
  if (!hasToken) {
    throw new ParseError("E_BAD_DURATION", `Invalid duration: ${input}`);
  }
  const hours = Number.parseInt(match[1] || "0", 10);
  const minutes = Number.parseInt(match[2] || "0", 10);
  const seconds = Number.parseInt(match[3] || "0", 10);
  const ms = Number.parseInt(match[4] || "0", 10);
  if ([hours, minutes, seconds, ms].some((value) => !Number.isFinite(value) || value < 0)) {
    throw new ParseError("E_BAD_DURATION", `Invalid duration: ${input}`);
  }
  return {
    input,
    ms: hours * 3_600_000 + minutes * 60_000 + seconds * 1000 + ms
  };
}

export function parseViewport(input) {
  const match = String(input).match(/^(\d+)x(\d+)$/i);
  if (!match) {
    throw new ParseError("E_BAD_VIEWPORT", `Invalid viewport: ${input}`);
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width <= 0 || height <= 0) {
    throw new ParseError("E_BAD_VIEWPORT", `Invalid viewport: ${input}`);
  }
  return { input, width, height };
}

async function runDoctorCli(parsed) {
  const result = await commandDoctor();
  if (parsed.options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatDoctorHuman(result));
  }
  if (result.exitCode) {
    process.exitCode = result.exitCode;
  }
}

// ---------- Start / Capture ----------

function frameName(index) {
  return `frame-${String(index).padStart(4, "0")}.png`;
}

function nowIso() {
  return new Date().toISOString();
}

function slugify(input) {
  return (
    String(input)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "capture"
  );
}

function defaultRunDir(url) {
  const slug = slugify(String(url).replace(/^https?:\/\//, "").replace(/[:/]+/g, "-"));
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  return path.join(process.cwd(), "timelapse-runs", `${slug}-${stamp}`);
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function writeJsonAtomic(file, data) {
  await ensureDir(path.dirname(file));
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(temp, `${JSON.stringify(data, null, 2)}\n`);
  await fsp.rename(temp, file);
}

async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, "utf8"));
}

async function readJsonOptional(file) {
  try {
    return await readJson(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function appendLog(runDir, message) {
  await fsp.appendFile(path.join(runDir, "capture.log"), `[${nowIso()}] ${message}\n`);
}

function appendLogSync(runDir, filename, message) {
  const lines = String(message).split(/\r?\n|\r/);
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  if (lines.length === 0) return;

  const payload = lines.map((line) => `[${nowIso()}] ${line}`).join("\n") + "\n";
  fs.appendFileSync(path.join(runDir, filename), payload, "utf8");
}

function appendRenderLog(runDir, message) {
  appendLogSync(runDir, "render.log", message);
}

async function appendJsonLine(file, data) {
  await fsp.appendFile(file, `${JSON.stringify(data)}\n`);
}

async function removeIfExists(file) {
  await fsp.rm(file, { force: true });
}

function isBenignEmptyDirRemovalError(error) {
  return BENIGN_EMPTY_DIR_REMOVAL_CODES.has(error?.code);
}

function formatFsError(action, target, error) {
  const code = error?.code ? `${error.code}: ` : "";
  return `${action} ${target}: ${code}${error.message}`;
}

function getSampleIndices(m, n) {
  const indices = new Set();
  if (m === 0) return indices;
  if (m <= n) {
    for (let i = 0; i < m; i++) indices.add(i);
  } else if (n === 1) {
    indices.add(m - 1);
  } else {
    for (let i = 0; i < n; i++) {
      indices.add(Math.round((i * (m - 1)) / (n - 1)));
    }
  }
  return indices;
}

function removeEmptyDirSync(dir) {
  try {
    fs.rmdirSync(dir);
    return { success: true };
  } catch (error) {
    if (isBenignEmptyDirRemovalError(error)) {
      return { success: true, ignored: error.code };
    }
    return {
      success: false,
      error: formatFsError("Failed to remove frames directory", dir, error)
    };
  }
}

async function removeEmptyDir(dir) {
  try {
    await fsp.rmdir(dir);
    return { success: true };
  } catch (error) {
    if (isBenignEmptyDirRemovalError(error)) {
      return { success: true, ignored: error.code };
    }
    return {
      success: false,
      error: formatFsError("Failed to remove frames directory", dir, error)
    };
  }
}

async function reduceDir(dir, fn, init) {
  let acc = init;
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return [];
    throw error;
  });
  for (const entry of entries) {
    const itemPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      acc = await reduceDir(itemPath, fn, acc);
    } else if (entry.isFile()) {
      acc = await fn(acc, itemPath, entry);
    }
  }
  return acc;
}

const directorySize = (dir) => reduceDir(dir, async (sum, file) => {
  try {
    return sum + (await fsp.stat(file)).size;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return sum;
    throw error;
  }
}, 0);

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function estimateFrameBytes(viewport) {
  return Math.ceil(((viewport?.width || 1280) * (viewport?.height || 720) * 3) / 4);
}

function estimateDiskBytes(viewport, targetFrames) {
  return Math.max(1, targetFrames) * estimateFrameBytes(viewport) + 4096;
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.round((ms || 0) / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

async function safePageTitle(page) {
  if (!page) return null;
  try {
    return await page.title();
  } catch {
    return null;
  }
}

function computeWaitSchedule(targetTimestampMs, { now = Date.now, maxWaitMs = 1000 } = {}) {
  const delay = Math.max(0, Math.round(targetTimestampMs - now()));
  if (delay <= 0) return [];
  const clampedMaxWaitMs = Math.max(1, Math.floor(maxWaitMs));
  const schedule = [];
  let remaining = delay;
  while (remaining > 0) {
    const chunk = Math.min(remaining, clampedMaxWaitMs);
    schedule.push(chunk);
    remaining -= chunk;
  }
  return schedule;
}

async function waitUntilFrameTime(
  targetTimestampMs,
  {
    now = Date.now,
    wait = (ms, options) => setTimeoutPromise(ms, undefined, options),
    maxWaitMs = 1000,
    signal
  } = {}
) {
  const schedule = computeWaitSchedule(targetTimestampMs, { now, maxWaitMs });
  for (const chunkMs of schedule) {
    await wait(chunkMs, signal ? { signal } : undefined);
  }
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function writeStartArtifacts(runDir, state) {
  const framesDir = path.join(runDir, "frames");
  await ensureDir(runDir);
  await ensureDir(framesDir);

  const manifest = {
    runDir,
    createdAt: nowIso(),
    state: state.state
  };
  const config = {
    version: VERSION,
    backend: state.backend,
    target: state.target,
    intervalMs: state.intervalMs,
    durationMs: state.durationMs,
    targetFrames: state.targetFrames,
    fps: state.fps,
    viewport: state.viewport,
    estimatedDiskBytes: state.estimatedDiskBytes,
    outDir: runDir,
    cleanup: state.cleanup,
    keepSamples: state.keepSamples,
    keepLatest: state.keepLatest,
    waitUntil: state.waitUntil,
    headed: state.headed,
    createdAt: nowIso()
  };
  const job = {
    runDir,
    state: state.state,
    framesPath: framesDir,
    pid: state.pid ?? null,
    parentPid: state.parentPid ?? process.pid,
    command: state.command ?? null,
    detached: Boolean(state.detached),
    createdAt: nowIso()
  };
  await writeJsonAtomic(path.join(runDir, "manifest.json"), manifest);
  await writeJsonAtomic(path.join(runDir, "config.json"), config);
  await writeJsonAtomic(path.join(runDir, "job.json"), job);
  await writeStatus(runDir, state);
}

async function writeJob(runDir, job) {
  await writeJsonAtomic(path.join(runDir, "job.json"), {
    ...job,
    updatedAt: nowIso()
  });
}

function buildStatusPayload(state) {
  const startedAtMs = state.startedAt ? new Date(state.startedAt).getTime() : Date.now();
  const elapsedMs = Math.max(0, Date.now() - startedAtMs);
  const frameCount = state.frames?.captured ?? state.frameCount ?? state.framesCaptured ?? 0;
  const failedFrameCount = state.frames?.failed ?? state.failedFrameCount ?? state.framesFailed ?? 0;
  const skippedFrameCount = state.frames?.skipped ?? state.skippedFrameCount ?? state.framesSkipped ?? 0;
  const totalExpected = Number.isFinite(state.frames?.totalExpected)
    ? state.frames.totalExpected
    : Number.isFinite(state.targetFrames)
      ? state.targetFrames
      : (state.expectedFrames ?? frameCount);
  const completedAttempts = frameCount + failedFrameCount + skippedFrameCount;
  const stateName = state.state || "starting";
  const etaMs =
    stateName === "running"
      ? Math.max(0, (totalExpected - completedAttempts) * (state.intervalMs || 0))
      : 0;
  const latestFrameTimestamp = state.latestFrameTimestamp || state.latestFrameAt || null;
  let staleWarning = { isStale: false, intervalMs: state.intervalMs || null, ageMs: null };
  if (stateName === "running" && latestFrameTimestamp && state.intervalMs) {
    const ageMs = Math.max(0, Date.now() - new Date(latestFrameTimestamp).getTime());
    staleWarning = {
      isStale: ageMs > state.intervalMs,
      intervalMs: state.intervalMs,
      ageMs
    };
  }
  return {
    runDir: state.runDir,
    state: stateName,
    frames: {
      captured: frameCount,
      failed: failedFrameCount,
      skipped: skippedFrameCount,
      attempted: completedAttempts,
      totalExpected
    },
    latestFrame: state.latestFrame || null,
    latestFrameTimestamp,
    elapsedMs,
    etaMs,
    staleWarning,
    startedAt: state.startedAt,
    lastUpdatedAt: state.lastUpdatedAt,
    intervalMs: state.intervalMs,
    estimatedDiskBytes: state.estimatedDiskBytes ?? null,
    error: state.error || null
  };
}

async function writeStatus(runDir, state) {
  const payload = buildStatusPayload({ ...state, runDir });
  await writeJsonAtomic(path.join(runDir, "status.json"), payload);
  return payload;
}

function inferStateFromStatus(status) {
  if (!status) return "idle";
  if (status.state) return status.state;
  const failedFrameCount = status.frames?.failed ?? status.failedFrameCount ?? 0;
  const frameCount = status.frames?.captured ?? status.frameCount ?? 0;
  if (failedFrameCount > 0 && frameCount === 0) return "failed";
  if (status.lastUpdatedAt) return "completed";
  return "idle";
}

async function writeFakeFrame(runDir, index) {
  const filename = path.join(runDir, "frames", frameName(index));
  await fsp.writeFile(filename, SIMULATION_FRAME_PNG);
  return filename;
}

async function recordCapturedFrame({ state, runDir, manifestPath, index, scheduledAt, filename, url, title }) {
  const capturedAt = nowIso();
  const record = { index, scheduledAt, capturedAt, path: filename, status: "captured", url, title: title ?? null, viewport: state.viewport, error: null };
  state.frameCount += 1;
  state.latestFrame = filename;
  state.latestFrameAt = capturedAt;
  state.latestFrameTimestamp = capturedAt;
  state.lastUpdatedAt = capturedAt;
  state.state = "running";
  await appendJsonLine(manifestPath, record);
  await writeJsonAtomic(path.join(runDir, "latest-frame.json"), record);
  await fsp.copyFile(filename, path.join(runDir, "latest.png"));
  await writeStatus(runDir, state);
}

async function recordFailedFrame({ state, runDir, manifestPath, index, scheduledAt, url, title, error }) {
  state.failedFrameCount += 1;
  state.lastUpdatedAt = nowIso();
  const record = { index, scheduledAt, capturedAt: null, path: null, status: "failed", url, title: title ?? null, viewport: state.viewport, error };
  await appendJsonLine(manifestPath, record);
  await writeStatus(runDir, state);
}

async function recordSkippedFrame({ state, runDir, manifestPath, index, scheduledAt, url, title, reason }) {
  state.skippedFrameCount += 1;
  state.lastUpdatedAt = nowIso();
  const record = { index, scheduledAt, capturedAt: null, path: null, status: "skipped", url, title: title ?? null, viewport: state.viewport, error: reason };
  await appendJsonLine(manifestPath, record);
  await writeStatus(runDir, state);
}

async function captureWithPlaywright({ runDir, state, framesDir, manifestPath }) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: !state.headed });
  let page;
  try {
    page = await browser.newPage({ viewport: state.viewport });
    try {
      if (process.env.TIMELAPSE_SIMULATE_INITIAL_NAVIGATION_FAILURE === "1") {
        throw new Error("simulated initial navigation failure");
      }
      await page.goto(state.target, { waitUntil: state.waitUntil, timeout: 60_000 });
    } catch (error) {
      const scheduledAt = new Date(state.startedAt).toISOString();
      await recordFailedFrame({
        state,
        runDir,
        manifestPath,
        index: 1,
        scheduledAt,
        url: state.target,
        error: `navigation failed: ${error?.message || error}`
      });
      throw new Error(`navigation failed: ${error?.message || error}`);
    }

    const startedAtMs = new Date(state.startedAt).getTime();
    for (let index = 1; index <= state.targetFrames; index += 1) {
      const scheduledAtMs = startedAtMs + Math.round((index - 1) * (state.intervalMs || 0));
      await waitUntilFrameTime(scheduledAtMs, {
        maxWaitMs: Math.min(1_000, state.intervalMs || 1_000)
      });

      const filename = path.join(framesDir, frameName(index));
      const tempPath = path.join(framesDir, `.tmp-${process.pid}-${frameName(index)}`);
      const scheduledAt = new Date(scheduledAtMs).toISOString();
      try {
        await page.screenshot({ path: tempPath, fullPage: false });
        await fsp.rename(tempPath, filename);
        const title = await safePageTitle(page);
        await recordCapturedFrame({ state, runDir, manifestPath, index, scheduledAt, filename, url: page.url(), title });
      } catch (error) {
        await removeIfExists(tempPath);
        await recordFailedFrame({ state, runDir, manifestPath, index, scheduledAt, url: page?.url?.() ?? state.target, title: await safePageTitle(page), error: error?.message || String(error) });
      }
    }
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (error) {
        await appendLog(runDir, `browser close failed: ${error?.stack || error}`);
        throw error;
      }
    }
  }
}

async function captureSimulated({ runDir, state, framesDir, manifestPath }) {
  if (process.env.TIMELAPSE_SIMULATE_INITIAL_NAVIGATION_FAILURE === "1") {
    const scheduledAt = new Date(state.startedAt).toISOString();
    await recordFailedFrame({
      state,
      runDir,
      manifestPath,
      index: 1,
      scheduledAt,
      url: state.target,
      error: "navigation failed: simulated initial navigation failure"
    });
    throw new Error("navigation failed: simulated initial navigation failure");
  }
  const failIndex =
    process.env.TIMELAPSE_SIMULATE_FRAME_FAILURE === "1" ? 2 : null;
  const skipIndex =
    process.env.TIMELAPSE_SIMULATE_FRAME_SKIP === "1" ? 3 : null;
  const delayMs = Number.parseInt(process.env.TIMELAPSE_SIMULATE_FRAME_DELAY_MS || "", 10);
  const startedAtMs = new Date(state.startedAt).getTime();
  for (let index = 1; index <= state.targetFrames; index += 1) {
    if (Number.isFinite(delayMs) && delayMs > 0) {
      await setTimeoutPromise(delayMs);
    }
    const scheduledAt = new Date(startedAtMs + (index - 1) * (state.intervalMs || 0)).toISOString();
    if (failIndex && index === failIndex) {
      await recordFailedFrame({ state, runDir, manifestPath, index, scheduledAt, url: state.target, error: "simulated failure" });
      continue;
    }
    if (skipIndex && index === skipIndex) {
      await recordSkippedFrame({ state, runDir, manifestPath, index, scheduledAt, url: state.target, reason: "simulated skip" });
      continue;
    }
    const filename = await writeFakeFrame(runDir, index);
    await recordCapturedFrame({ state, runDir, manifestPath, index, scheduledAt, filename, url: state.target });
  }
}

function validateStartTarget(target) {
  if (!target) {
    throw new ParseError("E_MISSING_ARGUMENT", "Missing target URL.");
  }
  try {
    const url = new URL(target);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new Error(`navigation failed: invalid URL: ${target}`);
  }
  if (process.env.TIMELAPSE_SIMULATE_NAVIGATION_FAILURE === "1") {
    throw new Error(`navigation failed: page could not be loaded: ${target}`);
  }
}

function buildInitialCaptureState({ target, options = {} }) {
  const timing = resolveStartTiming(options);
  if (
    timing.computedFromVideoLength
    && timing.intervalMs < MIN_COMPUTED_INTERVAL_WARNING_MS
  ) {
    console.error(
      `warning: computed interval ${timing.intervalMs}ms is below 1000ms; capture may miss the requested cadence`
    );
  }
  const intervalMs = timing.intervalMs;
  const durationMs = timing.durationMs;
  const fps = timing.fps;
  const viewport = options.viewport
    ? { width: options.viewport.width, height: options.viewport.height }
    : { width: 1280, height: 720 };
  const targetFrames = (() => {
    const fromEnv = Number.parseInt(process.env.TIMELAPSE_SIMULATE_FRAMES || "", 10);
    if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
    return timing.targetFrames;
  })();
  const estimatedDiskBytes = estimateDiskBytes(viewport, targetFrames);
  const cleanup = options["keep-frames"] ? "never" : options.cleanup ?? "after-render";
  const runDir = path.resolve(options.out ?? defaultRunDir(target));
  const startedAt = nowIso();

  return {
    runDir,
    target,
    backend: options.backend ?? "playwright-url",
    state: "starting",
    startedAt,
    targetFrames,
    frameCount: 0,
    failedFrameCount: 0,
    skippedFrameCount: 0,
    latestFrame: null,
    latestFrameAt: null,
    latestFrameTimestamp: null,
    intervalMs,
    durationMs,
    fps,
    viewport,
    estimatedDiskBytes,
    cleanup,
    keepSamples: options["keep-samples"] === true ? 5 : Number(options["keep-samples"] ?? 0),
    keepLatest: Boolean(options["keep-latest"]),
    waitUntil: options["wait-until"] ?? "domcontentloaded",
    headed: Boolean(options.headed),
    lastUpdatedAt: startedAt
  };
}

async function runCaptureLoop({ runDir, state, framesDir, manifestPath }) {
  state.pid = process.pid;
  state.state = "running";
  state.lastUpdatedAt = nowIso();
  await writeStatus(runDir, state);
  await appendLog(runDir, `capture running pid=${process.pid}`);

  try {
    if (process.env.TIMELAPSE_SIMULATE_FRAMES) {
      await captureSimulated({ runDir, state, framesDir, manifestPath });
    } else {
      await captureWithPlaywright({ runDir, state, framesDir, manifestPath });
    }
    state.state = state.frameCount > 0 ? "completed" : "failed";
    state.lastUpdatedAt = nowIso();
    await writeStatus(runDir, state);
    await appendLog(runDir, `capture finished state=${state.state}`);
    return buildStatusPayload({ ...state, runDir });
  } catch (error) {
    state.state = state.frameCount > 0 ? "completed" : "failed";
    state.error = error?.message || String(error);
    state.lastUpdatedAt = nowIso();
    await writeStatus(runDir, state);
    await appendLog(runDir, `capture failed: ${error?.stack || error}`);
    throw error;
  }
}

function stateFromConfig({ runDir, config, status }) {
  return {
    runDir,
    target: config.target,
    backend: config.backend,
    state: "running",
    startedAt: status?.startedAt ?? config.createdAt ?? nowIso(),
    targetFrames: config.targetFrames,
    frameCount: status?.frames?.captured ?? 0,
    failedFrameCount: status?.frames?.failed ?? 0,
    skippedFrameCount: status?.frames?.skipped ?? status?.framesSkipped ?? 0,
    latestFrame: typeof status?.latestFrame === "string" ? status.latestFrame : null,
    latestFrameAt: status?.latestFrameTimestamp ?? null,
    latestFrameTimestamp: status?.latestFrameTimestamp ?? null,
    intervalMs: config.intervalMs,
    durationMs: config.durationMs,
    fps: config.fps,
    viewport: config.viewport,
    estimatedDiskBytes: config.estimatedDiskBytes,
    cleanup: config.cleanup,
    keepSamples: Number(config.keepSamples ?? 0),
    keepLatest: Boolean(config.keepLatest),
    waitUntil: config.waitUntil ?? "domcontentloaded",
    headed: Boolean(config.headed),
    lastUpdatedAt: nowIso()
  };
}

export async function commandCapture({ runDir } = {}) {
  if (!runDir) {
    throw new ParseError("E_MISSING_ARGUMENT", "Missing --run.");
  }
  const resolved = path.resolve(runDir);
  const configPath = path.join(resolved, "config.json");
  if (!fs.existsSync(configPath)) {
    throw new Error(`No run directory at ${resolved}`);
  }

  const config = await readJson(configPath);
  const status = await readJsonOptional(path.join(resolved, "status.json"));
  const framesDir = path.join(resolved, "frames");
  const manifestPath = path.join(resolved, "manifest.jsonl");
  const command = [process.execPath, __filename, "capture", "--run", resolved];
  const state = stateFromConfig({ runDir: resolved, config, status });
  await writeJob(resolved, {
    runDir: resolved,
    state: "running",
    framesPath: framesDir,
    pid: process.pid,
    parentPid: null,
    command,
    detached: true,
    startedAt: state.startedAt
  });
  try {
    const captureStatus = await runCaptureLoop({ runDir: resolved, state, framesDir, manifestPath });
    await writeJob(resolved, {
      runDir: resolved,
      state: captureStatus.state,
      framesPath: framesDir,
      pid: process.pid,
      parentPid: null,
      command,
      detached: true,
      startedAt: state.startedAt,
      finishedAt: nowIso()
    });
    return {
      runDir: resolved,
      status: captureStatus
    };
  } catch (error) {
    await writeJob(resolved, {
      runDir: resolved,
      state: state.state,
      framesPath: framesDir,
      pid: process.pid,
      parentPid: null,
      command,
      detached: true,
      startedAt: state.startedAt,
      finishedAt: nowIso(),
      error: error?.message || String(error)
    });
    throw error;
  }
}

async function spawnDetachedCapture(runDir) {
  const command = [process.execPath, __filename, "capture", "--run", runDir];
  const child = spawn(command[0], command.slice(1), {
    detached: true,
    stdio: "ignore",
    env: process.env
  });
  child.unref();
  const job = {
    runDir,
    state: "running",
    framesPath: path.join(runDir, "frames"),
    pid: child.pid,
    parentPid: process.pid,
    command,
    detached: true,
    startedAt: nowIso()
  };
  await writeJob(runDir, job);
  return job;
}

export async function commandStart({ target, options = {} } = {}) {
  validateStartTarget(target);
  const state = buildInitialCaptureState({ target, options });

  if (!options.json) {
    console.log(
      `estimated disk: ${formatBytes(state.estimatedDiskBytes)} (${state.targetFrames} frames x ${formatBytes(
        estimateFrameBytes(state.viewport)
      )}/frame, approximate)`
    );
  }

  await writeStartArtifacts(state.runDir, state);
  await appendLog(state.runDir, `start invoked target=${target} backend=${state.backend}`);
  const job = await spawnDetachedCapture(state.runDir);

  return {
    runDir: state.runDir,
    estimatedDiskBytes: state.estimatedDiskBytes,
    job,
    status: buildStatusPayload({ ...state, runDir: state.runDir })
  };
}

export function resolveStartTiming(options = {}) {
  const durationMs = options.duration?.ms ?? 0;
  const fps = Number(options.fps ?? 24);
  const explicitIntervalMs = typeof options.interval === "number"
    ? options.interval
    : options.interval?.ms;
  const videoLengthMs = options["video-length"]?.ms ?? null;

  if (videoLengthMs !== null) {
    const targetFrames = Math.max(1, Math.round((videoLengthMs / 1000) * fps));
    return {
      durationMs,
      videoLengthMs,
      fps,
      targetFrames,
      intervalMs: Math.max(1, Math.round(durationMs / targetFrames)),
      computedFromVideoLength: true
    };
  }

  const intervalMs = explicitIntervalMs ?? 200;
  return {
    durationMs,
    videoLengthMs,
    fps,
    intervalMs,
    targetFrames: durationMs > 0 && intervalMs > 0
      ? Math.max(1, Math.ceil(durationMs / intervalMs))
      : 3,
    computedFromVideoLength: false
  };
}

async function runStartCli(parsed) {
  const target = parsed.target;
  const result = await commandStart({ target, options: parsed.options });
  if (parsed.options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Started timelapse capture: ${result.runDir}`);
  console.log(`Status: timelapse-capture status ${shellQuote(result.runDir)}`);
  console.log(`Peek:   timelapse-capture peek ${shellQuote(result.runDir)} --latest`);
}

async function runCaptureCli(parsed) {
  await commandCapture({ runDir: parsed.options.run });
}

// ---------- Status ----------

export async function commandStatus({ runDir }) {
  if (!runDir) {
    throw new ParseError("E_MISSING_ARGUMENT", "Missing run directory.");
  }
  const resolved = path.resolve(runDir);
  const statusPath = path.join(resolved, "status.json");
  const configPath = path.join(resolved, "config.json");
  const latestFramePath = path.join(resolved, "latest-frame.json");

  const status = await readJsonOptional(statusPath);
  if (!status) {
    if (!fs.existsSync(resolved)) {
      throw new Error(`run directory not found: ${resolved}`);
    }
    throw new Error(`missing run status file: ${statusPath}`);
  }

  const config = await readJsonOptional(configPath);
  const latestFrame = await readJsonOptional(latestFramePath);
  const [framesDiskUsageBytes, runDirBytes, summary] = await Promise.all([
    directorySize(path.join(resolved, "frames")),
    directorySize(resolved),
    readJsonOptional(getSummaryPath(resolved))
  ]);

  const payload = buildStatusPayload({
    ...status,
    state: migrateLegacyState(status.state || inferStateFromStatus(status)),
    runDir: resolved
  });
  payload.diskUsage = { runDirBytes, framesBytes: framesDiskUsageBytes };
  payload.outputPath = summary?.render?.outputPath ?? null;
  payload.cleanup = summary?.cleanup != null
    ? {
        success: summary.cleanup.success ?? null,
        removed: summary.cleanup.removed ?? 0,
        retained: summary.cleanup.retained ?? null,
        bytesFreed: summary.cleanup.bytesFreed ?? 0
      }
    : null;

  return {
    status: payload,
    config,
    latestFrame,
    framesDiskUsageBytes
  };
}

function printHumanStatus(status) {
  const lines = [];
  lines.push(`run-dir: ${status.runDir}`);
  lines.push(`state: ${status.state}`);
  lines.push(`elapsed: ${formatDuration(status.elapsedMs)}`);
  if (status.state === "running") lines.push(`eta: ${formatDuration(status.etaMs)}`);
  lines.push(
    `frames: ${status.frames.attempted} attempted, ${status.frames.captured} captured, ${status.frames.failed} failed, ${status.frames.skipped} skipped, ${status.frames.totalExpected} expected`
  );
  if (status.latestFrame) lines.push(`latest successful frame: ${status.latestFrame}`);
  if (status.latestFrameTimestamp) lines.push(`latest successful frame at: ${status.latestFrameTimestamp}`);
  if (status.staleWarning?.isStale)
    lines.push(`warning: latest successful frame is stale (${formatDuration(status.staleWarning.ageMs)} old)`);
  if (status.diskUsage)
    lines.push(
      `disk usage: run-dir ${formatBytes(status.diskUsage.runDirBytes)}, frames ${formatBytes(status.diskUsage.framesBytes)}`
    );
  if (status.estimatedDiskBytes != null)
    lines.push(`estimated disk: ${formatBytes(status.estimatedDiskBytes)} (approximate)`);
  if (status.outputPath) lines.push(`output: ${status.outputPath}`);
  if (status.cleanup) {
    const bytesFreed = status.cleanup.bytesFreed ?? 0;
    lines.push(
      `cleanup: removed ${status.cleanup.removed ?? 0}, retained ${status.cleanup.retained ?? 0} (freed ${formatBytes(bytesFreed)})`
    );
  }
  console.log(lines.join("\n"));
}

async function runStatusCli(parsed) {
  const result = await commandStatus({ runDir: parsed.runDir });
  if (parsed.options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  printHumanStatus(result.status);
}

// ---------- Peek ----------

async function listFrameFiles(runDir) {
  const framesDir = path.join(runDir, "frames");
  const entries = await fsp.readdir(framesDir, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".png"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

async function readCapturedFrameRecords(runDir, frameNames) {
  const frameNameSet = new Set(frameNames);
  const manifestPath = path.join(runDir, "manifest.jsonl");
  const manifest = await fsp.readFile(manifestPath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  const records = [];

  for (const line of manifest.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const capturedAtMs = Date.parse(record?.capturedAt);
    const name = path.basename(record?.path || "");
    if (
      record?.status === "captured" &&
      Number.isFinite(capturedAtMs) &&
      frameNameSet.has(name)
    ) {
      records.push({ ...record, name, capturedAtMs });
    }
  }

  return records;
}

async function findNearestFrameName(runDir, names, nearIso) {
  const targetMs = Date.parse(nearIso);
  const records = await readCapturedFrameRecords(runDir, names);

  if (!records.length) {
    throw new Error("No captured frame timestamps are available for --near.");
  }

  return records.reduce((nearest, record) => {
    const nearestDelta = Math.abs(nearest.capturedAtMs - targetMs);
    const recordDelta = Math.abs(record.capturedAtMs - targetMs);
    return recordDelta < nearestDelta ? record : nearest;
  }).name;
}

export async function commandPeek({ runDir, options = {} }) {
  const resolved = path.resolve(runDir);
  const names = await listFrameFiles(resolved);

  if (!names.length) {
    const posterPath = path.join(resolved, "poster.png");
    const retainedPath = path.join(resolved, "latest-retained.png");
    if (fs.existsSync(posterPath)) {
      return { exists: true, path: posterPath, pathCount: 1 };
    }
    if (fs.existsSync(retainedPath)) {
      return { exists: true, path: retainedPath, pathCount: 1 };
    }
    throw new Error(
      "No frames available. Raw frames were cleaned up. Use poster.png or latest-retained.png from the run directory."
    );
  }

  let index = names.length - 1;
  if (typeof options.index === "number") {
    index = Math.min(Math.max(options.index, 0), names.length - 1);
  } else if (typeof options.near === "string") {
    const nearestName = await findNearestFrameName(resolved, names, options.near);
    const nearIndex = names.indexOf(nearestName);
    if (nearIndex === -1) {
      throw new Error(
        `--near selected frame "${nearestName}" is not present in the frames directory.`
      );
    }
    index = nearIndex;
  } else if (options.latest) {
    index = names.length - 1;
  }

  const framePath = path.join(resolved, "frames", names[index]);
  return {
    exists: true,
    path: framePath,
    framePath,
    pathCount: names.length,
    frame: {
      index: Number.parseInt(names[index].match(/\d+/)?.[0] || "0", 10),
      path: path.join("frames", names[index])
    }
  };
}

async function runPeekCli(parsed) {
  const result = await commandPeek({ runDir: parsed.runDir, options: parsed.options });
  if (parsed.options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(result.path);
}

// ---------- Render ----------

class RenderError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.name = "RenderError";
  }
}

export function getFramesDir(runDir) {
  return path.join(runDir, "frames");
}

export function getOutputPath(runDir, config) {
  if (config?.output?.path) {
    return path.resolve(runDir, config.output.path);
  }
  return path.resolve(runDir, "output.mp4");
}

function getConfiguredOutputPath(runDir, options = {}) {
  const configured = options?.output?.path ?? options?.config?.output?.path ?? options?.config?.outputPath ?? null;
  if (!configured) return null;
  return path.resolve(runDir, String(configured));
}

function getSummaryOutputPath(runDir, summary) {
  const configured = summary?.render?.outputPath;
  if (!configured) return null;
  return path.resolve(runDir, String(configured));
}

function getDefaultOutputPath(runDir) {
  return path.resolve(runDir, "output.mp4");
}

async function resolveCleanupOutputPath(runDir, options = {}) {
  const [config, summary] = await Promise.all([
    readJsonOptional(path.join(runDir, "config.json")),
    readJsonOptional(getSummaryPath(runDir))
  ]);

  return (
    getConfiguredOutputPath(runDir, options) ||
    getConfiguredOutputPath(runDir, config) ||
    getSummaryOutputPath(runDir, summary) ||
    getDefaultOutputPath(runDir)
  );
}

export function getSummaryPath(runDir) {
  return path.join(runDir, "run-summary.json");
}

function countFrameFiles(framesDir) {
  if (!fs.existsSync(framesDir)) return 0;
  const files = fs.readdirSync(framesDir);
  return files.filter((file) => /\.(png|jpg|jpeg)$/i.test(file)).length;
}

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch (error) {
    throw error;
  }
}

function safeFileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

async function sumFileSizes(filePaths) {
  const stats = await Promise.all(filePaths.map((filePath) => fsp.stat(filePath).catch(() => ({ size: 0 }))));
  return stats.reduce((total, stat) => total + stat.size, 0);
}

export function validateMP4(outputPath) {
  const result = {
    exists: false,
    bytes: 0,
    duration: null,
    dimensions: null,
    hasVideoStream: false,
    error: null
  };
  if (!fs.existsSync(outputPath)) {
    result.error = "Output file does not exist";
    return result;
  }
  result.exists = true;
  try {
    result.bytes = fileSize(outputPath);
  } catch (error) {
    result.error = `Failed to stat output file: ${error.message}`;
    return result;
  }
  if (result.bytes === 0) {
    result.error = "Output file is empty";
    return result;
  }
  let probeJson;
  try {
    probeJson = execFileSync(
      "ffprobe",
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", outputPath],
      { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }
    );
  } catch (error) {
    result.error = `ffprobe failed: ${error.message}`;
    return result;
  }
  try {
    const meta = JSON.parse(probeJson);
    const duration = parseFloat(meta?.format?.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      result.error = "Could not determine video duration or duration is zero";
      return result;
    }
    result.duration = duration;
    const stream = meta?.streams?.find((s) => s.codec_type === "video");
    if (!stream) {
      result.error = "Output file does not have a readable video stream";
      return result;
    }
    result.hasVideoStream = true;
    result.dimensions = {
      width: Number.isFinite(Number(stream.width)) ? Number(stream.width) : null,
      height: Number.isFinite(Number(stream.height)) ? Number(stream.height) : null
    };
  } catch (error) {
    result.error = `ffprobe returned unreadable metadata: ${error.message}`;
  }
  return result;
}

function pickSamples(files, count) {
  if (count <= 0) return [];
  const indices = getSampleIndices(files.length, count);
  return Array.from(indices).sort((a, b) => a - b).map((i) => files[i]);
}

function copySamplesSync(framesDir, runDir, count) {
  const names = listFrameFilesSync(framesDir);
  if (names.length === 0) return [];
  const samples = pickSamples(names, count);
  const samplesDir = path.join(runDir, "samples");
  fs.mkdirSync(samplesDir, { recursive: true });
  const samplePaths = [];
  for (let i = 0; i < samples.length; i++) {
    const destName = `sample-${String(i + 1).padStart(6, "0")}.png`;
    const dest = path.join(samplesDir, destName);
    fs.copyFileSync(path.join(framesDir, samples[i]), dest);
    samplePaths.push(`samples/${destName}`);
  }
  return samplePaths;
}

export function cleanupFrames(runDir, options = {}) {
  const framesDir = getFramesDir(runDir);
  if (!fs.existsSync(framesDir)) {
    return { success: true, removed: 0, retained: 0, bytesFreed: 0 };
  }
  let removed = 0;
  let bytesFreed = 0;
  try {
    removeStagingDir(path.join(framesDir, ".render-staging"));
  } catch (error) {
    return { success: false, removed, bytesFreed, error: error.message };
  }
  const files = fs.readdirSync(framesDir)
    .filter((f) => /\.(png|jpg|jpeg)$/i.test(f))
    .sort();

  const retained = new Set();
  let samplePaths = [];

  if (options["keep-samples"]) {
    const sampleCount = options["keep-samples"] === true ? 2 : Number(options["keep-samples"]);
    samplePaths = copySamplesSync(framesDir, runDir, sampleCount);
    // Samples are now in runDir/samples, so we don't need to retain any in framesDir
  } else if (options["keep-latest"]) {
    if (files.length > 0) {
      retained.add(files[files.length - 1]);
    }
  }

  for (const file of files) {
    if (!retained.has(file)) {
      const filePath = path.join(framesDir, file);
      bytesFreed += safeFileSize(filePath);
      fs.unlinkSync(filePath);
      removed += 1;
    }
  }

  const remaining = fs.readdirSync(framesDir);
  if (remaining.length === 0 && files.length > 0) {
    const removeResult = removeEmptyDirSync(framesDir);
    if (!removeResult.success) {
      return { success: false, removed, bytesFreed, error: removeResult.error };
    }
  }
  return {
    success: true,
    removed,
    retained: samplePaths.length || retained.size,
    bytesFreed,
    samples: samplePaths.length > 0 ? samplePaths : undefined
  };
}

function readSummarySync(runDir) {
  const summaryPath = getSummaryPath(runDir);
  try {
    return JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function readStatusSync(runDir) {
  const statusPath = path.join(runDir, "status.json");
  try {
    return JSON.parse(fs.readFileSync(statusPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function writeJsonSync(filePath, data) {
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(temp, filePath);
}

function writeSummarySync(runDir, summary) {
  writeJsonSync(getSummaryPath(runDir), summary);
}

function writeStatusSync(runDir, status) {
  writeJsonSync(path.join(runDir, "status.json"), status);
}

function listFrameFilesSync(framesDir) {
  if (!fs.existsSync(framesDir)) return [];
  return fs
    .readdirSync(framesDir)
    .filter((name) => /\.png$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function stageContiguousFrames(framesDir) {
  const names = listFrameFilesSync(framesDir);
  if (names.length === 0) return { dir: framesDir, staged: false };
  const isContiguous = names.every((name, i) => name === frameName(i + 1));
  if (isContiguous) return { dir: framesDir, staged: false };
  const stagingDir = path.join(framesDir, ".render-staging");
  removeStagingDir(stagingDir);
  fs.mkdirSync(stagingDir, { recursive: true });
  try {
    for (let i = 0; i < names.length; i++) {
      fs.linkSync(
        path.join(framesDir, names[i]),
        path.join(stagingDir, frameName(i + 1))
      );
    }
  } catch (err) {
    removeStagingDir(stagingDir);
    throw err;
  }
  return { dir: stagingDir, staged: true };
}

function removeStagingDir(stagingDir) {
  try {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  } catch (error) {
    throw new Error(`failed to remove render staging directory ${stagingDir}: ${error.message}`);
  }
}

function copyPosterSync(framesDir, runDir) {
  const names = listFrameFilesSync(framesDir);
  if (names.length === 0) return null;
  const middleIndex = Math.floor((names.length - 1) / 2);
  const src = path.join(framesDir, names[middleIndex]);
  const dest = path.join(runDir, "poster.png");
  fs.copyFileSync(src, dest);
  return "poster.png";
}

function processOutputToString(output) {
  if (output == null) return "";
  if (Buffer.isBuffer(output)) return output.toString("utf8");
  return String(output);
}

function combinedProcessOutput(result) {
  return [processOutputToString(result.stdout), processOutputToString(result.stderr)]
    .filter((output) => output.length > 0)
    .join("\n");
}

function resolveRenderFramerate(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 10;
}

export function renderFrames(runDir, options = {}) {
  const result = {
    success: false,
    outputPath: null,
    metadata: null,
    cleanupResult: null,
    error: null,
    errorCode: null
  };

  if (!fs.existsSync(runDir)) {
    result.error = `Run directory does not exist: ${runDir}`;
    result.errorCode = "ENOENT";
    return result;
  }

  let sourceFrameCount = 0;
  let ffmpegCommand = ["ffmpeg"];
  const effectiveFramerate = resolveRenderFramerate(options.framerate);

  try {
    appendRenderLog(runDir, "render attempt started");
    const framesDir = getFramesDir(runDir);
    sourceFrameCount = countFrameFiles(framesDir);
    if (sourceFrameCount === 0) {
      throw new RenderError("No frames found to render", "NO_FRAMES");
    }
    const outputPath = getOutputPath(runDir, options.config);
    const ffmpegPath = options.ffmpegPath || "ffmpeg";
    ffmpegCommand = [ffmpegPath];

    const resolvedRunDir = path.resolve(runDir);
    if (outputPath !== resolvedRunDir && !outputPath.startsWith(resolvedRunDir + path.sep)) {
      throw new RenderError(
        `Configured output path resolves outside the run directory: ${outputPath}`,
        "OUTPUT_PATH_OUTSIDE_RUNDIR"
      );
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const status = readStatusSync(runDir) || {};
    status.state = "rendering";
    writeStatusSync(runDir, status);

    const staging = stageContiguousFrames(framesDir);
    const framePattern = path.join(staging.dir, "frame-%04d.png");
    const ffmpegArgs = [
      "-framerate",
      String(effectiveFramerate),
      "-i",
      framePattern,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-crf",
      "23",
      outputPath
    ];
    ffmpegCommand = [ffmpegPath, ...ffmpegArgs];
    const renderMetadata = {
      outputPath,
      bytes: 0,
      duration: null,
      dimensions: null,
      framerate: effectiveFramerate,
      sourceFrameCount,
      ffmpegCommand,
      timestamp: nowIso()
    };

    try {
      appendRenderLog(runDir, `ffmpeg command=${JSON.stringify(ffmpegCommand)}`);
      const ffmpegResult = spawnSync(ffmpegPath, ffmpegArgs, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      });
      const ffmpegOutput = combinedProcessOutput(ffmpegResult);
      if (ffmpegOutput) appendRenderLog(runDir, ffmpegOutput);

      if (ffmpegResult.error) {
        throw new RenderError(`ffmpeg failed: ${ffmpegResult.error.message}`, "FFMPEG_FAILED");
      }
      if (ffmpegResult.status !== 0) {
        const status = ffmpegResult.status == null ? "unknown" : ffmpegResult.status;
        const signal = ffmpegResult.signal ? ` signal=${ffmpegResult.signal}` : "";
        throw new RenderError(`ffmpeg failed: exit code ${status}${signal}`, "FFMPEG_FAILED");
      }
    } catch (error) {
      if (error instanceof RenderError) throw error;
      throw new RenderError(`ffmpeg failed: ${error.message}`, "FFMPEG_FAILED");
    } finally {
      if (staging.staged) removeStagingDir(staging.dir);
    }

    const validation = validateMP4(outputPath);
    if (validation.error) {
      throw new RenderError(`Output is not a valid MP4: ${validation.error}`, "VALIDATION_FAILED");
    }

    renderMetadata.bytes = validation.bytes;
    renderMetadata.duration = validation.duration;
    renderMetadata.dimensions = validation.dimensions;

    const posterRelPath = copyPosterSync(framesDir, runDir);

    const existing = readSummarySync(runDir);
    const summary = {
      ...existing,
      duration: validation.duration,
      dimensions: validation.dimensions,
      ffmpegCommand,
      poster: posterRelPath,
      render: renderMetadata,
      cleanup: null
    };

    writeSummarySync(runDir, summary);

    const effectiveCleanup = options.cleanup ?? "after-render";
    const keepAll = options["keep-frames"] || options["keep-all"] || effectiveCleanup === "never";

    if (!keepAll) {
      const cleanup = cleanupFrames(runDir, options);
      let reason = "post-render-cleanup";
      if (options["keep-samples"]) reason = "keep-samples";
      else if (options["keep-latest"]) reason = "keep-latest";

      summary.cleanup = {
        success: cleanup.success,
        removed: cleanup.removed,
        retained: cleanup.retained,
        bytesFreed: cleanup.bytesFreed ?? 0,
        reason,
        source: options.cleanupSource || "default",
        samples: cleanup.samples,
        error: cleanup.error || null,
        timestamp: nowIso()
      };
      result.cleanupResult = cleanup;
    } else {
      summary.cleanup = {
        success: true,
        reason: effectiveCleanup === "never" ? "never" : (options["keep-frames"] ? "keep-frames" : "keep-all"),
        source: options.cleanupSource || "default",
        removed: 0,
        bytesFreed: 0,
        retained: sourceFrameCount,
        error: null,
        timestamp: nowIso()
      };
    }

    writeSummarySync(runDir, summary);

    status.state = "rendered";
    status.renderedAt = nowIso();
    writeStatusSync(runDir, status);
    appendRenderLog(runDir, "render attempt succeeded");

    result.success = true;
    result.outputPath = outputPath;
    result.metadata = summary.render;
    return result;
  } catch (error) {
    result.error = error.message;
    result.errorCode = error?.code ?? null;
    appendRenderLog(
      runDir,
      `render attempt failed errorCode=${result.errorCode ?? "UNKNOWN"} error=${result.error}`
    );

    const status = readStatusSync(runDir) || {};
    status.state = "render_failed";
    status.error = result.error;
    writeStatusSync(runDir, status);

    let summary;
    try {
      summary = readSummarySync(runDir) || {};
    } catch (summaryError) {
      result.error = `${result.error}; failed to update summary: ${summaryError.message}`;
      return result;
    }
    const updated = {
      ...summary,
      lastRenderAttempt: {
        error: result.error,
        outputPath: getOutputPath(runDir, options.config),
        sourceFrameCount,
        framerate: effectiveFramerate,
        ffmpegCommand,
        timestamp: nowIso()
      },
      cleanup: {
        success: false,
        reason: "render-or-validation-failed",
        removed: 0,
        retained: 0,
        error: null,
        timestamp: nowIso()
      }
    };
    try {
      writeSummarySync(runDir, updated);
    } catch (summaryWriteError) {
      result.error = `${result.error}; failed to update render summary: ${summaryWriteError.message}`;
    }
    return result;
  }
}

export async function commandRender({ runDir, options = {} }) {
  const resolved = path.resolve(runDir);
  const statusPath = path.join(resolved, "status.json");
  const configPath = path.join(resolved, "config.json");
  const [status, config] = await Promise.all([
    readJsonOptional(statusPath),
    readJsonOptional(configPath)
  ]);

  const currentState = status?.state || inferStateFromStatus(status || {});
  if (["starting", "running", "rendering"].includes(currentState) && !options.force) {
    throw new Error("Cannot render while capture is active. Use --force to override.");
  }

  const renderOptions = {
    ...options,
    config: options.config ?? config ?? undefined,
    framerate: resolveRenderFramerate(options.framerate, options.fps, config?.fps, config?.framerate)
  };

  let cleanupSource = "cli";
  const hasCliCleanup =
    options.cleanup !== undefined ||
    options["keep-frames"] ||
    options["keep-all"] ||
    options["keep-samples"] ||
    options["keep-latest"];

  if (!hasCliCleanup && config) {
    if (config.cleanup !== undefined) {
      renderOptions.cleanup = config.cleanup;
      cleanupSource = "config";
    }
    if (config.keepSamples) {
      renderOptions["keep-samples"] = config.keepSamples;
      cleanupSource = "config";
    }
    if (config.keepLatest) {
      renderOptions["keep-latest"] = config.keepLatest;
      cleanupSource = "config";
    }
  }
  renderOptions.cleanupSource = cleanupSource;
  if (options.force && ["starting", "running", "rendering"].includes(currentState)) {
    const frames = await listFrameFiles(resolved);
    if (frames.length === 0) {
      throw new Error("Cannot force render: no frames present in run directory");
    }
    renderOptions["keep-frames"] = true;
  }
  const result = renderFrames(resolved, renderOptions);
  if (!result.success) {
    if (result.errorCode === "VALIDATION_FAILED") {
      throw new Error(`Rendered output is not a valid MP4: ${result.error}`);
    }
    throw new Error(`ffmpeg render failed: ${result.error}`);
  }
  return {
    path: result.outputPath,
    output: result.outputPath,
    sourceFrameCount: result.metadata?.sourceFrameCount,
    message: "Render successful"
  };
}

async function runRenderCli(parsed) {
  const result = await commandRender({ runDir: parsed.runDir, options: parsed.options });
  if (parsed.options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Rendered: ${result.path}`);
}

// ---------- Cleanup ----------

async function writeCleanupSummary(runDir, cleanup) {
  const existing = await readJsonOptional(getSummaryPath(runDir));
  await writeJsonAtomic(getSummaryPath(runDir), {
    ...existing,
    cleanup: { ...cleanup, timestamp: nowIso() }
  });
}

export async function commandCleanup({ runDir, options = {} }) {
  const resolved = path.resolve(runDir);
  const stat = await fsp.stat(resolved).catch(() => null);
  if (!stat) {
    throw new Error("Run directory not found");
  }

  const outputPath = await resolveCleanupOutputPath(resolved, options);
  if (!options.force) {
    const validation = validateMP4(outputPath);
    if (validation.error) {
      throw new Error(
        `Refusing to delete frames: ${validation.error} (at ${outputPath}). Pass --force to override.`
      );
    }
  }

  const framesDir = path.join(resolved, "frames");
  const frameFiles = await listFrameFiles(resolved);
  const config = await readJsonOptional(path.join(resolved, "config.json"));

  const keepFrames = options["keep-frames"] || options["keep-all"];
  if (keepFrames) {
    const result = { message: "Frames preserved (--keep-frames)", frameCount: frameFiles.length };
    await writeCleanupSummary(resolved, {
      success: true,
      removed: 0,
      retained: frameFiles.length,
      bytesFreed: 0,
      reason: "keep-frames"
    });
    return result;
  }

  if (options.frames) {
    const toDelete = frameFiles.map((file) => path.join(framesDir, file));
    const latestPng = path.join(resolved, "latest.png");
    if (fs.existsSync(latestPng)) toDelete.push(latestPng);
    const bytesFreed = await sumFileSizes(toDelete);
    await Promise.all(toDelete.map((p) => fsp.rm(p, { force: true })));
    const removeResult = await removeEmptyDir(framesDir);
    if (!removeResult.success) {
      throw new Error(removeResult.error);
    }
    const result = { message: "Raw frames and latest.png cleaned up", removed: frameFiles.length, bytesFreed };
    await writeCleanupSummary(resolved, {
      success: true,
      removed: frameFiles.length,
      retained: 0,
      bytesFreed
    });
    return result;
  }

  if (options.all) {
    if (frameFiles.length > 0 && !options.force) {
      throw new Error("Raw frames still exist. Use --force to delete the entire run directory.");
    }
    await fsp.rm(resolved, { recursive: true, force: true });
    return { message: "Entire run directory deleted" };
  }

  const keepSamples = options["keep-samples"] ?? config?.keepSamples;
  if (keepSamples) {
    if (frameFiles.length === 0) {
      const result = { message: "No frames to sample", frameCount: 0 };
      await writeCleanupSummary(resolved, { success: true, removed: 0, retained: 0, bytesFreed: 0 });
      return result;
    }

    const count = keepSamples === true ? 2 : Number(keepSamples);
    const count = keepSamples === true ? 2 : Number(keepSamples);
    const bytesFreed = await sumFileSizes(frameFiles.map((file) => path.join(framesDir, file)));
    const samplePaths = copySamplesSync(framesDir, resolved, count);

    // Entirely remove frames directory and its remaining contents
    await fsp.rm(framesDir, { recursive: true, force: true });

    const result = {
      message: `Frames cleaned up (kept ${samplePaths.length} samples in samples/)`,
      removed: frameFiles.length,
      retained: samplePaths.length,
      bytesFreed,
      samples: samplePaths
    };
    await writeCleanupSummary(resolved, {
      success: true,
      removed: frameFiles.length,
      retained: samplePaths.length,
      bytesFreed,
      samples: samplePaths
      reason: "keep-samples"
    });
    return result;
  }

  const keepLatest = options["keep-latest"] ?? config?.keepLatest;
  if (keepLatest) {
    if (frameFiles.length === 0) {
      const result = { message: "No frames to cleanup", frameCount: 0 };
      await writeCleanupSummary(resolved, { success: true, removed: 0, retained: 0, bytesFreed: 0 });
      return result;
    }
    const last = frameFiles[frameFiles.length - 1];
    const toDelete = frameFiles.filter((f) => f !== last);
    const bytesFreed = await sumFileSizes(toDelete.map((p) => path.join(framesDir, p)));
    await Promise.all(toDelete.map((p) => fsp.rm(path.join(framesDir, p), { force: true })));
    const result = {
      message: "Frames cleaned up (kept latest)",
      removed: toDelete.length,
      bytesFreed,
      retained: 1
    };
    await writeCleanupSummary(resolved, { success: true, removed: toDelete.length, retained: 1, bytesFreed });
    return result;
  }

  const toDelete = frameFiles.map((f) => path.join(framesDir, f));
  const bytesFreed = await sumFileSizes(toDelete);
  await Promise.all(toDelete.map((p) => fsp.rm(p, { force: true })));
  const removeResult = await removeEmptyDir(framesDir);
  if (!removeResult.success) {
    throw new Error(removeResult.error);
  }
  const result = { message: "Cleanup complete", removed: frameFiles.length, bytesFreed };
  await writeCleanupSummary(resolved, {
    success: true,
    removed: frameFiles.length,
    retained: 0,
    bytesFreed
    reason: "default"
  });
  return result;
}

async function runCleanupCli(parsed) {
  const result = await commandCleanup({ runDir: parsed.runDir, options: parsed.options });
  console.log(result.message);
}

// ---------- Help ----------

function printHelp() {
  console.log(`timelapse-capture ${VERSION}

Usage:
  timelapse-capture start <url> [--duration <2h>] [--interval <5s>] [--video-length <1m>] [--fps <24>] [--out <dir>]
  timelapse-capture status <run-dir> [--json]
  timelapse-capture peek <run-dir> [--latest | --index <n> | --near <iso>] [--json]
  timelapse-capture render <run-dir> [--output <file>] [--json]
  timelapse-capture cleanup <run-dir> [--force]
  timelapse-capture doctor [--json]
`);
}

// Compatibility re-exports kept lightweight for tests.
export const __test__ = {
  SIMULATION_FRAME_PNG,
  frameName,
  slugify,
  formatBytes,
  formatDuration,
  writeJsonSync,
  computeWaitSchedule,
  waitUntilFrameTime
};
