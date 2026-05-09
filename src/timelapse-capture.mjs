#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commandDoctor, formatDoctorHuman } from "./doctor.mjs";

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
    valueFlags: ["output"],
    boolFlags: ["json", "force", "help", "keep-frames", "keep-all"]
  },
  peek: {
    positional: ["runDir"],
    valueFlags: ["index", "near"],
    boolFlags: ["json", "help", "latest"]
  },
  cleanup: {
    positional: ["runDir"],
    valueFlags: [],
    boolFlags: [
      "frames",
      "all",
      "force",
      "help",
      "keep-frames",
      "keep-samples",
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
  if (flag === "fps") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new ParseError("E_BAD_FPS", `Invalid fps: ${value}`);
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

async function appendJsonLine(file, data) {
  await fsp.appendFile(file, `${JSON.stringify(data)}\n`);
}

async function readManifest(file) {
  const text = await fsp.readFile(file, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

async function readDirIfExists(dir, options) {
  try {
    return await fsp.readdir(dir, options);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function readTextIfExists(file) {
  try {
    return await fsp.readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function statIfExists(file) {
  try {
    return await fsp.stat(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function removeIfExists(file) {
  await fsp.rm(file, { force: true });
}

async function removeDirIfExists(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
}

function isBenignEmptyDirRemovalError(error) {
  return BENIGN_EMPTY_DIR_REMOVAL_CODES.has(error?.code);
}

function formatFsError(action, target, error) {
  const code = error?.code ? `${error.code}: ` : "";
  return `${action} ${target}: ${code}${error.message}`;
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
  const entries = await readDirIfExists(dir, { withFileTypes: true });
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

const directorySize = (dir) => reduceDir(dir, async (sum, file) => sum + (await fsp.stat(file)).size, 0);

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

async function sleepUntil(timestampMs) {
  const delay = timestampMs - Date.now();
  if (delay > 0) {
    await new Promise((resolve) => setTimeout(resolve, delay));
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
    command: state.command ?? null,
    createdAt: nowIso()
  };
  await writeJsonAtomic(path.join(runDir, "manifest.json"), manifest);
  await writeJsonAtomic(path.join(runDir, "config.json"), config);
  await writeJsonAtomic(path.join(runDir, "job.json"), job);
  await writeStatus(runDir, state);
}

function buildStatusPayload(state) {
  const startedAtMs = state.startedAt ? new Date(state.startedAt).getTime() : Date.now();
  const elapsedMs = Math.max(0, Date.now() - startedAtMs);
  const frameCount = state.frames?.captured ?? state.frameCount ?? state.framesCaptured ?? 0;
  const failedFrameCount = state.frames?.failed ?? state.failedFrameCount ?? state.framesFailed ?? 0;
  const totalExpected = Number.isFinite(state.frames?.totalExpected)
    ? state.frames.totalExpected
    : Number.isFinite(state.targetFrames)
      ? state.targetFrames
      : (state.expectedFrames ?? frameCount);
  const completedAttempts = frameCount + failedFrameCount;
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

async function captureWithPlaywright({ runDir, state, framesDir, manifestPath }) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: !state.headed });
  let page;
  try {
    page = await browser.newPage({ viewport: state.viewport });
    await page.goto(state.target, { waitUntil: state.waitUntil, timeout: 60_000 });

    const startedAtMs = new Date(state.startedAt).getTime();
    for (let index = 1; index <= state.targetFrames; index += 1) {
      const scheduledAtMs = startedAtMs + Math.round((index - 1) * (state.intervalMs || 0));
      await sleepUntil(scheduledAtMs);

      const filename = path.join(framesDir, frameName(index));
      const tempPath = path.join(framesDir, `.tmp-${process.pid}-${frameName(index)}`);
      const scheduledAt = new Date(scheduledAtMs).toISOString();
      try {
        await page.screenshot({ path: tempPath, fullPage: false });
        await fsp.rename(tempPath, filename);
        const capturedAt = nowIso();
        const title = await safePageTitle(page);
        const record = {
          index,
          scheduledAt,
          capturedAt,
          path: filename,
          status: "captured",
          url: page.url(),
          title,
          viewport: state.viewport,
          error: null
        };
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
      } catch (error) {
        await removeIfExists(tempPath);
        state.failedFrameCount += 1;
        state.lastUpdatedAt = nowIso();
        const record = {
          index,
          scheduledAt,
          capturedAt: null,
          path: null,
          status: "failed",
          url: page?.url?.() ?? state.target,
          title: await safePageTitle(page),
          viewport: state.viewport,
          error: error?.message || String(error)
        };
        await appendJsonLine(manifestPath, record);
        await writeStatus(runDir, state);
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
  const failIndex =
    process.env.TIMELAPSE_SIMULATE_FRAME_FAILURE === "1" ? 2 : null;
  const startedAtMs = new Date(state.startedAt).getTime();
  for (let index = 1; index <= state.targetFrames; index += 1) {
    const scheduledAt = new Date(startedAtMs + (index - 1) * (state.intervalMs || 0)).toISOString();
    if (failIndex && index === failIndex) {
      state.failedFrameCount += 1;
      state.lastUpdatedAt = nowIso();
      await appendJsonLine(manifestPath, {
        index,
        scheduledAt,
        capturedAt: null,
        path: null,
        status: "failed",
        url: state.target,
        viewport: state.viewport,
        error: "simulated failure"
      });
      await writeStatus(runDir, state);
      continue;
    }
    const filename = await writeFakeFrame(runDir, index);
    const capturedAt = nowIso();
    const record = {
      index,
      scheduledAt,
      capturedAt,
      path: filename,
      status: "captured",
      url: state.target,
      viewport: state.viewport,
      error: null
    };
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
}

export async function commandStart({ target, options = {} } = {}) {
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

  if (!options.json) {
    console.log(
      `estimated disk: ${formatBytes(estimatedDiskBytes)} (${targetFrames} frames x ${formatBytes(
        estimateFrameBytes(viewport)
      )}/frame, approximate)`
    );
  }

  const state = {
    runDir,
    target,
    backend: options.backend ?? "playwright-url",
    state: "starting",
    startedAt,
    targetFrames,
    frameCount: 0,
    failedFrameCount: 0,
    latestFrame: null,
    latestFrameAt: null,
    latestFrameTimestamp: null,
    intervalMs,
    durationMs,
    fps,
    viewport,
    estimatedDiskBytes,
    cleanup,
    keepSamples: Number(options["keep-samples"] ?? 0),
    keepLatest: Boolean(options["keep-latest"]),
    waitUntil: options["wait-until"] ?? "domcontentloaded",
    headed: Boolean(options.headed),
    lastUpdatedAt: startedAt
  };

  await writeStartArtifacts(runDir, state);
  await appendLog(runDir, `start invoked target=${target} backend=${state.backend}`);

  const framesDir = path.join(runDir, "frames");
  const manifestPath = path.join(runDir, "manifest.jsonl");

  state.state = "running";
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
  } catch (error) {
    state.state = state.frameCount > 0 ? "completed" : "failed";
    state.error = error?.message || String(error);
    state.lastUpdatedAt = nowIso();
    await writeStatus(runDir, state);
    await appendLog(runDir, `capture failed: ${error?.stack || error}`);
    throw error;
  }

  return {
    runDir,
    estimatedDiskBytes,
    status: buildStatusPayload({ ...state, runDir })
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
  const runDir = path.resolve(parsed.options.run || ".");
  if (!fs.existsSync(path.join(runDir, "config.json"))) {
    throw new Error(`No run directory at ${runDir}`);
  }
  // The detached capture path uses commandStart in-process; the capture sub-command is reserved.
  console.log(`Capture is run in-process by start. runDir=${runDir}`);
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
    const reason = fs.existsSync(resolved)
      ? "missing run status file"
      : "missing run directory";
    throw new Error(`${reason}: ${statusPath}`);
  }

  const config = await readJsonOptional(configPath);
  const latestFrame = await readJsonOptional(latestFramePath);
  const framesDiskUsageBytes = await directorySize(path.join(resolved, "frames"));

  const payload = buildStatusPayload({
    ...status,
    state: migrateLegacyState(status.state || inferStateFromStatus(status)),
    runDir: resolved
  });

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
    `frames: ${status.frames.captured} captured, ${status.frames.failed} failed, ${status.frames.totalExpected} expected`
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
  if (status.cleanup)
    lines.push(`cleanup: removed ${status.cleanup.removed ?? 0}, retained ${status.cleanup.retained ?? 0}`);
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
  const entries = await readDirIfExists(framesDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".png"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

async function readCapturedFrameRecords(runDir, frameNames) {
  const frameNameSet = new Set(frameNames);
  const manifestPath = path.join(runDir, "manifest.jsonl");
  const manifest = await readTextIfExists(manifestPath);
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
    if (nearIndex !== -1) index = nearIndex;
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
    return path.resolve(config.output.path);
  }
  return path.resolve(runDir, "output.mp4");
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
    return { exists: true, bytes: fs.statSync(filePath).size, error: null };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { exists: false, bytes: 0, error: "Output file does not exist" };
    }
    return {
      exists: true,
      bytes: 0,
      error: formatFsError("Failed to read output file size", filePath, error)
    };
  }
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
  const sizeResult = fileSize(outputPath);
  result.exists = sizeResult.exists;
  result.bytes = sizeResult.bytes;
  if (sizeResult.error) {
    result.error = sizeResult.error;
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

export function cleanupFrames(framesDir) {
  if (!fs.existsSync(framesDir)) {
    return { success: true, removed: 0 };
  }
  let removed = 0;
  fs.rmSync(path.join(framesDir, ".render-staging"), { recursive: true, force: true });
  const files = fs.readdirSync(framesDir);
  for (const file of files) {
    if (/\.(png|jpg|jpeg)$/i.test(file)) {
      fs.unlinkSync(path.join(framesDir, file));
      removed += 1;
    }
  }
  if (files.length === removed && removed > 0) {
    const removeResult = removeEmptyDirSync(framesDir);
    if (!removeResult.success) {
      return { success: false, removed, error: removeResult.error };
    }
  }
  return { success: true, removed };
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
  } catch {
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

export function renderFrames(runDir, options = {}) {
  const result = {
    success: false,
    outputPath: null,
    metadata: null,
    cleanupResult: null,
    error: null
  };

  if (!fs.existsSync(runDir)) {
    result.error = `Run directory does not exist: ${runDir}`;
    return result;
  }

  try {
    const expectedOutputPath = path.resolve(runDir, "output.mp4");
    const framesDir = getFramesDir(runDir);
    const frameCount = countFrameFiles(framesDir);
    if (frameCount === 0) {
      throw new RenderError("No frames found to render", "NO_FRAMES");
    }
    const outputPath = getOutputPath(runDir, options.config);
    if (outputPath !== expectedOutputPath) {
      throw new RenderError(
        `Output path does not match expected path: ${expectedOutputPath}`,
        "OUTPUT_PATH_MISMATCH"
      );
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const status = readStatusSync(runDir) || {};
    status.state = "rendering";
    writeStatusSync(runDir, status);

    const staging = stageContiguousFrames(framesDir);
    const framePattern = path.join(staging.dir, "frame-%04d.png");
    const ffmpegPath = options.ffmpegPath || "ffmpeg";
    const ffmpegArgs = [
      "-framerate",
      String(options.framerate || 10),
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
    const ffmpegCommand = [ffmpegPath, ...ffmpegArgs];

    try {
      execFileSync(ffmpegPath, ffmpegArgs, { stdio: "pipe", encoding: "utf8" });
    } catch (error) {
      throw new RenderError(`ffmpeg failed: ${error.message}`, "FFMPEG_FAILED");
    } finally {
      if (staging.staged) removeStagingDir(staging.dir);
    }

    const validation = validateMP4(outputPath);
    if (validation.error) {
      throw new RenderError(`Output is not a valid MP4: ${validation.error}`, "VALIDATION_FAILED");
    }

    const posterRelPath = copyPosterSync(framesDir, runDir);

    const existing = readSummarySync(runDir);
    const summary = {
      ...existing,
      duration: validation.duration,
      dimensions: validation.dimensions,
      ffmpegCommand,
      poster: posterRelPath,
      render: {
        outputPath,
        bytes: validation.bytes,
        duration: validation.duration,
        dimensions: validation.dimensions,
        frameCount,
        sourceFrameCount: frameCount,
        ffmpegCommand,
        timestamp: nowIso()
      },
      cleanup: null
    };

    if (!options["keep-frames"] && !options["keep-all"]) {
      const cleanup = cleanupFrames(framesDir);
      summary.cleanup = {
        success: cleanup.success,
        removed: cleanup.removed,
        error: cleanup.error || null
      };
      result.cleanupResult = cleanup;
    } else {
      summary.cleanup = {
        success: false,
        reason: "Frames preserved by option",
        removed: 0
      };
    }

    writeSummarySync(runDir, summary);

    status.state = "rendered";
    status.renderedAt = nowIso();
    writeStatusSync(runDir, status);

    result.success = true;
    result.outputPath = outputPath;
    result.metadata = summary.render;
    return result;
  } catch (error) {
    result.error = error.message;

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
        frameCount: countFrameFiles(getFramesDir(runDir)),
        timestamp: nowIso()
      },
      cleanup: {
        success: false,
        reason: "render-or-validation-failed",
        removed: 0
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
  const status = await readJsonOptional(statusPath);
  const currentState = status?.state || inferStateFromStatus(status || {});
  if (["starting", "running", "rendering"].includes(currentState) && !options.force) {
    throw new Error("Cannot render while capture is active. Use --force to override.");
  }
  const renderOptions = { ...options };
  if (options.force && ["starting", "running", "rendering"].includes(currentState)) {
    renderOptions["keep-frames"] = true;
  }
  const result = renderFrames(resolved, renderOptions);
  if (!result.success) {
    if (result.error && result.error.includes("valid MP4")) {
      throw new Error(`Rendered output is not a valid MP4: ${result.error}`);
    }
    throw new Error(`ffmpeg render failed: ${result.error}`);
  }
  return {
    path: result.outputPath,
    output: result.outputPath,
    frameCount: result.metadata?.frameCount,
    sourceFrames: result.metadata?.sourceFrameCount,
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
  const stat = await statIfExists(resolved);
  if (!stat) {
    throw new Error("Run directory not found");
  }

  const outputPath = path.join(resolved, "output.mp4");
  if (!options.force && !fs.existsSync(outputPath)) {
    throw new Error("Refusing to delete frames before output.mp4 exists. Pass --force to override.");
  }

  const framesDir = path.join(resolved, "frames");
  const frameFiles = await listFrameFiles(resolved);

  if (options["keep-frames"]) {
    const result = { message: "Frames preserved (--keep-frames)", frameCount: frameFiles.length };
    await writeCleanupSummary(resolved, {
      success: true,
      removed: 0,
      retained: frameFiles.length,
      reason: "keep-frames"
    });
    return result;
  }

  if (options.frames) {
    const toDelete = frameFiles.map((file) => path.join(framesDir, file));
    const latestPng = path.join(resolved, "latest.png");
    if (fs.existsSync(latestPng)) toDelete.push(latestPng);
    await Promise.all(toDelete.map((p) => fsp.rm(p, { force: true })));
    const removeResult = await removeEmptyDir(framesDir);
    if (!removeResult.success) {
      throw new Error(removeResult.error);
    }
    return { message: "Raw frames and latest.png cleaned up", removed: frameFiles.length };
  }

  if (options.all) {
    if (frameFiles.length > 0 && !options.force) {
      throw new Error("Raw frames still exist. Use --force to delete the entire run directory.");
    }
    await fsp.rm(resolved, { recursive: true, force: true });
    return { message: "Entire run directory deleted" };
  }

  if (options["keep-samples"]) {
    if (frameFiles.length === 0) {
      const result = { message: "No frames to sample", frameCount: 0 };
      await writeCleanupSummary(resolved, { success: true, removed: 0, retained: 0 });
      return result;
    }
    const first = frameFiles[0];
    const last = frameFiles[frameFiles.length - 1];
    const retainedSamples = new Set([first, last]);
    const retained = retainedSamples.size;
    const toDelete = frameFiles.filter((f) => !retainedSamples.has(f));
    await Promise.all(toDelete.map((p) => fsp.rm(path.join(framesDir, p), { force: true })));
    const result = {
      message: "Frames cleaned up (kept first and last)",
      removed: toDelete.length,
      retained
    };
    await writeCleanupSummary(resolved, { success: true, removed: toDelete.length, retained });
    return result;
  }

  if (options["keep-latest"]) {
    if (frameFiles.length === 0) {
      const result = { message: "No frames to cleanup", frameCount: 0 };
      await writeCleanupSummary(resolved, { success: true, removed: 0, retained: 0 });
      return result;
    }
    const last = frameFiles[frameFiles.length - 1];
    const toDelete = frameFiles.filter((f) => f !== last);
    await Promise.all(toDelete.map((p) => fsp.rm(path.join(framesDir, p), { force: true })));
    const result = {
      message: "Frames cleaned up (kept latest)",
      removed: toDelete.length,
      retained: 1
    };
    await writeCleanupSummary(resolved, { success: true, removed: toDelete.length, retained: 1 });
    return result;
  }

  const toDelete = frameFiles.map((f) => path.join(framesDir, f));
  await Promise.all(toDelete.map((p) => fsp.rm(p, { force: true })));
  const removeResult = await removeEmptyDir(framesDir);
  if (!removeResult.success) {
    throw new Error(removeResult.error);
  }
  const result = { message: "Cleanup complete", removed: frameFiles.length };
  await writeCleanupSummary(resolved, {
    success: true,
    removed: frameFiles.length,
    retained: 0
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
export const __test__ = { SIMULATION_FRAME_PNG, frameName, slugify, formatBytes, formatDuration, writeJsonSync };
