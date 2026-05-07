'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

class RenderError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.name = 'RenderError';
  }
}

function getFramesDir(runDir) {
  return path.join(runDir, 'frames');
}

function getOutputPath(runDir, config) {
  if (config?.output?.path) {
    return path.resolve(config.output.path);
  }
  return path.resolve(runDir, 'output.mp4');
}

function getSummaryPath(runDir) {
  return path.join(runDir, 'run-summary.json');
}

function countFrames(framesDir) {
  if (!fs.existsSync(framesDir)) {
    return 0;
  }
  const files = fs.readdirSync(framesDir);
  return files.filter(f => /\.(png|jpg|jpeg)$/i.test(f)).length;
}

function getFileSize(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return stats.size;
  } catch {
    return 0;
  }
}

function validateMP4(outputPath) {
  const result = {
    exists: false,
    bytes: 0,
    duration: null,
    dimensions: null,
    hasVideoStream: false,
    error: null,
  };

  try {
    if (!fs.existsSync(outputPath)) {
      result.error = 'Output file does not exist';
      return result;
    }

    result.exists = true;
    result.bytes = getFileSize(outputPath);

    if (result.bytes === 0) {
      result.error = 'Output file is empty';
      return result;
    }

    let probeJson;
    try {
      probeJson = execSync(`ffprobe -v error -print_format json -show_format -show_streams "${outputPath}"`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch (e) {
      result.error = `ffprobe failed: ${e.message}`;
      return result;
    }

    try {
      const metadata = JSON.parse(probeJson);
      const duration = parseFloat(metadata?.format?.duration);
      if (Number.isNaN(duration) || duration <= 0) {
        result.error = 'Could not determine video duration or duration is zero';
        return result;
      }
      result.duration = duration;

      const videoStream = metadata?.streams?.find((stream) => stream.codec_type === 'video');
      if (!videoStream) {
        result.error = 'Output file does not have a readable video stream';
        return result;
      }
      result.hasVideoStream = true;
      result.dimensions = {
        width: Number.isFinite(Number(videoStream.width)) ? Number(videoStream.width) : null,
        height: Number.isFinite(Number(videoStream.height)) ? Number(videoStream.height) : null,
      };
    } catch (e) {
      result.error = `ffprobe returned unreadable metadata: ${e.message}`;
      return result;
    }

    return result;
  } catch (error) {
    result.error = `Validation error: ${error.message}`;
    return result;
  }
}

function cleanupFrames(framesDir) {
  try {
    if (!fs.existsSync(framesDir)) {
      return { success: true, removed: 0 };
    }

    let removed = 0;
    const files = fs.readdirSync(framesDir);
    for (const file of files) {
      const filePath = path.join(framesDir, file);
      if (/\.(png|jpg|jpeg)$/i.test(file)) {
        fs.unlinkSync(filePath);
        removed++;
      }
    }

    if (files.length === removed && removed > 0) {
      try {
        fs.rmdirSync(framesDir);
      } catch {
        // Directory not empty or other issue, but frames were deleted
      }
    }

    return { success: true, removed };
  } catch (error) {
    return { success: false, error: error.message, removed: 0 };
  }
}

function readExistingSummary(runDir) {
  const summaryPath = getSummaryPath(runDir);
  try {
    if (fs.existsSync(summaryPath)) {
      const content = fs.readFileSync(summaryPath, 'utf8');
      return JSON.parse(content);
    }
  } catch {
    // Ignore errors reading summary
  }
  return null;
}

function writeSummary(runDir, summary) {
  const summaryPath = getSummaryPath(runDir);
  try {
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function renderFrames(runDir, options = {}) {
  const result = {
    success: false,
    outputPath: null,
    metadata: null,
    cleanupResult: null,
    error: null,
  };

  try {
    if (!fs.existsSync(runDir)) {
      result.error = `Run directory does not exist: ${runDir}`;
      throw new RenderError(result.error, 'ENOENT');
    }

    const expectedOutputPath = path.resolve(runDir, 'output.mp4');
    const framesDir = getFramesDir(runDir);
    const frameCount = countFrames(framesDir);
    if (frameCount === 0) {
      result.error = 'No frames found to render';
      throw new RenderError(result.error, 'NO_FRAMES');
    }

    const outputPath = getOutputPath(runDir, options.config);
    if (outputPath !== expectedOutputPath) {
      result.error = `Output path does not match expected path: ${expectedOutputPath}`;
      throw new RenderError(result.error, 'OUTPUT_PATH_MISMATCH');
    }
    const outputDir = path.dirname(outputPath);

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Build ffmpeg command
    const framePattern = path.join(framesDir, '%05d.png');
    const ffmpegCmd = [
      'ffmpeg',
      '-framerate', (options.framerate || 10).toString(),
      '-i', framePattern,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-crf', '23',
      outputPath,
    ];

    if (options.ffmpegPath) {
      ffmpegCmd[0] = options.ffmpegPath;
    }

    try {
      execSync(ffmpegCmd.join(' '), {
        stdio: 'pipe',
        encoding: 'utf8',
      });
    } catch (e) {
      result.error = `ffmpeg failed: ${e.message}`;
      throw new RenderError(result.error, 'FFMPEG_FAILED');
    }

    const validation = validateMP4(outputPath);
    if (validation.error) {
      result.error = `Output is not a valid MP4: ${validation.error}`;
      throw new RenderError(result.error, 'VALIDATION_FAILED');
    }

    // Render successful - prepare metadata
    const existingSummary = readExistingSummary(runDir);
    const summary = {
      ...existingSummary,
      duration: validation.duration,
      dimensions: validation.dimensions,
      ffmpegCommand: ffmpegCmd,
      render: {
        outputPath,
        bytes: validation.bytes,
        duration: validation.duration,
        dimensions: validation.dimensions,
        frameCount,
        sourceFrameCount: frameCount,
        ffmpegCommand: ffmpegCmd,
        timestamp: new Date().toISOString(),
      },
      cleanup: null,
    };

    // Handle cleanup based on options
    if (!options['keep-frames'] && !options['keep-all']) {
      const cleanupResult = cleanupFrames(framesDir);
      summary.cleanup = {
        success: cleanupResult.success,
        removed: cleanupResult.removed,
        error: cleanupResult.error || null,
      };
      result.cleanupResult = cleanupResult;
    } else {
      summary.cleanup = {
        success: false,
        reason: 'Frames preserved by option',
        removed: 0,
      };
    }

    const writeResult = writeSummary(runDir, summary);
    if (!writeResult.success) {
      throw new RenderError(`Failed to write summary: ${writeResult.error}`, 'SUMMARY_WRITE_FAILED');
    }

    result.success = true;
    result.outputPath = outputPath;
    result.metadata = summary.render;

    return result;
  } catch (error) {
    if (error instanceof RenderError) {
      result.error = error.message;
    } else {
      result.error = error.message;
    }

    // Preserve frames on any failure
    const summary = readExistingSummary(runDir);
    const updatedSummary = {
      ...summary,
      lastRenderAttempt: {
        error: result.error,
        outputPath: getOutputPath(runDir, options.config),
        frameCount: countFrames(getFramesDir(runDir)),
        timestamp: new Date().toISOString(),
      },
      cleanup: {
        success: false,
        reason: 'render-or-validation-failed',
        removed: 0,
      },
    };

    try {
      writeSummary(runDir, updatedSummary);
    } catch {
      // Best effort - don't let summary write failure mask original error
    }

    return result;
  }
}

module.exports = {
  renderFrames,
  RenderError,
  validateMP4,
  cleanupFrames,
  getFramesDir,
  getOutputPath,
  getSummaryPath,
};
