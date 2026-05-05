# timelapse-capture

`timelapse-capture` captures a web page as a sequence of frames, lets you inspect
the run while it is in progress, and renders the frames into an MP4.

The current CLI is intentionally small and file-based. Each run writes a run
directory containing JSON status files, captured frames, and, after rendering,
`output.mp4`.

## Installation

Install these prerequisites before starting a capture:

1. Install Node >= 20.
2. Install package dependencies:

   ```sh
   npm install
   ```

3. Install Playwright's Chromium browser:

   ```sh
   npx playwright install chromium
   ```

4. Install `ffmpeg` and `ffprobe`.

   macOS with Homebrew:

   ```sh
   brew install ffmpeg
   ```

   Debian or Ubuntu:

   ```sh
   sudo apt-get update
   sudo apt-get install ffmpeg
   ```

5. Confirm the CLI is available:

   ```sh
   npx timelapse-capture --help
   ```

## Doctor

Run `doctor` before capture work:

```sh
npx timelapse-capture doctor
```

The command checks whether the runtime can invoke `timelapse-capture`. Use the
installation checklist above if it reports a missing dependency. A JSON form is
also available for automation:

```sh
npx timelapse-capture doctor --json
```

Example output:

```json
{
  "node": true,
  "command": "timelapse-capture"
}
```

Interpretation:

- `node: true` means the CLI is running under Node.
- `command: "timelapse-capture"` identifies the checked command.
- If capture or render still fails after doctor passes, check Chromium and
  `ffmpeg`/`ffprobe` installation paths in your shell.

## Quick Start

This walkthrough starts from a local install and ends with a rendered MP4.

1. Check prerequisites:

   ```sh
   npx timelapse-capture doctor
   ```

2. Start a capture. Replace the URL with the page you want to record:

   ```sh
   npx timelapse-capture start https://example.com
   ```

   The command prints a `run-dir:` line. Copy that path into the commands below.

3. Inspect progress:

   ```sh
   npx timelapse-capture status <run-dir>
   ```

4. Peek at the latest captured frame:

   ```sh
   npx timelapse-capture peek <run-dir> --latest
   ```

   `peek` reports a frame path. Open that PNG if you need to inspect what the
   capture is seeing. Do not edit files in the run directory.

5. Render the MP4:

   ```sh
   npx timelapse-capture render <run-dir>
   ```

6. Inspect the rendered video:

   ```sh
   open <run-dir>/output.mp4
   ```

   On Linux, use your desktop's file opener or video player instead of `open`.

## Commands

```sh
npx timelapse-capture start <url> [--duration 10s] [--interval 1s] [--viewport 1280x720] [--json]
npx timelapse-capture status <run-dir> [--json]
npx timelapse-capture peek <run-dir> [--latest] [--index 0] [--near 2] [--json]
npx timelapse-capture render <run-dir> [--force]
npx timelapse-capture cleanup <run-dir> [--keep-frames] [--keep-samples] [--keep-latest]
npx timelapse-capture doctor [--json]
```

Command notes:

- `start` creates the run directory and captures frames for the target URL.
- `status` reads `status.json` and reports state, frame counts, latest frame,
  disk usage, and rendered output when available.
- `peek` returns the path to a captured PNG. It is for inspection only.
- `render` writes `<run-dir>/output.mp4` from frames in `<run-dir>/frames`.
- `cleanup` removes or retains captured frames according to retention flags.
- `doctor` verifies the CLI runtime before capture work starts.

## Retention

Rendering removes frames by default after a successful MP4 render. Preserve
frames when you need to debug capture quality or share samples.

Keep every frame:

```sh
npx timelapse-capture cleanup <run-dir> --keep-frames
```

Keep the first and last frame:

```sh
npx timelapse-capture cleanup <run-dir> --keep-samples
```

Keep only the latest frame:

```sh
npx timelapse-capture cleanup <run-dir> --keep-latest
```

Use `--keep-frames` for deep debugging, `--keep-samples` for before/after
evidence, and `--keep-latest` when you only need a quick visual sanity check.

## Artifacts

A run directory contains these files and folders:

```text
<run-dir>/
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

- `frames/` contains captured PNG frames until render or cleanup removes them.
- `status.json` is the source for `status`.
- `output.mp4` is the rendered video.
- `run-summary.json` records render metadata and cleanup results.

When reporting a completed run, include the run directory, `output.mp4`, and any
retained frame paths returned by `peek`.

## Troubleshooting

Missing `ffmpeg` or `ffprobe`:

- Symptom: render fails or MP4 validation cannot read metadata.
- Fix: install `ffmpeg`, then confirm both commands are on your `PATH`:

  ```sh
  ffmpeg -version
  ffprobe -version
  ```

Chromium launch failure:

- Symptom: capture cannot start or Playwright reports that Chromium is missing.
- Fix: run `npx playwright install chromium`.

Bad or unsupported URL:

- Symptom: `start` reports `navigation failed: invalid URL`.
- Fix: use a full `http://` or `https://` URL.

No frames available:

- Symptom: `peek` reports `No frames available` or render reports
  `No frames found to render`.
- Fix: run `status <run-dir>` and check whether the capture succeeded. Start a
  new capture if the run has no successful frames.

Unexpected cleanup:

- Symptom: frames are gone after render.
- Fix: this is the default successful-render behavior. Re-run the capture and
  use cleanup retention flags when you need frame evidence.

Stale run status:

- Symptom: `status` reports an old latest frame timestamp or no progress.
- Fix: inspect the URL in a browser, verify network access, and start a fresh
  run after `doctor` passes.
