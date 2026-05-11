import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const THIS_FILE = fileURLToPath(import.meta.url);
const SCAN_EXTENSIONS = new Set(['.mjs', '.js', '.cjs']);
const SCAN_ROOTS = ['src', 'bin', 'test'];

const MARKER_START = '<' + '<<<<<<';
const MARKER_MID = '===' + '====';
const MARKER_END = '>' + '>>>>>>';

async function walk(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
      continue;
    }

    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(fullPath)));
      continue;
    }

    if (entry.isFile() && SCAN_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }

  return files;
}

function findConflictMarker(line) {
  if (line.startsWith(`${MARKER_START} `)) return true;
  if (line === MARKER_MID) return true;
  if (line.startsWith(`${MARKER_END} `)) return true;
  return false;
}

test('source files do not contain unresolved merge-conflict markers', async () => {
  const scannedFiles = [];

  for (const relativeRoot of SCAN_ROOTS) {
    const absoluteRoot = path.join(ROOT, relativeRoot);
    let stats = null;

    try {
      stats = await fs.stat(absoluteRoot);
    } catch {
      continue;
    }

    if (!stats.isDirectory()) {
      continue;
    }

    scannedFiles.push(...(await walk(absoluteRoot)));
  }

  const offenders = [];
  for (const filePath of scannedFiles) {
    if (filePath === THIS_FILE) {
      continue;
    }

    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (findConflictMarker(lines[i])) {
        offenders.push(`${path.relative(ROOT, filePath)}:${i + 1}`);
      }
    }
  }

  assert.deepStrictEqual(
    offenders,
    [],
    `Found unresolved merge-conflict markers:\n${offenders.map((hit) => `- ${hit}`).join('\n')}`
  );
});
