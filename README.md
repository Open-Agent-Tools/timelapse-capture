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

For a full tester protocol with three scenarios (default cleanup, frame retention, and failure modes) and a feedback template, see [`docs/dogfood-protocol.md`](docs/dogfood-protocol.md).

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

The command starts a detached background capture process, prints a `run-dir`, and returns immediately. Save that path for the next commands. The default location is under `./timelapse-runs/`.

3. Check capture progress:

```bash
timelapse-capture status ./timelapse-runs/localhost-3000-20260507-121530
```

Use JSON if you need structured fields:

```bash
timelapse-capture status ./timelapse-runs/localhost-3000-20260507-121530 --json
```

4. Peek at one frame for inspection:

```bash
timelapse-capture peek ./timelapse-runs/localhost-3000-20260507-121530 --latest
```

`peek` returns a single image path. Open or inspect that one image; do not load the whole `frames/` directory into an agent context.

5. Render the MP4:

```bash
timelapse-capture render ./timelapse-runs/localhost-3000-20260507-121530
```

6. Inspect the video:

```bash
open ./timelapse-runs/localhost-3000-20260507-121530/output.mp4
```

On Linux, use your desktop file opener or video player instead of `open`.

## Commands

```bash
timelapse-capture doctor [--json]
```

Checks runtime dependencies. Run this first.

```bash
npm run check:local
```

Runs repository checks and tests in sequence. If `ffmpeg` and `ffprobe` are not available on `PATH`,
`npm run check:local` will emit explicit skip messages and still continue to run non-binary tests.
`test/real-ffmpeg-check.test.mjs` is skipped when those binaries are missing.

```bash
timelapse-capture start <url>
  [--url <url>] [--duration <2h>] [--interval <5s>] [--video-length <1m>]
  [--fps <24>] [--viewport <1280x720>] [--out <dir>] [--cleanup <mode>]
  [--keep-samples [N]] [--wait-until <event>] [--backend <name>]
  [--json] [--force] [--headed] [--keep-frames] [--keep-latest]
```

Starts a detached background process that captures screenshots for the target URL. Durations accept values such as `30s`, `5m`, `2h`, or `500ms`.
Use `--interval <duration>` to set capture cadence directly, or use `--video-length <duration>` with `--fps <number>` to derive the interval from the requested output video length.

`start` writes the initial run artifacts and returns before capture finishes. Use `status` with the printed run directory to follow progress. The internal child process runs `timelapse-capture capture --run <run-dir>`.

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
timelapse-capture cleanup <run-dir> [--keep-frames | --keep-samples | --keep-latest | --frames | --all] [--force]
```

Deletes raw frame PNGs for a completed run.

- `--keep-frames`: preserve all raw frames (no files removed)
- `--keep-samples`: remove all but the first and last frame
- `--keep-latest`: remove all but the most recent frame
- `--frames`: remove raw frames and `latest.png`, preserve `output.mp4` and other artifacts
- `--all`: remove the entire run directory; requires `--force` if raw frames still exist
- `--force`: override safety guards (e.g. delete even if frames remain)

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

If render already succeeded, raw frames may have been cleaned up. Inspect `poster.png` or `output.mp4` in the run directory if present.

## Retention Examples

Successful `render` removes raw frame PNGs by default and keeps `output.mp4` plus metadata. Use the `cleanup` command to manually reclaim space if render cleanup was skipped or failed.

```bash
# Remove all raw frames (default)
timelapse-capture cleanup ./timelapse-runs/example-com-20260507-121530

# Keep only the first and last frame as samples
timelapse-capture cleanup ./timelapse-runs/example-com-20260507-121530 --keep-samples

# Keep only the most recent frame
timelapse-capture cleanup ./timelapse-runs/example-com-20260507-121530 --keep-latest

# Keep all raw frames
timelapse-capture cleanup ./timelapse-runs/example-com-20260507-121530 --keep-frames

# Remove frames + latest.png, keep output.mp4
timelapse-capture cleanup ./timelapse-runs/example-com-20260507-121530 --frames

# Delete the entire run directory (requires --force if frames exist)
timelapse-capture cleanup ./timelapse-runs/example-com-20260507-121530 --all --force
```

## Artifacts

A run directory contains files like:

```text
timelapse-runs/<slug>-<timestamp>/
  config.json
  job.json
  manifest.json
  manifest.jsonl
  status.json
  frames/
    frame-0001.png
    frame-0002.png
  output.mp4
  run-summary.json
```

Important paths:

- `config.json`: capture configuration recorded at start (backend, interval, viewport, retention flags).
- `job.json`: background process metadata, including the detached child PID and command.
- `manifest.json`: start-time run metadata written once when the capture starts (run directory path, creation timestamp, initial state).
- `manifest.jsonl`: per-frame capture log. One JSON record per capture attempt (captured, failed, or skipped), matching the schema in `docs/PRD.md` "Manifest Format".
- `status.json`: current or final run status.
- `output.mp4`: rendered video.
- `run-summary.json`: render and cleanup metadata.
- `poster.png`: retained single-frame artifact when render completed after at least one captured frame.

## Contributing

This project tracks issues with [beads](https://github.com/gastownhall/beads). The local `.beads/` directory is gitignored — after cloning, run `bd init` once to bootstrap it with the git hooks and config that aren't checked in. See `CLAUDE.md` for the full contributor workflow.

## Project Layout

```text
src/timelapse-capture.mjs  CLI entrypoint and all commands
src/doctor.mjs             dependency checks (doctor command)
skill/SKILL.md             Codex/Claude-style skill instructions
docs/PRD.md                product requirements
test/*.test.{js,mjs}       Node test suite
```

## Testing

The suite uses a fake-ffmpeg harness (`test/helpers/fake-ffmpeg.mjs`) so render and cleanup tests run on any machine with Node >= 20 — no real ffmpeg required. Tests that exercise real `ffmpeg`/`ffprobe` binaries are automatically skipped when those binaries are absent from PATH and reported as:

```
real ffmpeg tests skipped (ffmpeg/ffprobe not found)
```

Run the full suite:

```bash
npm test
```
