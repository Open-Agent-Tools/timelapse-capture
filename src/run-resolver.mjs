import fs from "node:fs";
import path from "node:path";

import { aliasFor, isAlias } from "./aliases.mjs";

export const DEFAULT_RUNS_DIR = "timelapse-runs";

export function listRuns(baseDir = DEFAULT_RUNS_DIR) {
  const absBase = path.resolve(baseDir);
  let entries;
  try {
    entries = fs.readdirSync(absBase, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const fullPath = path.join(absBase, entry.name);
      const stat = fs.statSync(fullPath);
      return {
        name: entry.name,
        path: fullPath,
        alias: aliasFor(entry.name),
        mtime: stat.mtimeMs,
      };
    });
}

export function pickLatestRun(baseDir = DEFAULT_RUNS_DIR) {
  const runs = listRuns(baseDir);
  if (runs.length === 0) return null;
  return runs.reduce((latest, run) =>
    run.mtime > latest.mtime ? run : latest,
  );
}

export function resolveRunDir(input, baseDir = DEFAULT_RUNS_DIR) {
  if (input === undefined || input === null || input === "") {
    const latest = pickLatestRun(baseDir);
    if (!latest) {
      const absBase = path.resolve(baseDir);
      throw new Error(
        `No runs found in ${absBase}. Pass a run directory or alias explicitly.`,
      );
    }
    return latest.path;
  }

  if (isAlias(input)) {
    const runs = listRuns(baseDir);
    const matches = runs.filter((run) => run.alias === input);
    if (matches.length === 0) {
      const absBase = path.resolve(baseDir);
      throw new Error(`No run matches alias "${input}" in ${absBase}.`);
    }
    if (matches.length > 1) {
      const paths = matches.map((m) => m.path).join(", ");
      throw new Error(
        `Alias "${input}" is ambiguous; matches multiple runs: ${paths}`,
      );
    }
    return matches[0].path;
  }

  return input;
}
