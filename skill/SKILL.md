# timelapse-capture Skill Guide for Agents

This guide explains how to use the `timelapse-capture` CLI to record and render timelapses within an agentic workflow.

## Prerequisites

Before using this tool, ensure your environment has:

- **Node.js** 20 or later
- **npm** (installed with Node)
- **ffmpeg** and **ffprobe** (for rendering)
- **Chromium** browser (installed via Playwright)

### Initial Setup

Run these commands once per environment:

```bash
npm install
npx playwright install chromium
```

Install `ffmpeg` and `ffprobe` via your system package manager (Homebrew, apt, Chocolatey, etc.).

## Pre-Capture Verification

**Always run `doctor` before starting any capture:**

```bash
timelapse-capture doctor
```

This checks:
- Node.js version compatibility
- Playwright and Chromium availability
- ffmpeg and ffprobe presence

If `doctor` reports failures, address them before attempting captures. Example output:
```json
{
  "node": true,
  "playwright": true,
  "chromium": true,
  "ffmpeg": true,
  "ffprobe": true
}
```

All values must be `true` for successful rendering.

## Agent Workflow

### 1. Start a Capture

Initiate a capture of the target URL:

```bash
timelapse-capture start <url> --duration <time> --interval <interval> [--viewport <width>x<height>]
```

**Arguments:**
- `<url>` — The web page to capture (http/https only).
- `--duration` — How long to capture (e.g., `30s`, `2m`, `5m`).
- `--interval` — Delay between frames (e.g., `500ms`, `1s`, `2s`).
- `--viewport` — Browser window dimensions (default: `1024x768`).

**Example:**
```bash
timelapse-capture start https://example.com --duration 60s --interval 1s --viewport 1920x1080
```

**Output:**
```
run-dir: runs/example-com-timestamp
```

Record the `run-dir` path; you will use it for subsequent commands.

### 2. Monitor Capture Progress

Check the status of an ongoing or completed capture:

```bash
timelapse-capture status <run-dir> [--json]
```

**Output includes:**
- State: `idle`, `running`, `completed`, `failed`
- Frame count (number of successfully captured frames)
- Failed frame count (if any captures failed)
- Elapsed time and estimated time remaining (if running)
- Latest frame path
- Total disk usage of the run directory

**For machine-readable output:**
```bash
timelapse-capture status <run-dir> --json
```

Use `--json` when integrating into agentic decision pipelines.

### 3. Inspect Frames (Optional, Read-Only)

View a sample frame to verify capture quality:

```bash
timelapse-capture peek <run-dir> --latest
```

**Peek options:**
- `--latest` — Most recent frame.
- `--index <N>` — Specific frame by index (0-indexed).
- `--near <timestamp>` — Frame closest to an ISO timestamp.

**Example:**
```bash
timelapse-capture peek runs/example-com-timestamp --latest
```

**Important:** Use `peek` only for inspection. Do not attempt to render from peeked frames; use the `render` command instead.

### 4. Render the Timelapse

Encode captured frames into an MP4 video after the capture completes:

```bash
timelapse-capture render <run-dir> [--force]
```

**What this does:**
1. Verifies all captured frames are accessible.
2. Calls ffmpeg to encode frames into `output.mp4`.
3. Validates the output MP4 (checks size, duration, video stream).
4. **By default**, deletes raw frames to save disk space.
5. Writes render metadata to `run-summary.json`.

**Options:**
- `--force` — Re-render even if `output.mp4` already exists.
- `--keep-frames` — Preserve raw PNG frames (use only if you need them for debugging or re-encoding).

**Example:**
```bash
timelapse-capture render runs/example-com-timestamp
```

**Output:**
- Path to generated `output.mp4`
- Metadata: duration, frame count, file size, cleanup result

**Failure handling:**
- If ffmpeg is unavailable, `render` will fail with a clear error message.
- If the generated MP4 is invalid or unplayable, frames are **preserved** automatically for debugging.

### 5. Report Artifacts

After successful render, report the artifact path to the user or downstream system:

```bash
# Get the output path
OUTPUT_PATH=$(timelapse-capture render <run-dir> | grep "output.mp4" | awk '{print $NF}')
echo "Timelapse available at: $OUTPUT_PATH"
```

Or use `--json` for structured output:
```bash
timelapse-capture status <run-dir> --json | jq '.outputPath'
```

## Frame Retention Examples

