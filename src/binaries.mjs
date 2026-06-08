import { execFileSync as nodeExecFileSync } from "node:child_process";
import { createRequire } from "node:module";

const localRequire = createRequire(import.meta.url);

const PACKAGED_BINARY_MODULES = Object.freeze({
  ffmpeg: "@ffmpeg-installer/ffmpeg",
  ffprobe: "@ffprobe-installer/ffprobe",
});

export function resolvePackagedBinary(
  binary,
  { requireFn = localRequire } = {},
) {
  const moduleName = PACKAGED_BINARY_MODULES[binary];
  if (!moduleName) return null;

  try {
    const packaged = requireFn(moduleName);
    return typeof packaged?.path === "string" && packaged.path
      ? packaged.path
      : null;
  } catch {
    return null;
  }
}

function commandExists(binary, { execFileSync = nodeExecFileSync } = {}) {
  try {
    const finder = process.platform === "win32" ? "where.exe" : "which";
    execFileSync(finder, [binary], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function resolveBinaryPath(
  binary,
  {
    preferPackaged = false,
    execFileSync = nodeExecFileSync,
    requireFn = localRequire,
  } = {},
) {
  const packagedPath = resolvePackagedBinary(binary, { requireFn });
  if (preferPackaged && packagedPath) return packagedPath;
  if (commandExists(binary, { execFileSync })) return binary;
  return packagedPath || binary;
}
