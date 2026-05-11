import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SELF = fileURLToPath(import.meta.url);
const SCAN_ROOTS = ['src', 'bin', 'test'];
const SOURCE_EXTENSIONS = new Set(['.cjs', '.js', '.mjs']);
const MARKER_PATTERNS = [
  new RegExp(`^${'<'.repeat(7)} `),
  new RegExp(`^${'='.repeat(7)}$`),
  new RegExp(`^${'>'.repeat(7)} `)
];

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

test('source and test files do not contain merge conflict markers', async () => {
  const roots = SCAN_ROOTS.map((root) => path.join(ROOT, root));
  const sourceFiles = (await Promise.all(roots.map(collectSourceFiles))).flat();
  const offenders = [];

  for (const absolute of sourceFiles) {
    const content = await fs.readFile(absolute, 'utf8');
    const lines = content.split('\n');
    for (const [index, line] of lines.entries()) {
      if (MARKER_PATTERNS.some((pattern) => pattern.test(line))) {
        offenders.push(`${path.relative(ROOT, absolute)}:${index + 1}`);
      }
    }
  }

  assert.deepEqual(offenders, [], `merge conflict markers found in:\n${offenders.join('\n')}`);
});
