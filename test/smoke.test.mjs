import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import http from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, "..", "src", "timelapse-capture.mjs");

function runCli({ cwd, args, env = {} }) {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
  if (result.status !== 0) {
    throw new Error(
      `cli failed (${result.status}): ${result.stdout}\n${result.stderr}`
    );
  }
  return { stdout: result.stdout.trim(), stderr: result.stderr };
}

function runCliRaw({ cwd, args, env = {} }) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
}

async function withServer(handler) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "timelapse-smoke-page-"));
  const indexPath = path.join(dir, "index.html");
  await fs.writeFile(indexPath, "<!doctype html><body>timelapse smoke</body></html>");

  const server = http.createServer(async (req, res) => {
    if (req.url === "/index.html" || req.url === "/") {
      const body = await fs.readFile(indexPath);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    await handler(`http://127.0.0.1:${port}/index.html`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function assertRunArtifacts(runDir) {
  for (const file of ["config.json", "manifest.json", "job.json", "status.json"]) {
    await fs.access(path.join(runDir, file));
  }
  const frames = await fs.readdir(path.join(runDir, "frames"));
  assert.ok(frames.filter((f) => f.endsWith(".png")).length > 0);
}

test("CLI smoke flow creates run artifacts and supports status/peek", async () => {
  await withServer(async (url) => {
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "timelapse-work-"));
    const startOutput = runCli({
      cwd: workdir,
      args: ["start", url, "--json", "--interval", "100ms", "--duration", "1s"],
      env: { TIMELAPSE_SIMULATE_FRAMES: "3" }
    });

    const startData = JSON.parse(startOutput.stdout);
    const runDir = startData.runDir;

    await assertRunArtifacts(runDir);
    assert.equal(Number.isInteger(startData.estimatedDiskBytes), true);
    assert.ok(startData.estimatedDiskBytes > 0);

    const config = JSON.parse(await fs.readFile(path.join(runDir, "config.json"), "utf8"));
    assert.equal(config.estimatedDiskBytes, startData.estimatedDiskBytes);

    const statusOutput = runCli({
      cwd: workdir,
      args: ["status", runDir, "--json"]
    });
    const statusData = JSON.parse(statusOutput.stdout);
    assert.equal(statusData.state, "completed");
    assert.equal(statusData.frameCount, 3);
    assert.equal(statusData.failedFrameCount, 0);
    assert.equal(typeof statusData.latestFrame, "string");
    assert.ok(statusData.latestFrame.endsWith(".png"));
    assert.ok(statusData.elapsedMs >= 0);
    assert.equal(typeof statusData.etaMs, "number");
    assert.equal(statusData.estimatedDiskBytes, startData.estimatedDiskBytes);

    const peekLatest = JSON.parse(
      runCli({ cwd: workdir, args: ["peek", runDir, "--latest", "--json"] }).stdout
    );
    const peekIndex = JSON.parse(
      runCli({ cwd: workdir, args: ["peek", runDir, "--index", "0", "--json"] }).stdout
    );
    const peekNear = JSON.parse(
      runCli({ cwd: workdir, args: ["peek", runDir, "--near", "1", "--json"] }).stdout
    );

    assert.ok(peekLatest.path.endsWith(".png"));
    assert.ok(peekIndex.path.endsWith(".png"));
    assert.ok(peekNear.path.endsWith(".png"));
    assert.equal(peekLatest.path, statusData.latestFrame);
    assert.equal(peekIndex.path, path.join(runDir, "frames", "frame-0001.png"));
    assert.equal(peekNear.path, path.join(runDir, "frames", "frame-0002.png"));

    const contents = await Promise.all([
      fs.readFile(peekLatest.path),
      fs.readFile(peekIndex.path),
      fs.readFile(peekNear.path)
    ]);
    for (const file of contents) {
      assert.ok(file.length > 0);
    }

    await fs.rm(workdir, { recursive: true, force: true });
  });
});

test("start human output prints approximate estimated disk usage", async () => {
  await withServer(async (url) => {
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "timelapse-human-start-"));
    try {
      const runDir = path.join(workdir, "run");
      const output = runCli({
        cwd: workdir,
        args: ["start", url, "--out", runDir, "--interval", "100ms", "--duration", "1s"],
        env: { TIMELAPSE_SIMULATE_FRAMES: "2" }
      });

      assert.match(output.stdout, /estimated disk:/i);
      assert.match(output.stdout, /approximate/i);
    } finally {
      await fs.rm(workdir, { recursive: true, force: true });
    }
  });
});

