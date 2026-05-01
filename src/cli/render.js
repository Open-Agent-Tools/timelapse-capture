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
    return config.output.path;
  }
  return path.join(runDir, 'output.mp4');
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

    try {
      const output = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1:csv=type=s "${outputPath}"`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();

      const duration = parseFloat(output);
      if (!isNaN(duration) && duration > 0) {
        result.duration = duration;
      } else {
        result.error = 'Could not determine video duration or duration is zero';
        return result;
      }
    } catch (e) {
      result.error = `ffprobe failed: ${e.message}`;
      return result;
    }

    try {
      const output = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=codec_type -of default=noprint_wrappers=1:nokey=1 "${outputPath}"`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();

      result.hasVideoStream = output === 'video';
      if (!result.hasVideoStream) {
        result.error = 'Output file does not have a readable video stream';
        return result;
      }
    } catch (e) {
      result.error = `ffprobe stream check failed: ${e.message}`;
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

    const framesDir = getFramesDir(runDir);
    const frameCount = countFrames(framesDir);
    if (frameCount === 0) {
      result.error = 'No frames found to render';
      throw new RenderError(result.error, 'NO_FRAMES');
    }

    const outputPath = getOutputPath(runDir, options.config);
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
      render: {
        outputPath,
        bytes: validation.bytes,
        duration: validation.duration,
        frameCount,
        ffmpegCommand: ffmpegCmd.join(' '),
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
        timestamp: new Date().toISOString(),
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
