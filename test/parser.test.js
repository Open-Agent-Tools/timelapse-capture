import { strict as assert } from 'node:assert';
import test from 'node:test';
import parserModule from '../src/cli/parser.js';

const { parseArgs, parseDuration, parseViewport } = parserModule;

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

test('rejects malformed numeric index values', () => {
  assert.throws(() => parseArgs(['peek', 'runs/issue-8', '--index', '2abc']), {
    name: 'ParseError',
    code: 'E_BAD_INDEX',
  });
  assert.throws(() => parseArgs(['peek', 'runs/issue-8', '--near', '4ms']), {
    name: 'ParseError',
    code: 'E_BAD_INDEX',
  });
});

test('rejects unsupported negated flag for command', () => {
  assert.throws(() => parseArgs(['doctor', '--no-force']), {
    name: 'ParseError',
    code: 'E_UNKNOWN_FLAG',
  });
});

test('accepts valid negated boolean flag for command', () => {
  const parsed = parseArgs(['status', 'runs/issue-8', '--no-json']);
  assert.equal(parsed.options.json, false);
});
