'use strict';

class ParseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ParseError';
    this.code = code;
  }
}

const COMMANDS = {
  start: { positional: ['target'], valueFlags: ['duration', 'viewport', 'interval'], boolFlags: ['json', 'force', 'help'] },
  status: { positional: ['runDir'], valueFlags: [], boolFlags: ['json', 'help'] },
  render: { positional: ['runDir'], valueFlags: [], boolFlags: ['force', 'help'] },
  peek: { positional: ['runDir'], valueFlags: ['index', 'near'], boolFlags: ['json', 'help', 'latest'] },
  cleanup: { positional: ['runDir'], valueFlags: [], boolFlags: ['frames', 'all', 'force', 'help', 'keep-frames', 'keep-samples', 'keep-latest'] },
  doctor: { positional: [], valueFlags: [], boolFlags: ['json', 'help'] },
};

function stripDash(name) {
  return name.replace(/^--?/, '');
}

function normalizeBoolFlag(flag) {
  if (flag.startsWith('--no-')) {
    return {
      key: stripDash(flag.slice(5)),
      value: false,
    };
  }
  if (flag.startsWith('--')) {
    return { key: stripDash(flag.slice(2)), value: true };
  }
  if (flag.startsWith('-') && flag.length === 2) {
    const shorthand = flag[1];
    const long = {
      j: 'json',
      f: 'force',
      h: 'help',
    }[shorthand];
    if (!long) {
      throw new ParseError('E_UNKNOWN_FLAG', `Unknown short flag: ${flag}`);
    }
    return { key: long, value: true };
  }
  throw new ParseError('E_UNKNOWN_FLAG', `Unknown flag format: ${flag}`);
}

function parseDuration(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new ParseError('E_BAD_DURATION', `Invalid duration: ${input}`);
  }

  const normalized = input.toLowerCase();
  const matches = normalized.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?(?:(\d+)ms)?$/);
  if (!matches) {
    throw new ParseError('E_BAD_DURATION', `Invalid duration: ${input}`);
  }

  const hasToken = matches.slice(1).some((value) => value !== undefined);
  if (!hasToken) {
    throw new ParseError('E_BAD_DURATION', `Invalid duration: ${input}`);
  }

  const hours = Number.parseInt(matches[1] || '0', 10);
  const minutes = Number.parseInt(matches[2] || '0', 10);
  const seconds = Number.parseInt(matches[3] || '0', 10);
  const ms = Number.parseInt(matches[4] || '0', 10);

  if ([hours, minutes, seconds, ms].some((value) => !Number.isFinite(value) || value < 0)) {
    throw new ParseError('E_BAD_DURATION', `Invalid duration: ${input}`);
  }

  return {
    input,
    ms: (hours * 3_600_000) + (minutes * 60_000) + (seconds * 1000) + ms,
  };
}

function parseViewport(input) {
  const match = String(input).match(/^(\d+)x(\d+)$/i);
  if (!match) {
    throw new ParseError('E_BAD_VIEWPORT', `Invalid viewport: ${input}`);
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width <= 0 || height <= 0) {
    throw new ParseError('E_BAD_VIEWPORT', `Invalid viewport: ${input}`);
  }
  return { input, width, height };
}

function parseValueFlag(flag, value) {
  if (value === undefined) {
    throw new ParseError('E_MISSING_VALUE', `Missing value for --${flag}`);
  }

  if (flag === 'duration') {
    return parseDuration(value);
  }

  if (flag === 'viewport') {
    return parseViewport(value);
  }

  if (flag === 'interval') {
    const ms = parseDuration(value).ms;
    if (ms === 0) {
      throw new ParseError('E_BAD_INTERVAL', `Invalid interval: ${value}`);
    }
    return ms;
  }

  if (flag === 'index' || flag === 'near') {
    if (!/^\d+$/.test(value)) {
      throw new ParseError('E_BAD_INDEX', `Invalid numeric value for --${flag}: ${value}`);
    }
    return Number(value);
  }

  return value;
}

function parseCommandAndPositionals(args) {
  if (!Array.isArray(args) || args.length === 0 || args[0].startsWith('-')) {
    return { command: 'help', positionals: [] };
  }

  return { command: args[0], positionals: args.slice(1) };
}

function assertNoExtraPositionals(command, positionals) {
  const expected = COMMANDS[command]?.positional.length || 0;
  if (positionals.length < expected) {
    throw new ParseError('E_MISSING_ARGUMENT', `Missing required argument for ${command}`);
  }
  if (positionals.length > expected) {
    throw new ParseError('E_EXTRA_ARGUMENT', `Too many positional arguments for ${command}`);
  }
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {};
  const raw = [...argv];

  const { command, positionals: rawPositional } = parseCommandAndPositionals(raw);

  if (!COMMANDS[command]) {
    if (command === 'help') {
      return { command: 'help', options: {}, positionals: [] };
    }
    throw new ParseError('E_UNKNOWN_COMMAND', `Unknown command: ${command}`);
  }

  const config = COMMANDS[command];
  const positionalNames = config.positional;
  const positional = [];

  for (let index = 0; index < rawPositional.length; index += 1) {
    const token = rawPositional[index];
    if (token.startsWith('-')) {
      if (token === '--') {
        positional.push(...rawPositional.slice(index + 1));
        break;
      }

      const isBool = token.startsWith('--')
        ? token.includes('=')
          ? false
          : config.boolFlags.includes(stripDash(token.slice(2))) || token.startsWith('--no-')
        : token.startsWith('-')
          ? token.length === 2 && ['j', 'f', 'h'].includes(token[1])
          : false;

      if (isBool) {
        const { key, value } = normalizeBoolFlag(token);
        if (!config.boolFlags.includes(key)) {
          throw new ParseError('E_UNKNOWN_FLAG', `Unknown flag for ${command}: ${token}`);
        }
        options[key] = value;
        continue;
      }

      const eqIndex = token.indexOf('=');
      let flag;
      let value;
      if (eqIndex >= 0) {
        flag = token.slice(0, eqIndex);
        value = token.slice(eqIndex + 1);
      } else {
        flag = token;
        value = rawPositional[index + 1];
        index += 1;
      }

      if (!flag.startsWith('--')) {
        throw new ParseError('E_UNKNOWN_FLAG', `Unknown flag format: ${token}`);
      }
      const key = stripDash(flag.slice(2));
      if (!config.valueFlags.includes(key)) {
        throw new ParseError('E_UNKNOWN_FLAG', `Unknown flag for ${command}: ${token}`);
      }
      options[key] = parseValueFlag(key, value);
      continue;
    }

    positional.push(token);
  }

  assertNoExtraPositionals(command, positional);

  const result = {
    command,
    options,
    positionals: positional,
  };

  if (config.positional.length > 0) {
    if (config.positional[0] === 'target') {
      result.target = positional[0];
    }
    if (config.positional[0] === 'runDir') {
      result.runDir = positional[0];
    }
  }

  return result;
}

module.exports = {
  ParseError,
  parseDuration,
  parseViewport,
  parseArgs,
};