test("failed frame attempts preserve previous successful frame", async () => {
  await withServer(async (url) => {
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "timelapse-work-fail-"));
    const startOutput = runCli({
      cwd: workdir,
      args: ["start", url, "--json", "--interval", "100ms"],
      env: {
        TIMELAPSE_SIMULATE_FRAMES: "2",
        TIMELAPSE_SIMULATE_FRAME_FAILURE: "1"
      }
    });

    const startData = JSON.parse(startOutput.stdout);
    const runDir = startData.runDir;

    const status = JSON.parse(
      runCli({ cwd: workdir, args: ["status", runDir, "--json"] }).stdout
    );
    assert.equal(status.frameCount, 1);
    assert.equal(status.failedFrameCount, 1);
    assert.equal(status.latestFrame, path.join(runDir, "frames", "frame-0001.png"));

    const secondStatus = JSON.parse(
      runCli({ cwd: workdir, args: ["status", runDir, "--json"] }).stdout
    );
    assert.equal(secondStatus.latestFrame, status.latestFrame);

    await fs.rm(workdir, { recursive: true, force: true });
  });
});

test("status reports enriched JSON and human progress details", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "timelapse-status-"));
  const framesDir = path.join(runDir, "frames");
  await fs.mkdir(framesDir);

  const latestFrame = path.join(framesDir, "frame-0002.png");
  await fs.writeFile(path.join(framesDir, "frame-0001.png"), "first");
  await fs.writeFile(latestFrame, "second");
  await fs.writeFile(path.join(runDir, "output.mp4"), "rendered");
  await fs.writeFile(
    path.join(runDir, "config.json"),
    `${JSON.stringify({ estimatedDiskBytes: 2_000_000 }, null, 2)}\n`
  );

  const startedAt = new Date(Date.now() - 20_000).toISOString();
  const latestFrameTimestamp = new Date(Date.now() - 10_000).toISOString();
  await fs.writeFile(
    path.join(runDir, "status.json"),
    `${JSON.stringify(
      {
        runDir,
        state: "running",
        frameCount: 2,
        failedFrameCount: 1,
        latestFrame,
        latestFrameTimestamp,
        intervalMs: 1000,
        targetFrames: 5,
        startedAt,
        lastUpdatedAt: latestFrameTimestamp
      },
      null,
      2
    )}\n`
  );
  await fs.writeFile(
    path.join(runDir, "run-summary.json"),
    `${JSON.stringify(
      {
        render: { outputPath: path.join(runDir, "output.mp4") },
        cleanup: { success: true, removed: 3, retained: 1 }
      },
      null,
      2
    )}\n`
  );

  try {
    const jsonStatus = JSON.parse(
      runCli({ cwd: runDir, args: ["status", runDir, "--json"] }).stdout
    );
    assert.deepEqual(jsonStatus.frames, {
      captured: 2,
      failed: 1,
      totalExpected: 5
    });
    assert.equal(jsonStatus.latestFrame, latestFrame);
    assert.equal(jsonStatus.latestFrameTimestamp, latestFrameTimestamp);
    assert.equal(jsonStatus.staleWarning.isStale, true);
    assert.ok(jsonStatus.diskUsage.runDirBytes > jsonStatus.diskUsage.framesBytes);
    assert.equal(jsonStatus.estimatedDiskBytes, 2_000_000);
    assert.equal(jsonStatus.outputPath, path.join(runDir, "output.mp4"));
    assert.deepEqual(jsonStatus.cleanup, {
      success: true,
      removed: 3,
      retained: 1
    });

    const humanStatus = runCli({ cwd: runDir, args: ["status", runDir] }).stdout;
    assert.match(humanStatus, /state: running/);
    assert.match(humanStatus, /elapsed:/);
    assert.match(humanStatus, /eta:/);
    assert.match(humanStatus, /frames: 2 captured, 1 failed, 5 expected/);
    assert.match(humanStatus, /latest successful frame:/);
    assert.match(humanStatus, /warning: latest successful frame is stale/);
    assert.match(humanStatus, /disk usage:/);
    assert.match(humanStatus, /estimated disk:/);
    assert.match(humanStatus, /output: .*output\.mp4/);
    assert.match(humanStatus, /cleanup: removed 3, retained 1/);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("status reports missing run status file clearly", async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "timelapse-missing-status-"));
  try {
    const result = runCliRaw({ cwd: runDir, args: ["status", runDir] });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing run status file:/);
    assert.match(result.stderr, /status\.json/);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
});
