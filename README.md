# timelapse-capture

`timelapse-capture` records screenshots of a web page over time, lets you inspect individual frames while the run is active, and renders the captured frames into a compact MP4 with `ffmpeg`.

Use it when you want to review a long-running UI flow without watching it live: dashboards, loading states, background jobs, polling screens, deployment progress, or intermittent visual glitches.

## Installation

Prerequisites:

- Node >= 20
- npm
- Playwright's Chromium browser
- `ffmpeg` and `ffprobe` on `PATH`

From this repository:

```bash
npm install
npx playwright install chromium
npm link
```

Install FFmpeg with your system package manager if it is missing:

```bash
# macOS with Homebrew
brew install ffmpeg

# Debian or Ubuntu
sudo apt-get install ffmpeg
```

`npm link` makes the `timelapse-capture` command available in your shell. If you do not want to link it globally, run the CLI with `node ./src/timelapse-capture.mjs` from this repository.

## Doctor

Run `doctor` before starting a capture:

```bash
timelapse-capture doctor
```

The command checks:

- Node version: must satisfy Node >= 20.
- Playwright package: installed by `npm install`.
- Chromium launch: installed by `npx playwright install chromium`.
- `ffmpeg`: required to render MP4 output.
- `ffprobe`: required to verify the rendered MP4.

Successful output looks like this:

```text
[PASS] node: Node.js 20.0.0 satisfies >= 20.0.0
[PASS] playwright: Playwright package can be imported
[PASS] chromium: Chromium can be launched by Playwright
[PASS] ffmpeg: ffmpeg 6.1 is available
[PASS] ffprobe: ffprobe 6.1 is available
summary: 5 passed, 0 failed, 5 total
```

If a check fails, fix the item shown in the `fix:` line, then run `timelapse-capture doctor` again.

## Quick Start

This walkthrough starts from a local app running at `http://localhost:3000`, captures screenshots for one minute, renders an MP4, and leaves you with `output.mp4`.

1. Check dependencies:

```bash
timelapse-capture doctor
```

2. Start a short capture:

```bash
timelapse-capture start http://localhost:3000 \
  --duration 1m \
  --interval 5s \
  --fps 24 \
  --viewport 1440x900 \
  --out ./timelapse-runs/app-review
```

The command writes a run directory and prints the status and peek commands.

3. Check progress:

```bash
timelapse-capture status ./timelapse-runs/app-review
```

4. Inspect one frame:

```bash
timelapse-capture peek ./timelapse-runs/app-review --latest
```

The command prints a single image path. Open or inspect only that image when you need to see the current visual state.

5. Render the video after capture completes:

```bash
timelapse-capture render ./timelapse-runs/app-review
```

6. Inspect the MP4:

```bash
open ./timelapse-runs/app-review/output.mp4
```

On Linux, use your file manager or video player instead of `open`.

## Commands

### `timelapse-capture doctor [--json]`

Checks local runtime dependencies. Use `--json` when another tool needs machine-readable results.

### `timelapse-capture start <url> [options]`

Captures a URL into a run directory.

Common options:

- `--duration 2h`: total capture time. Also accepts shorter values such as `30s` or `10m`.
- `--interval 5s`: time between screenshots.
- `--fps 24`: MP4 frame rate used later during render.
- `--viewport 1440x900`: browser viewport.
- `--out ./timelapse-runs/app-review`: run directory.
- `--headed`: show Chromium while capturing.
- `--wait-until domcontentloaded`: Playwright navigation readiness.
- `--json`: print machine-readable command output.

### `timelapse-capture status <run-dir> [--json]`

Reports state, elapsed time, expected frames, captured frames, failed frames, latest frame path, disk usage, output path, and cleanup details when available.

### `timelapse-capture peek <run-dir> [--latest | --index <n> | --near <n>] [--json]`

Returns one frame path for inspection. `--latest` is the usual choice while the capture is active. `--index` and `--near` select a frame by position in the current MVP.

### `timelapse-capture render <run-dir> [--keep-frames] [--json]`

Renders `output.mp4` from the captured frames. By default, raw frames are deleted only after the MP4 has been written and verified.

Use `--keep-frames` when you need all raw screenshots preserved after render.

### `timelapse-capture cleanup <run-dir> [options]`

Performs explicit cleanup after a run.

Common options:

- `--frames`: delete raw frames and `latest.png`.
- `--all --force`: delete the whole run directory.
- `--keep-frames`: record that frames should be retained.
- `--keep-samples`: keep representative sample frames and remove the rest.
- `--keep-latest`: keep only the latest frame and remove the rest.

## Retention

Default retention is optimized for a useful MP4 artifact and disk hygiene:

- Frames are kept while capture is running.
- Frames are kept until render succeeds.
- After a successful render, raw frames are removed.
- Metadata, logs, summaries, and `output.mp4` are preserved.

Keep all frames through render:

```bash
timelapse-capture render ./timelapse-runs/app-review --keep-frames
```

Keep only representative samples during explicit cleanup:

```bash
timelapse-capture cleanup ./timelapse-runs/app-review --keep-samples
```

Keep only the latest frame during explicit cleanup:

```bash
timelapse-capture cleanup ./timelapse-runs/app-review --keep-latest
```

Record retention intent at capture start:

```bash
timelapse-capture start http://localhost:3000 \
  --duration 10m \
  --interval 10s \
  --keep-frames \
  --out ./timelapse-runs/debug-run
```

Still pass `--keep-frames` to `render` when you want the current MVP to preserve every raw screenshot after the MP4 is created.

## Artifacts

A run directory is self-contained:

```text
timelapse-runs/app-review/
  config.json
  status.json
  latest-frame.json
  latest.png
  manifest.json
  manifest.jsonl
  capture.log
  render.log
  run-summary.json
  output.mp4
  frames/
    frame-0001.png
    frame-0002.png
```

Important files:

- `status.json`: current run state and progress.
- `latest-frame.json`: metadata for the latest successful screenshot.
- `latest.png`: copy of the latest successful screenshot while frames exist.
- `manifest.jsonl`: one record per capture attempt.
- `capture.log`: capture lifecycle log.
- `run-summary.json`: render and cleanup summary.
- `output.mp4`: rendered timelapse video.

After default render cleanup, `frames/` is removed but `output.mp4`, metadata, and logs remain.

## Troubleshooting

### `doctor` says Node is too old

Install Node >= 20, reopen your shell, and run:

```bash
node --version
timelapse-capture doctor
```

### Playwright or Chromium fails

Run:

```bash
npm install
npx playwright install chromium
timelapse-capture doctor
```

If Chromium launches locally but capture still fails, try `--headed` once to see the browser window.

### `ffmpeg` or `ffprobe` is missing

Install FFmpeg with your package manager and confirm both commands are available:

```bash
ffmpeg -version
ffprobe -version
timelapse-capture doctor
```

### The URL fails to load

Confirm the app is running and reachable from the same shell:

```bash
curl -I http://localhost:3000
```

Use the full `http://` or `https://` URL. The CLI rejects unsupported protocols.

### `render` says no frames were found

Check status first:

```bash
timelapse-capture status ./timelapse-runs/app-review
```

If capture failed before saving any frame, inspect `capture.log` and fix the navigation or browser dependency issue before starting a new run.

### Raw frames disappeared after render

That is the default cleanup policy. Use this next time:

```bash
timelapse-capture render ./timelapse-runs/app-review --keep-frames
```

### `peek` cannot find a frame

No frame may have completed yet, or render cleanup may have removed raw frames. During capture, wait for `status` to show at least one captured frame. After render, inspect `output.mp4` or retained artifacts such as `latest.png` if present.
