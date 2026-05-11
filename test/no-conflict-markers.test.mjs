import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SELF = fileURLToPath(import.meta.url);
const SCAN_ROOTS = ['src', 'bin', 'test', 'scripts', 'docs', 'skill'];
const SOURCE_EXTENSIONS = new Set(['.cjs', '.js', '.mjs', '.sh', '.md']);
const MARKER_PATTERNS = [
  new RegExp(`^${'<'.repeat(7)}(?:\\s|$)`),
  /^=======\r?$/,
  /^\|\|\|\|\|\|\|(?:\s|$)/,
  new RegExp(`^${'>'.repeat(7)}(?:\\s|$)`)
];

function isConflictMarkerLine(line) {
  return MARKER_PATTERNS.some((pattern) => pattern.test(line));
}

async function collectSourceFiles(directory) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;

    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectSourceFiles(absolute));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name)) && absolute !== SELF) {
      files.push(absolute);
    }
  }

  return files;
}

async function collectScannedFiles(root) {
  const roots = SCAN_ROOTS.map((scanRoot) => path.join(root, scanRoot));
  return (await Promise.all(roots.map(collectSourceFiles))).flat();
}

test('conflict marker detection handles CRLF separators and diff3 markers', () => {
  assert.equal(isConflictMarkerLine(`${'='.repeat(7)}\r`), true);
  assert.equal(isConflictMarkerLine(`${'|'.repeat(7)} base`), true);
  assert.equal(isConflictMarkerLine(`${'<'.repeat(7)} HEAD`), true);
  assert.equal(isConflictMarkerLine(`${'>'.repeat(7)} branch`), true);
  assert.equal(isConflictMarkerLine('## Section title'), false);
  assert.equal(isConflictMarkerLine('const separator = "=======";'), false);
});

test('conflict marker detection handles minimal/malformed markers without trailing labels', () => {
  assert.equal(isConflictMarkerLine('<<<<<<<'), true);
  assert.equal(isConflictMarkerLine('>>>>>>>'), true);
  assert.equal(isConflictMarkerLine('|||||||'), true);
  assert.equal(isConflictMarkerLine('const x = "<<<<<<<"'), false);
  assert.equal(isConflictMarkerLine('  <<<<<<< Indented marker'), false);
});

test('conflict marker scan includes scripts, docs, and skill text files', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'conflict-marker-scan-'));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  await fs.mkdir(path.join(tempRoot, 'scripts'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'docs', 'decisions'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'docs', '.ignored'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'skill'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'test'), { recursive: true });

  await fs.writeFile(path.join(tempRoot, 'scripts', 'local-check.sh'), '#!/usr/bin/env bash\n');
  await fs.writeFile(path.join(tempRoot, 'docs', 'PRD.md'), '# PRD\n');
  await fs.writeFile(path.join(tempRoot, 'docs', 'decisions', '001-canonical-cli-entrypoint.md'), '# Decision\n');
  await fs.writeFile(path.join(tempRoot, 'docs', '.ignored', 'notes.md'), '# Ignored\n');
  await fs.writeFile(path.join(tempRoot, 'skill', 'SKILL.md'), '# Skill\n');
  await fs.writeFile(path.join(tempRoot, 'test', 'guard.test.mjs'), 'import test from "node:test";\n');

  const scannedFiles = await collectScannedFiles(tempRoot);
  const relativeFiles = scannedFiles.map((file) => path.relative(tempRoot, file)).sort();

  assert.deepEqual(relativeFiles, [
    path.join('docs', 'PRD.md'),
    path.join('docs', 'decisions', '001-canonical-cli-entrypoint.md'),
    path.join('scripts', 'local-check.sh'),
    path.join('skill', 'SKILL.md'),
    path.join('test', 'guard.test.mjs')
  ]);
});

test('source and test files do not contain merge conflict markers', async () => {
  const sourceFiles = await collectScannedFiles(ROOT);
  const offenders = [];

  for (const absolute of sourceFiles) {
    const content = await fs.readFile(absolute, 'utf8');
    const lines = content.split('\n');
    for (const [index, line] of lines.entries()) {
      if (isConflictMarkerLine(line)) {
        offenders.push(`${path.relative(ROOT, absolute)}:${index + 1}`);
      }
    }
  }

  assert.deepEqual(offenders, [], `merge conflict markers found in:\n${offenders.join('\n')}`);
});
