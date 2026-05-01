# timelapse-capture

Record, inspect, and render timelapses of web pages at regular intervals.

## Installation

### Requirements

- **Node.js** 20 or later
- **ffmpeg** and **ffprobe** (for video rendering)
- **Chromium** (installed via Playwright)

### Setup Steps

1. Clone or navigate to the repository.

2. Install Node.js dependencies:
   ```bash
   npm install
   ```

3. Install Chromium (required for capturing):
   ```bash
   npx playwright install chromium
   ```

4. Install ffmpeg and ffprobe via your system package manager:
   - **macOS** (Homebrew):
     ```bash
     brew install ffmpeg
     ```
   - **Ubuntu/Debian**:
     ```bash
     sudo apt-get install ffmpeg
     ```
   - **Windows** (via Chocolatey):
     ```bash
     choco install ffmpeg
     ```

5. Verify your setup:
   ```bash
   npm link
   timelapse-capture doctor
   ```

The `doctor` command checks Node version, Playwright/Chromium availability, and ffmpeg/ffprobe presence. If any check fails, you will see an actionable error message.

## Quick Start

### Scenario: Capture a Local URL

1. **Start a capture** targeting a URL for 20 seconds (2 frames per second):
   ```bash
   timelapse-capture start http://localhost:3000 --duration 20s --interval 500ms
   ```
   Output:
   ```
   run-dir: runs/local-localhost-3000
   ```

2. **Check status** while the capture is running:
   ```bash
   timelapse-capture status runs/local-localhost-3000
   ```
   The output shows: state, elapsed time, ETA, frame count, and latest frame path.

3. **Peek at a frame** (optional, while running or after):
   ```bash
   timelapse-capture peek runs/local-localhost-3000 --latest
   ```
   Output: path to the most recent captured frame.

4. **Render the MP4** once the capture completes:
   ```bash
   timelapse-capture render runs/local-localhost-3000
   ```
   The tool validates the MP4, then by default removes raw frames. Output shows the path to `output.mp4`.

5. **Inspect the result**:
   - Open `runs/local-localhost-3000/output.mp4` in your video player.
   - View the poster frame at `runs/local-localhost-3000/poster.png`.

### Keeping Frames After Render

To retain raw frames after rendering (useful for debugging or re-encoding):
```bash
timelapse-capture render runs/local-localhost-3000 --keep-frames
```

This preserves the `frames/` directory so you can inspect individual PNG files or re-render later.

## Command Reference

### `start <url> [options]`

Begin capturing a URL at regular intervals.

**Options:**
- `--duration <value>` — Total capture time (e.g., `20s`, `5m`). Default: `60s`.
- `--interval <value>` — Time between frames (e.g., `500ms`, `2s`). Default: `1s`.
- `--viewport <widthxheight>` — Browser window size (e.g., `1920x1080`). Default: `1024x768`.
- `--run-dir <path>` — Custom output directory. Default: auto-generated in `runs/`.

**Example:**
```bash
timelapse-capture start https://example.com --duration 2m --interval 1s --viewport 1920x1080
```

### `status <run-dir> [--json]`

Display the current state of a capture.

**Output includes:**
- State: `idle`, `running`, `completed`, `failed`
- Frame count and failed frame count
- Elapsed time and ETA (if still running)
- Latest frame path
- Disk usage

**With `--json`:** Output machine-readable status.

### `peek <run-dir> [options]`

Inspect a captured frame without rendering.

**Options:**
- `--latest` — Show the most recent frame.
- `--index <N>` — Show the Nth frame (0-indexed).
- `--near <timestamp>` — Show the frame closest to the given ISO timestamp.

**Example:**
```bash
timelapse-capture peek runs/my-capture --latest
```

### `render <run-dir> [options]`

Encode captured frames into an MP4 video.

**Options:**
- `--keep-frames` — Preserve raw PNG frames after rendering.
- `--keep-samples` — Keep the sampled frames used for the video.
- `--keep-latest` — Preserve the latest frame snapshot.
- `--force` — Re-render even if output.mp4 already exists.

**Default behavior:** Validates the MP4, then deletes raw frames to save disk space.

