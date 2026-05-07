const assert = require('node:assert');
const test = require('node:test');

const {
  BACKEND_MIN_INTERVAL_MS,
  ParseError,
  parseArgs,
  parseDuration,
  parseViewport,
  validateBackendInterval,
} = require('../src/cli/parser.js');

test('parses durations from simple units', () => {
  assert.deepEqual(parseDuration('10s'), { input: '10s', ms: 10_000 });
  assert.deepEqual(parseDuration('2m30s'), { input: '2m30s', ms: 150_000 });
  assert.deepEqual(parseDuration('1h'), { input: '1h', ms: 3_600_000 });
});

test('parses viewport dimensions', () => {
  assert.deepEqual(parseViewport('1280x800'), { input: '1280x800', width: 1280, height: 800 });
});

test('parses positional run directory argument', () => {
  const parsed = parseArgs(['status', 'runs/issue-8']);
  assert.equal(parsed.command, 'status');
  assert.equal(parsed.runDir, 'runs/issue-8');
  assert.equal(parsed.positionals.length, 1);
});

test('parses boolean flags', () => {
  const parsed = parseArgs(['start', 'https://example.com', '--json', '--force']);
  assert.equal(parsed.options.json, true);
  assert.equal(parsed.options.force, true);
});

test('parses value flags for start', () => {
  const parsed = parseArgs(['start', 'https://example.com', '--duration', '10s', '--viewport', '1280x800']);
  assert.equal(parsed.target, 'https://example.com');
  assert.equal(parsed.options.duration.ms, 10_000);
  assert.equal(parsed.options.viewport.width, 1280);
});

test('parses computed interval and force flags for start', () => {
  const parsed = parseArgs([
    'start',
    'https://example.com',
    '--video-length',
    '1m',
    '--fps',
    '24',
    '--duration',
    '2h',
    '--force-interval',
  ]);

  assert.equal(parsed.options['video-length'].ms, 60_000);
  assert.equal(parsed.options.fps, 24);
  assert.equal(parsed.options['force-interval'], true);
});

test('rejects malformed fps inputs', () => {
  for (const value of ['0', '-1', 'nan', 'Infinity']) {
    assert.throws(() => parseArgs(['start', 'https://example.com', '--fps', value]), {
      name: 'ParseError',
      code: 'E_BAD_FPS',
    });
  }
});

test('validates backend interval minimums', () => {
  assert.equal(BACKEND_MIN_INTERVAL_MS['playwright-url'], 250);

  assert.throws(
    () => validateBackendInterval({ backend: 'playwright-url', intervalMs: 100, force: false }),
    (error) => error instanceof ParseError
      && error.code === 'E_INTERVAL_TOO_SMALL'
      && error.message.includes('below playwright-url minimum 250ms'),
  );

  assert.deepEqual(
    validateBackendInterval({ backend: 'playwright-url', intervalMs: 100, force: true }),
    { ok: true, intervalMs: 100, minimumMs: 250, forced: true, belowMinimum: true },
  );
  assert.deepEqual(
    validateBackendInterval({ backend: 'playwright-url', intervalMs: 250, force: false }),
    { ok: true, intervalMs: 250, minimumMs: 250, forced: false, belowMinimum: false },
  );
  assert.deepEqual(
    validateBackendInterval({ backend: 'playwright-url', intervalMs: 500, force: false }),
    { ok: true, intervalMs: 500, minimumMs: 250, forced: false, belowMinimum: false },
  );
});

test('rejects malformed duration inputs', () => {
  assert.throws(() => parseArgs(['start', 'https://example.com', '--duration', '99x']), {
    name: 'ParseError',
    code: 'E_BAD_DURATION',
  });
});

test('rejects malformed viewport inputs', () => {
  for (const value of ['1280', '1280x', 'x800']) {
    assert.throws(() => parseArgs(['start', 'https://example.com', '--viewport', value]), {
      name: 'ParseError',
      code: 'E_BAD_VIEWPORT',
    });
  }
});

test('requires values for value flags', () => {
  assert.throws(() => parseArgs(['start', 'https://example.com', '--duration']), {
    name: 'ParseError',
    code: 'E_MISSING_VALUE',
  });
});

test('rejects unknown command', () => {
  assert.throws(() => parseArgs(['unknown']), {
    name: 'ParseError',
    code: 'E_UNKNOWN_COMMAND',
  });
});

test('rejects too many positional arguments', () => {
  assert.throws(() => parseArgs(['status', 'runs/issue-8', 'extra']), {
    name: 'ParseError',
    code: 'E_EXTRA_ARGUMENT',
  });
});

test('parses index and near flags', () => {
  const parsed = parseArgs(['peek', 'runs/issue-8', '--index', '2', '--near', '4']);
  assert.equal(parsed.options.index, 2);
  assert.equal(parsed.options.near, 4);
});
