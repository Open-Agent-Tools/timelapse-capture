# timelapse-capture

Fire-and-forget visual timelapse capture for long-running app review.

`timelapse-capture` captures a browser URL as a sequence of screenshots, lets a person or agent inspect individual frames with `peek`, renders the frames into `output.mp4`, and removes raw frames after a successful render by default.

## Installation

Requirements:

- Node.js 20 or newer
- npm
- Playwright Chromium
- `ffmpeg` and `ffprobe` available on `PATH`

Install project dependencies from the repository root:

```bash
npm install
```

Install the Chromium browser used by Playwright:

```bash
npx playwright install chromium
```

Install FFmpeg with your system package manager if `ffmpeg` or `ffprobe` is missing.

```bash
# macOS with Homebrew
brew install ffmpeg

# Debian or Ubuntu
sudo apt-get update
sudo apt-get install ffmpeg
```

For local command-line use from this checkout, either run through npm:

```bash
npm start -- doctor
```

Or link the binary once:

```bash
npm link
timelapse-capture doctor
```

## Doctor

Run `doctor` before any capture work:

```bash
timelapse-capture doctor
```

The command checks:

- `node`: the current Node.js executable satisfies Node.js 20 or newer.
- `playwright`: the Playwright package can be imported from this checkout.
- `chromium`: Playwright can launch Chromium in headless mode.
- `ffmpeg`: the renderer can find and run `ffmpeg`.
- `ffprobe`: MP4 validation can find and run `ffprobe`.

Successful output looks like this:

```text
[PASS] node: Node.js 20.11.1 satisfies >= 20.0.0
[PASS] playwright: Playwright package can be imported
[PASS] chromium: Chromium can be launched by Playwright
[PASS] ffmpeg: ffmpeg 7.1 is available
[PASS] ffprobe: ffprobe 7.1 is available
summary: 5 passed, 0 failed, 5 total
```

If a check fails, read the `fix:` line, apply it, and run `timelapse-capture doctor` again before starting a capture.

Use JSON output when another tool needs to parse the result:

```bash
timelapse-capture doctor --json
```

## Dogfood Walkthrough

This walkthrough starts from a local web app at `http://localhost:3000` and ends with a rendered MP4.

1. Confirm dependencies:

```bash
timelapse-capture doctor
```

2. Start a capture:

```bash
timelapse-capture start http://localhost:3000 \
  --duration 30s \
  --interval 5s \
  --viewport 1440x900
```

The command prints a `run-dir`. Save that path for the next commands. The default location is under `./runs/`.

3. Check capture progress:

```bash
timelapse-capture status ./runs/localhost-3000-1760000000000
```

Use JSON if you need structured fields:

```bash
timelapse-capture status ./runs/localhost-3000-1760000000000 --json
```

4. Peek at one frame for inspection:

```bash
timelapse-capture peek ./runs/localhost-3000-1760000000000 --latest
```

`peek` returns a single image path. Open or inspect that one image; do not load the whole `frames/` directory into an agent context.

5. Render the MP4:

```bash
timelapse-capture render ./runs/localhost-3000-1760000000000
```

6. Inspect the video:

```bash
open ./runs/localhost-3000-1760000000000/output.mp4
```

On Linux, use your desktop file opener or video player instead of `open`.

## Commands

```bash
timelapse-capture doctor [--json]
```

Checks runtime dependencies. Run this first.

```bash
timelapse-capture start <url> [--duration <duration>] [--interval <duration> | --video-length <duration> [--fps <n>]] [--force-interval] [--viewport <width>x<height>] [--json]
```

Captures screenshots for the target URL. Durations accept values such as `30s`, `5m`, `2h`, or `500ms`.

When `--interval` is omitted, the capture interval is computed from `--duration` and `--video-length` (default `--fps 24`). The `playwright-url` backend enforces a 250ms minimum interval — sub-minimum intervals exit with `E_INTERVAL_TOO_SMALL` unless `--force-interval` is supplied, in which case a stderr warning is emitted and the forced fields are recorded in `config.json`.

```bash
timelapse-capture status <run-dir> [--json]
```

Reports run state, captured and failed frame counts, latest successful frame, elapsed time, estimated remaining time, output path, cleanup summary, and disk usage.

```bash
timelapse-capture peek <run-dir> [--latest | --index <n> | --near <iso>] [--json]
```

Returns one frame path. `--latest` selects the newest frame, `--index` selects a zero-based frame index, and `--near` selects by ISO 8601 timestamp.

```bash
timelapse-capture render <run-dir>
```

Renders `output.mp4` from captured frames. By default, successful render removes raw frame PNGs and keeps the MP4 plus run metadata.

```bash
timelapse-capture cleanup <run-dir> [--force]
```

Deletes raw frame PNGs for a completed run. Refuses to run if `output.mp4` is missing unless `--force` is passed.

## Troubleshooting

### `doctor` reports Node.js is too old

Install Node.js 20 or newer, open a new shell, and run:

```bash
node --version
timelapse-capture doctor
```

### Playwright package cannot be imported

Install dependencies from the repository root:

```bash
npm install
timelapse-capture doctor
```

### Chromium cannot be launched

Install Chromium for Playwright:

```bash
npx playwright install chromium
timelapse-capture doctor
```

On Linux CI hosts, Playwright may also need OS libraries. Run the command suggested by Playwright if it prints one.

### `ffmpeg` or `ffprobe` is missing

Install FFmpeg and confirm both binaries are visible:

```bash
ffmpeg -version
ffprobe -version
timelapse-capture doctor
```

### Start fails with `navigation failed`

Check that the URL is complete and reachable from the machine running the command. Use `http://` or `https://`, not a bare host name.

```bash
timelapse-capture start http://localhost:3000 --duration 30s
```

### Render fails or no MP4 appears

Run `status` first and confirm at least one frame was captured. Then check that `ffmpeg` and `ffprobe` pass `doctor`.

```bash
timelapse-capture status <run-dir>
timelapse-capture doctor
```

Render failures preserve raw frames so you can retry after fixing the dependency or input problem.

### `peek` says no frames are available

If render already succeeded, raw frames may have been cleaned up. Inspect `poster.png`, `latest-retained.png`, or `output.mp4` in the run directory if present.

## Retention Examples

Successful `render` removes raw frame PNGs by default and keeps `output.mp4` plus metadata. Use the `cleanup` command to manually reclaim space if render cleanup was skipped or failed.

```bash
# Clean frames only after verifying output.mp4
timelapse-capture cleanup ./timelapse-runs/example-com-20260507-121530

# Force cleanup even if output.mp4 was not rendered
timelapse-capture cleanup ./timelapse-runs/example-com-20260507-121530 --force
```

## Artifacts

A run directory contains files like:

```text
runs/<slug>-<timestamp>/
  config.json
  job.json
  manifest.json
  status.json
  frames/
    frame-0001.png
    frame-0002.png
  output.mp4
  run-summary.json
```

Important paths:

- `frames/`: raw screenshots captured before render cleanup.
- `status.json`: current or final run status.
- `output.mp4`: rendered video.
- `run-summary.json`: render and cleanup metadata.
- `poster.png` or `latest-retained.png`: retained single-frame artifacts when available.

## Project Layout

```text
src/timelapse-capture.mjs  CLI entrypoint
src/cli/index.js           CLI router
src/cli/doctor.js          dependency checks
src/cli/render.js          MP4 rendering and cleanup helpers
src/cli/parser.js          argument parsing
skill/SKILL.md             Codex/Claude-style skill instructions
docs/PRD.md                product requirements
test/*.test.js             Node test suite
```
