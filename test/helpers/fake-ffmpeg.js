'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execSync } = require('node:child_process');

class FakeBinaryManager {
  constructor(tempDir) {
    this.tempDir = tempDir;
    this.binDir = path.join(tempDir, 'bin');
    this.outputDir = path.join(tempDir, 'output');
  }

  async setup() {
    await fs.mkdir(this.binDir, { recursive: true });
    await fs.mkdir(this.outputDir, { recursive: true });
  }

  async createFakeFFmpeg(mode = 'success') {
    const ffmpegPath = path.join(this.binDir, 'ffmpeg');
    const outputPath = path.join(this.outputDir, 'output.mp4');

    let script;
    if (mode === 'success') {
      script = '#!/bin/sh\n' +
        '# Create a minimal valid MP4 file\n' +
        'python3 -c "\n' +
        'import struct\n' +
        '# Minimal valid MP4 with ftyp box and moov box (valid but empty video)\n' +
        'ftyp = b"ftypiso2" + b"\\x00" * 16  # 24 bytes total\n' +
        'size = 8 + len(ftyp)\n' +
        'output = struct.pack(">I", size) + ftyp\n' +
        '# Add a minimal moov box (100 bytes)\n' +
        'moov = b"\\x00" * 96\n' +
        'moov_size = 8 + len(moov)\n' +
        'output += struct.pack(">I", moov_size) + b"moov" + moov\n' +
        '# Write to output\n' +
        'import sys\n' +
        'out_file = "' + outputPath + '"\n' +
        'with open(out_file, "wb") as f:\n' +
        '  f.write(output)\n' +
        '"\n' +
        'exit 0';
    } else if (mode === 'fail') {
      script = '#!/bin/sh\nexit 1';
    } else if (mode === 'invalid-output') {
      script = '#!/bin/sh\n' +
        '# Create a file that\'s not a valid MP4\n' +
        'echo "not a video file" > "' + outputPath + '"\n' +
        'exit 0';
    }

    await fs.writeFile(ffmpegPath, script, { mode: 0o755 });
  }

  async createFakeFFprobe(mode = 'success') {
    const ffprobePath = path.join(this.binDir, 'ffprobe');

    let script;
    if (mode === 'success') {
      script = '#!/bin/sh\n' +
        'cat << \'EOF\'\n' +
        '{\n' +
        '  "streams": [\n' +
        '    {\n' +
        '      "index": 0,\n' +
        '      "codec_type": "video",\n' +
        '      "width": 1280,\n' +
        '      "height": 720,\n' +
        '      "duration": "10.0"\n' +
        '    }\n' +
        '  ],\n' +
        '  "format": {\n' +
        '    "duration": "10.0",\n' +
        '    "size": "1000000"\n' +
        '  }\n' +
        '}\n' +
        'EOF\n' +
        'exit 0';
    } else {
      script = '#!/bin/sh\nexit 1';
    }

    await fs.writeFile(ffprobePath, script, { mode: 0o755 });
  }

  getPATHEnv() {
    return `${this.binDir}:${process.env.PATH || ''}`;
  }

  async cleanup() {
    await fs.rm(this.tempDir, { recursive: true, force: true });
  }
}

async function withFakeFFmpeg(testFn, mode = 'success') {
  const tempDir = path.join('/tmp', `fake-ffmpeg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

function hasRealFFmpeg() {
  try {
    execSync('which ffmpeg > /dev/null 2>&1');
    execSync('which ffprobe > /dev/null 2>&1');
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  FakeBinaryManager,
  withFakeFFmpeg,
  hasRealFFmpeg,
};
