const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const http = require('node:http');
const test = require('node:test');

const CLI_PATH = path.join(__dirname, '..', 'src', 'cli', 'index.js');

function runCli({ cwd, args, env = {} }) {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
    },
  });

  if (result.status !== 0) {
    throw new Error(`cli failed (${result.status}): ${result.stdout}\n${result.stderr}`);
  }

  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr,
  };
}

async function withServer(handler) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'timelapse-smoke-page-'));
  const indexPath = path.join(dir, 'index.html');
  await fs.writeFile(indexPath, '<!doctype html><body>timelapse smoke</body></html>');

  const server = http.createServer(async (req, res) => {
    if (req.url === '/index.html' || req.url === '/') {
      const body = await fs.readFile(indexPath);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    await handler(`http://127.0.0.1:${port}/index.html`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function assertRunArtifacts(runDir) {
  const required = ['config.json', 'manifest.json', 'job.json', 'status.json'];
  for (const file of required) {
    await fs.access(path.join(runDir, file));
  }

  const frames = await fs.readdir(path.join(runDir, 'frames'));
  const pngs = frames.filter((entry) => entry.endsWith('.png'));
  assert.ok(pngs.length > 0);
}

test('CLI smoke flow creates run artifacts and supports status/peek', async () => {
  await withServer(async (url) => {
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'timelapse-work-'));

    const startOutput = runCli({
      cwd: workdir,
      args: ['start', url, '--json', '--interval', '100ms', '--duration', '1s'],
      env: {
        TIMELAPSE_SIMULATE_FRAMES: '3',
      },
    });

    const startData = JSON.parse(startOutput.stdout);
    const runDir = startData.runDir;

    await assertRunArtifacts(runDir);

    const statusOutput = runCli({
      cwd: workdir,
      args: ['status', runDir, '--json'],
    });
    const statusData = JSON.parse(statusOutput.stdout);
    assert.equal(statusData.frameCount, 3);
    assert.equal(statusData.failedFrameCount, 0);
    assert.ok(typeof statusData.latestFrame === 'string');
    assert.ok(statusData.elapsedMs >= 0);

    const peekLatest = JSON.parse(runCli({ cwd: workdir, args: ['peek', runDir, '--latest', '--json'] }).stdout);
    const peekIndex = JSON.parse(runCli({ cwd: workdir, args: ['peek', runDir, '--index', '0', '--json'] }).stdout);
    const peekNear = JSON.parse(runCli({ cwd: workdir, args: ['peek', runDir, '--near', '1', '--json'] }).stdout);

    assert.ok(peekLatest.path.endsWith('.png'));
    assert.ok(peekIndex.path.endsWith('.png'));
    assert.ok(peekNear.path.endsWith('.png'));
    assert.equal(peekLatest.path, statusData.latestFrame);
    assert.equal(peekIndex.path, path.join(runDir, 'frames', 'frame-0001.png'));
    assert.equal(peekNear.path, path.join(runDir, 'frames', 'frame-0002.png'));

    const contents = await Promise.all([
      fs.readFile(peekLatest.path),
      fs.readFile(peekIndex.path),
      fs.readFile(peekNear.path),
    ]);
    for (const file of contents) {
      assert.ok(file.length > 0);
    }

    await fs.rm(workdir, { recursive: true, force: true });
  });
});

test('failed frame attempts preserve previous successful frame', async () => {
  await withServer(async (url) => {
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'timelapse-work-fail-'));

    const startOutput = runCli({
      cwd: workdir,
      args: ['start', url, '--json', '--interval', '100ms'],
      env: {
        TIMELAPSE_SIMULATE_FRAMES: '2',
        TIMELAPSE_SIMULATE_FRAME_FAILURE: '1',
      },
    });

    const startData = JSON.parse(startOutput.stdout);
    const runDir = startData.runDir;

    const status = JSON.parse(runCli({ cwd: workdir, args: ['status', runDir, '--json'] }).stdout);
    assert.equal(status.frameCount, 1);
    assert.equal(status.failedFrameCount, 1);
    assert.equal(status.latestFrame, path.join(runDir, 'frames', 'frame-0001.png'));

    const secondStatus = JSON.parse(runCli({ cwd: workdir, args: ['status', runDir, '--json'] }).stdout);
    assert.equal(secondStatus.latestFrame, status.latestFrame);

    await fs.rm(workdir, { recursive: true, force: true });
  });
});