By default, `render` deletes raw frames. To retain artifacts:

### Scenario: Debug a Failed Render
```bash
# Attempt render, frames are preserved if render fails
timelapse-capture render runs/debug-run

# Inspect frames
ls runs/debug-run/frames/ | head

# Re-render with debugging info
timelapse-capture render runs/debug-run --force --keep-frames
```

### Scenario: Preserve Data for Re-Encoding
```bash
# Capture and render without deleting frames
timelapse-capture render runs/keep-run --keep-frames

# Later, re-use or re-encode the same frames
timelapse-capture render runs/keep-run --force
```

## Error Handling

### Capture Failed or Produced No Frames
```bash
timelapse-capture status <run-dir>
```
Check the output for `failedFrameCount` or `frameCount`. If `frameCount: 0`:
- Verify the URL is accessible.
- Run `doctor` to check Chromium availability.
- Check browser console errors (available in job metadata if captured).

### Render Failed
If `render` exits with an error:
- Frames are automatically preserved (not deleted).
- Run `doctor` to confirm ffmpeg and ffprobe are available.
- Try `render --force --keep-frames` to re-attempt with debugging enabled.

### Memory or Disk Issues
- Check available disk space: `df -h` or equivalent.
- Use shorter durations or longer intervals to reduce frame count.
- Delete old captures: `timelapse-capture cleanup <old-run-dir> --all --force`.

## Output Structure

After a successful capture and render:

```
runs/example-com-timestamp/
├── config.json              # Capture parameters (URL, duration, viewport)
├── manifest.json            # Metadata and timestamps
├── status.json              # Latest state snapshot
├── job.json                 # Job execution details
├── frames/                  # Raw PNG files (deleted by default after render)
├── poster.png               # First frame (always kept)
├── output.mp4               # Final video (after render)
└── run-summary.json         # Render result metadata
```

Key fields in `run-summary.json`:
- `outputPath`: Path to the generated MP4.
- `outputBytes`: File size of the MP4.
- `durationSeconds`: Duration of the video.
- `frameCount`: Number of frames rendered.
- `cleanedUpFrames`: Whether raw frames were deleted.

## Tips for Reliable Captures

- **Always run `doctor` first.** It catches environment issues early.
- **Use reasonable durations.** Captures longer than 10 minutes may require significant disk space and render time.
- **Pick appropriate intervals.** For real-time monitoring, use 500ms–2s. For slow changes, use 5–10s.
- **Verify with `peek`** before committing to a render if capture time was expensive.
- **Keep `doctor` output handy.** Share it with users if they report issues.
- **Retain frames only when necessary.** Frame retention can use 10+ GB of disk space for long captures.

## Debugging Checklist

If a capture or render fails:

1. Run `timelapse-capture doctor` — verify all dependencies.
2. Run `timelapse-capture status <run-dir>` — check frame count and error state.
3. Run `timelapse-capture peek <run-dir> --latest` — inspect the last captured frame.
4. Check disk space: `df -h` and `du -sh <run-dir>`.
5. Review run metadata: `cat <run-dir>/config.json` and `<run-dir>/job.json`.
6. If rendering fails, retry with `--force --keep-frames` and inspect logs.

## Integration with Agents

### Bash Integration
```bash
#!/bin/bash
set -e

# Verify environment
timelapse-capture doctor || exit 1

# Capture
RUN_DIR=$(timelapse-capture start https://example.com --duration 30s --interval 1s | grep "run-dir:" | awk '{print $2}')
echo "Capture started in: $RUN_DIR"

# Wait for completion (assume capture duration + buffer)
sleep 35

# Render
timelapse-capture render "$RUN_DIR"
echo "Timelapse rendered successfully"
```

### JSON Status Pipeline
```bash
STATUS=$(timelapse-capture status <run-dir> --json)
FRAME_COUNT=$(echo "$STATUS" | jq '.frameCount')
ELAPSED=$(echo "$STATUS" | jq '.elapsedMs')
STATE=$(echo "$STATUS" | jq '.state' -r)

if [ "$STATE" == "completed" ]; then
  echo "Capture finished with $FRAME_COUNT frames in ${ELAPSED}ms"
fi
```

## Support

For issues or unexpected behavior:
- Run `timelapse-capture doctor` to verify the environment.
- Check the corresponding README.md for CLI reference and troubleshooting.
- Review run metadata in the run directory for diagnostic information.