**Output:** Path to the generated `output.mp4`, plus metadata in `run-summary.json`.

### `cleanup <run-dir> [options]`

Manually remove artifacts from a run directory.

**Options:**
- `--frames` — Remove only raw captured frames.
- `--all` — Remove the entire run directory (destructive).
- `--force` — Skip confirmation prompts.

**Example:**
```bash
timelapse-capture cleanup runs/my-capture --frames --force
```

### `doctor [--json]`

Verify runtime dependencies and environment readiness.

**Checks:**
- Node.js version (must be 20+)
- Playwright package availability
- Chromium browser launch capability
- ffmpeg command availability
- ffprobe command availability

**Output:** Status report. Use `--json` for machine-readable results.

**If any check fails**, the tool provides actionable guidance for installation or configuration.

## Troubleshooting

### "Command not found: timelapse-capture"
- Run `npm link` after `npm install` to make the CLI available globally.
- Verify the `bin` field in `package.json` points to the correct entry point.

### "doctor" reports missing ffmpeg/ffprobe
- Ensure ffmpeg is installed and available in your PATH.
- Test manually: `ffmpeg -version` and `ffprobe -version`.

### Capture produces no frames
- Check the URL is accessible: open it in your browser first.
- Verify Chromium is installed: `npx playwright install chromium`.
- Check the status: `timelapse-capture status <run-dir>`.

### Render fails with "Invalid MP4"
- Ensure ffmpeg is installed and functional.
- Try rendering with `--force --keep-frames` to debug.
- Inspect the generated `output.mp4` file size; very small files may indicate rendering errors.

### Disk space issues
- Use `status <run-dir>` to check current disk usage.
- Remove old runs: `cleanup <old-run-dir> --all --force`.
- Render with the default (delete frames) to minimize space.

## Output Structure

A typical run directory looks like:

```
runs/my-capture/
├── config.json           # Capture configuration (URL, duration, viewport)
├── manifest.json         # Creation timestamp and state
├── job.json              # Job metadata and timing
├── status.json           # Current capture state
├── frames/               # Raw captured PNG files
│   ├── frame-0000.png
│   ├── frame-0001.png
│   └── ...
├── poster.png            # First frame (always preserved)
├── latest.png            # Most recent frame (before cleanup)
├── latest-retained.png   # Most recent frame (after cleanup, if --keep-frames used)
├── output.mp4            # Rendered video (after render command)
└── run-summary.json      # Render metadata (output path, duration, dimensions, cleanup result)
```

## Examples

### Capture for CI/CD Monitoring
Monitor a deployment dashboard for 5 minutes:
```bash
timelapse-capture start https://my-dashboard.internal --duration 5m --interval 5s
timelapse-capture peek runs/deployment-dash --latest
timelapse-capture render runs/deployment-dash
```

### Retain Data for Debugging
Capture with frame retention to inspect individual frames later:
```bash
timelapse-capture start http://localhost:8000 --duration 1m --interval 500ms
timelapse-capture render runs/debug-run --keep-frames
# Inspect or re-render:
ls runs/debug-run/frames/
timelapse-capture render runs/debug-run --force
```

### Verify Capture Success
Use status and peek to validate a capture before rendering:
```bash
timelapse-capture status runs/my-capture
timelapse-capture peek runs/my-capture --latest
# If satisfied, render:
timelapse-capture render runs/my-capture
```

## Tips

- **Intervals:** Use smaller intervals (500ms–1s) for fast-changing content, larger intervals (5–10s) for slow updates.
- **Duration:** Shorter captures (30–60s) are faster to render and debug; longer captures need more disk space.
- **Viewport:** Match your target device (e.g., `1920x1080` for desktop, `375x667` for mobile).
- **Keep frames:** Only use `--keep-frames` if you need to inspect or re-encode; it uses significant disk space.
- **Poster frame:** The first frame is always saved as `poster.png` and serves as a preview thumbnail.

## Getting Help

If you encounter issues:
1. Run `timelapse-capture doctor` to check dependencies.
2. Check the `status` output and logs in the run directory.
3. Inspect individual frames in `frames/` or `peek --latest`.
4. Review run metadata in `config.json` and `job.json`.
