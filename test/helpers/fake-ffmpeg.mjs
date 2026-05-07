import fs from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";

class FakeBinaryManager {
  constructor(tempDir) {
    this.tempDir = tempDir;
    this.binDir = path.join(tempDir, "bin");
    this.outputDir = path.join(tempDir, "output");
  }

  async setup() {
    await fs.mkdir(this.binDir, { recursive: true });
    await fs.mkdir(this.outputDir, { recursive: true });
  }

  async createFakeFFmpeg(mode = "success") {
    const ffmpegPath = path.join(this.binDir, "ffmpeg");
    let script;
    if (mode === "success") {
      script =
        "#!/bin/sh\n" +
        "input_pattern=\"\"\n" +
        "args=\"$@\"\n" +
        "while [ $# -gt 0 ]; do\n" +
        "  if [ \"$1\" = \"-i\" ]; then input_pattern=\"$2\"; shift; fi\n" +
        "  out_file=\"$1\"\n" +
        "  shift\n" +
        "done\n" +
        "if [ -n \"$input_pattern\" ] && [ \"$input_pattern\" != \"pipe:0\" ]; then\n" +
        "  # Convert ffmpeg pattern like %04d.png or frame-%04d.png to a glob\n" +
        "  # %04d -> [0-9][0-9][0-9][0-9], %05d -> [0-9][0-9][0-9][0-9][0-9]\n" +
        "  glob_pattern=$(echo \"$input_pattern\" | sed 's/%04d/[0-9][0-9][0-9][0-9]/g' | sed 's/%05d/[0-9][0-9][0-9][0-9][0-9]/g')\n" +
        "  # Check if at least one file matches the glob\n" +
        "  found=false\n" +
        "  for f in $glob_pattern; do\n" +
        "    if [ -f \"$f\" ]; then found=true; break; fi\n" +
        "  done\n" +
        "  if [ \"$found\" = \"false\" ]; then\n" +
        "    echo \"ffmpeg: $input_pattern: No such file or directory\" >&2\n" +
        "    exit 1\n" +
        "  fi\n" +
        "fi\n" +
        "printf 'fake mp4 bytes' > \"$out_file\"\n" +
        "exit 0";
    } else if (mode === "fail") {
      script = "#!/bin/sh\nexit 1";
    } else if (mode === "invalid-output") {
      script =
        "#!/bin/sh\n" +
        "for arg do out_file=\"$arg\"; done\n" +
        "echo 'not a video file' > \"$out_file\"\n" +
        "exit 0";
    }
    await fs.writeFile(ffmpegPath, script, { mode: 0o755 });
  }

  async createFakeFFprobe(mode = "success") {
    const ffprobePath = path.join(this.binDir, "ffprobe");
    let script;
    if (mode === "success") {
      script =
        "#!/bin/sh\n" +
        "if [ \"$1\" = \"-version\" ]; then echo 'fake ffprobe'; exit 0; fi\n" +
        "cat << 'EOF'\n" +
        "{\n" +
        '  "streams": [\n' +
        "    {\n" +
        '      "index": 0,\n' +
        '      "codec_type": "video",\n' +
        '      "width": 1280,\n' +
        '      "height": 720,\n' +
        '      "duration": "10.0"\n' +
        "    }\n" +
        "  ],\n" +
        '  "format": {\n' +
        '    "duration": "10.0",\n' +
        '    "size": "1000000"\n' +
        "  }\n" +
        "}\n" +
        "EOF\n" +
        "exit 0";
    } else {
      script =
        "#!/bin/sh\n" +
        "if [ \"$1\" = \"-version\" ]; then echo 'fake ffprobe'; exit 0; fi\n" +
        "exit 1";
    }
    await fs.writeFile(ffprobePath, script, { mode: 0o755 });
  }

  getPATHEnv() {
    return `${this.binDir}:${process.env.PATH || ""}`;
  }

  async cleanup() {
    await fs.rm(this.tempDir, { recursive: true, force: true });
  }
}

export async function withFakeFFmpeg(testFn, mode = "success") {
  const tempDir = path.join(
    "/tmp",
    `fake-ffmpeg-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  const manager = new FakeBinaryManager(tempDir);
  try {
    await manager.setup();
    await manager.createFakeFFmpeg(mode);
    await manager.createFakeFFprobe(mode);
    return await testFn(manager);
  } finally {
    await manager.cleanup();
  }
}

export function hasRealFFmpeg() {
  try {
    execSync("which ffmpeg > /dev/null 2>&1");
    execSync("which ffprobe > /dev/null 2>&1");
    return true;
  } catch {
    return false;
  }
}

export { FakeBinaryManager };
