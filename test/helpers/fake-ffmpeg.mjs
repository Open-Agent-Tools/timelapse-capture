import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

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
        "if [ \"$1\" = \"-version\" ]; then echo 'fake ffmpeg version 6.1'; exit 0; fi\n" +
        "for arg do out_file=\"$arg\"; done\n" +
        "printf 'fake mp4 bytes' > \"$out_file\"\n" +
        "exit 0";
    } else if (mode === "success-require-contiguous-input") {
      script =
        "#!/usr/bin/env node\n" +
        "import fs from 'node:fs';\n" +
        "import path from 'node:path';\n" +
        "const args = process.argv.slice(2);\n" +
        `const outputDir = ${JSON.stringify(this.outputDir)};\n` +
        "fs.writeFileSync(path.join(outputDir, 'ffmpeg-args.json'), JSON.stringify(args, null, 2));\n" +
        "const input = args[args.indexOf('-i') + 1];\n" +
        "const output = args.at(-1);\n" +
        "const match = input?.match(/^(.*)%0(\\d+)d(.*)$/);\n" +
        "if (!match) { console.error('missing numbered input pattern'); process.exit(2); }\n" +
        "const [, prefixPath, widthText, suffix] = match;\n" +
        "const width = Number(widthText);\n" +
        "const dir = path.dirname(prefixPath);\n" +
        "const prefix = path.basename(prefixPath);\n" +
        "const names = fs.readdirSync(dir).filter((name) => name.startsWith(prefix) && name.endsWith(suffix));\n" +
        "for (let index = 1; index <= names.length; index += 1) {\n" +
        "  const expected = `${prefix}${String(index).padStart(width, '0')}${suffix}`;\n" +
        "  if (!names.includes(expected)) { console.error(`missing contiguous input ${expected}`); process.exit(3); }\n" +
        "}\n" +
        "if (names.length === 0) { console.error('no input frames found'); process.exit(4); }\n" +
        "fs.writeFileSync(output, 'fake mp4 bytes');\n" +
        "process.exit(0);\n";
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
    if (mode === "success" || mode === "success-require-contiguous-input") {
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
    os.tmpdir(),
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
    execFileSync("which", ["ffmpeg"], { stdio: "ignore" });
    execFileSync("which", ["ffprobe"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export { FakeBinaryManager };
