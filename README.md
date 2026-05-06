# timelapse-capture

Fire-and-forget visual timelapse capture for long-running app review. It opens a
browser page, saves screenshots at a fixed cadence, lets you inspect individual
frames while the capture is running, and renders the result into a compact MP4.

The default cleanup policy keeps raw frames until a render succeeds, then removes
the bulky `frames/` directory while preserving the final video and run metadata.

## Installation

Requirements:

- Node >= 20
- npm
- Playwright Chromium browser files
- `ffmpeg` and `ffprobe` available on `PATH`

Install package dependencies:

```bash
npm install
```

Install the browser that Playwright uses for capture:

```bash
npx playwright install chromium
```

Install `ffmpeg` and `ffprobe` with your system package manager if they are not
already present:

```bash
# macOS with Homebrew
brew install ffmpeg

# Ubuntu/Debian
sudo apt-get update && sudo apt-get install -y ffmpeg
```

For local development, run the CLI through npm:

```bash
npm run start -- help
```

After publishing or linking the package, the same commands can be run as
`timelapse-capture ...`.

## Dependencies And Doctor

Run `doctor` before a capture session to check that the local environment is
ready:

```bash
npm run start -- doctor
```

Use JSON output when another tool or agent needs to parse the result:

```bash
npm run start -- doctor --json
```

A healthy result reports `ok: true`. Each check shows whether a dependency is
available and, when possible, the detected version. If `ffmpeg` or `ffprobe` is
missing, install `ffmpeg`. If Chromium is missing or cannot launch, run
`npx playwright install chromium`.

## Quick Start

This walkthrough starts from a local app at `http://localhost:3000`, captures a
short run, inspects the latest frame, renders an MP4, and shows where the output
is stored.

1. Check dependencies:

```bash
npm run start -- doctor
```

2. Start a capture:

```bash
npm run start -- start \
  --url http://localhost:3000 \
  --duration 2m \
  --video-length 10s \
  --fps 24 \
  --viewport 1440x900 \
  --out ./timelapse-runs/dogfood-review
```

The command returns immediately and prints the run directory plus commands for
checking progress and peeking at frames.

3. Check progress:

```bash
npm run start -- status ./timelapse-runs/dogfood-review
```

4. Inspect one frame while the run is active:

```bash
npm run start -- peek ./timelapse-runs/dogfood-review --latest
```

`peek` returns one image path. Open that PNG to inspect the page state without
loading the entire frame directory.

5. Render the MP4 after capture completes:

```bash
npm run start -- render ./timelapse-runs/dogfood-review
```

6. Inspect the rendered video:

```bash
open ./timelapse-runs/dogfood-review/output.mp4
```

On Linux, use your normal file manager or video player instead of `open`.

## Commands

```bash
npm run start -- doctor [--json]
npm run start -- start --url <url> --duration <2h> (--interval <5s> | --video-length <1m>) [--out <dir>]
npm run start -- status <run-dir> [--json]
npm run start -- peek <run-dir> [--latest | --index <n> | --near <iso>] [--json]
npm run start -- render <run-dir> [--output <file>] [--json]
npm run start -- cleanup <run-dir> [--force]
```

Use `timelapse-capture` instead of `npm run start --` when the package is linked
or installed as a command.

## Doctor Command

`doctor` is the first command to run on a new machine or before a dogfood test.
It checks:

- Node: confirms the runtime can execute the CLI.
- Playwright Chromium: confirms the capture browser can launch.
- ffmpeg: confirms MP4 rendering is available.
- ffprobe: confirms rendered MP4 inspection is available.

Example healthy output:

```text
timelapse-capture doctor
ok: true
node: ok v20.11.0
playwright chromium: ok
ffmpeg: ok ffmpeg version 6.1
ffprobe: ok ffprobe version 6.1
```

If `ok` is false, fix the failed checks before starting capture. A capture can
write frames without rendering successfully if `ffmpeg` is missing, so catching
that up front avoids wasted runs.

## Retention

By default, `render` deletes `frames/` only after `output.mp4` has been written
successfully. Failed renders preserve frames for debugging.

Keep every raw screenshot after render:

```bash
npm run start -- start \
  --url http://localhost:3000 \
  --duration 30m \
  --video-length 1m \
  --keep-frames \
  --out ./timelapse-runs/keep-all
```

Equivalent explicit cleanup policy:

```bash
npm run start -- start \
  --url http://localhost:3000 \
  --duration 30m \
  --interval 5s \
  --cleanup never \
  --out ./timelapse-runs/keep-all
```

Keep lightweight review frames instead of every screenshot:

```bash
npm run start -- start \
  --url http://localhost:3000 \
  --duration 30m \
  --video-length 1m \
  --keep-samples 5 \
  --keep-latest \
  --out ./timelapse-runs/keep-samples
```

Use `--keep-frames` when you need frame-by-frame debugging. Prefer the default
cleanup or sample retention for routine reviews to avoid large run directories.

## Artifacts

A run directory contains the capture and render artifacts:

```text
timelapse-runs/dogfood-review/
  config.json
  status.json
  manifest.jsonl
  latest-frame.json
  output.mp4
  poster.png
  run-summary.json
  render.log
  frames/
```

During capture, `frames/` holds PNG screenshots. After a successful default
render, raw frames are removed and the metadata, logs, poster image, retained
samples, and `output.mp4` remain.

## Troubleshooting

`Unknown command: doctor`

Make sure you are running this repository's current CLI with `npm run start --
doctor`, or reinstall/relink the package if you are using the
`timelapse-capture` binary from another checkout.

`ffmpeg` or `ffprobe` is missing

Install `ffmpeg` with your system package manager, then run `npm run start --
doctor` again. Most installations include both `ffmpeg` and `ffprobe`.

Chromium fails to launch

Run `npx playwright install chromium`. On Linux CI or minimal containers, also
install Playwright's operating-system dependencies if Chromium reports missing
shared libraries.

The target URL does not load

Open the URL in a normal browser on the same machine. For local apps, confirm the
dev server is running and that the URL includes the correct protocol and port,
for example `http://localhost:3000`.

No MP4 is produced

Check `status.json` and `render.log` in the run directory. If render failed,
frames are preserved so you can inspect them with `peek` or rerun `render` after
fixing the dependency or input problem.

The run directory is too large

Render the run to allow default frame cleanup, or use `cleanup` after verifying
the MP4. For future long runs, avoid `--keep-frames` unless raw screenshots are
required.

## Project Layout

```text
src/timelapse-capture.mjs  CLI implementation
skill/SKILL.md             Agent skill instructions
docs/PRD.md                Product requirements
```
