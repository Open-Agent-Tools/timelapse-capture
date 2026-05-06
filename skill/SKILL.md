---
name: timelapse-capture
description: Start, monitor, inspect, render, and clean up long-running visual timelapse captures of web apps or app surfaces for human review. Use when a user wants screenshots captured every N seconds over a duration, a short MP4 timelapse, agent peeking at individual frames while capture runs, or post-render frame cleanup.
---

# timelapse-capture

Use this skill for long-running visual observation where a human reviewer wants a compact video artifact and the agent may need to inspect individual frames while the capture is still running.

## Prerequisites

Confirm the environment matches the README before starting:

- Node >= 20
- Project dependencies installed with `npm install`
- Playwright Chromium installed with `npx playwright install chromium`
- `ffmpeg` and `ffprobe` available on `PATH`

Run `timelapse-capture doctor` before any capture work. If working directly from
the repository instead of a linked binary, run `npm run start -- doctor`.

Do not start capture until `doctor` reports a healthy environment or the user
explicitly asks to proceed with known missing dependencies. Missing Chromium
breaks capture, and missing `ffmpeg` or `ffprobe` blocks reliable MP4 rendering
and validation.

## Workflow

Use this order: start -> status -> peek (inspection only) -> render -> report artifact paths.

1. Identify the target URL, duration, interval or final video length, viewport, output folder, and retention needs.
2. Run `timelapse-capture doctor` before any capture work and resolve failures first.
3. Start a durable capture job with the CLI.
4. Return the run directory, status command, and peek command to the user.
5. Use `status` to check progress.
6. Use `peek` to inspect one selected screenshot, usually `--latest`, while the run is active. Do not use `peek` as a bulk frame loader.
7. After capture completes, run `render`.
8. Report the final `output.mp4` path and the key metadata paths (`status.json`, `run-summary.json`, and `render.log` when present).
9. Let default cleanup remove raw frames after a successful render unless the user asked to keep them.

## CLI

```bash
timelapse-capture doctor

timelapse-capture start \
  --url http://localhost:3000 \
  --duration 2h \
  --video-length 1m \
  --fps 24 \
  --viewport 1440x900 \
  --out ./timelapse-runs/app-review
```

Useful commands:

```bash
timelapse-capture status ./timelapse-runs/app-review
timelapse-capture peek ./timelapse-runs/app-review --latest
timelapse-capture render ./timelapse-runs/app-review
```

When running from a repository checkout, prefix commands with `npm run start --`,
for example:

```bash
npm run start -- doctor
npm run start -- start --url http://localhost:3000 --duration 2h --video-length 1m
```

See `README.md` for detailed command documentation, installation instructions,
doctor output interpretation, troubleshooting, and dogfood tester examples.

## Frame Inspection

Do not load the full `frames/` directory into context. Use `peek` to select one frame:

```bash
timelapse-capture peek <run-dir> --latest --json
timelapse-capture peek <run-dir> --index 120 --json
timelapse-capture peek <run-dir> --near "2026-04-30T14:35:00-05:00" --json
```

Then inspect only the returned image path.

## Cleanup Policy

Default behavior keeps raw frames during capture and until render succeeds. After a successful render, raw frames are deleted. The final video, manifest, logs, status, summary, poster image, and configured sample frames are retained.

Use `--keep-frames` or `--cleanup never` when the user explicitly wants all raw screenshots preserved after render. Prefer default cleanup for routine reviews. Use `--keep-samples <n>` or `--keep-latest` when the user needs lightweight evidence without retaining every frame.

## Agent Example

For a local page review, first run `timelapse-capture doctor`. If the checks pass, start capture against the local URL, monitor with `status`, inspect only the latest frame with `peek --latest`, render when capture completes, and report the paths to `output.mp4`, `status.json`, `run-summary.json`, and any retained sample frames.
