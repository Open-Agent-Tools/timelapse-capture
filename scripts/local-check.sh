#!/usr/bin/env bash
set -euo pipefail

if command -v ffmpeg >/dev/null 2>&1; then
  HAS_FFMPEG=1
else
  HAS_FFMPEG=0
  echo "SKIP: real binary checks requiring ffmpeg are disabled because ffmpeg is not available on PATH."
fi

if command -v ffprobe >/dev/null 2>&1; then
  HAS_FFPROBE=1
else
  HAS_FFPROBE=0
  echo "SKIP: real binary checks requiring ffprobe are disabled because ffprobe is not available on PATH."
fi

export TIMELAPSE_HAS_REAL_FFMPEG_SUITE="$((HAS_FFMPEG * HAS_FFPROBE))";

if [ "$TIMELAPSE_HAS_REAL_FFMPEG_SUITE" -ne 1 ]; then
  echo "Real ffmpeg/ffprobe integration tests will be skipped." 
fi

echo "Running npm run check"
npm run check

echo "Running npm run format:check"
npm run format:check

echo "Running npm test"
npm test
