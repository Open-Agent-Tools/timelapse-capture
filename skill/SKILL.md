---
name: timelapse-capture
description: Start, monitor, inspect, render, and clean up long-running visual timelapse captures of web apps or app surfaces for human review. Use when a user wants screenshots captured every N seconds over a duration, a short MP4 timelapse, agent peeking at individual frames while capture runs, or post-render frame cleanup.
---

# timelapse-capture

Use this skill for long-running visual observation where a human reviewer wants a compact video artifact and the agent may need to inspect individual frames while the capture is still running.

## Prerequisites

Before using the CLI, confirm the environment has:

- Node.js 20 or newer
- Project dependencies installed with `npm install`
- Playwright Chromium installed with `npx playwright install chromium`
- `ffmpeg` and `ffprobe` available on `PATH`

README.md is the canonical user guide for installation, command details, troubleshooting, and artifact layout.

## Required Dependency Check

Run `timelapse-capture doctor` before any capture work.

Do not start a capture until `doctor` reports all checks passing. The command verifies Node.js, Playwright, Chromium launch support, `ffmpeg`, and `ffprobe`. If a check fails, apply the printed fix and run `doctor` again.

Use JSON when another tool needs structured status:

```bash
timelapse-capture doctor --json
```

## Agent Workflow

Follow this order for every capture:

1. Collect the target URL, duration, interval, viewport, and any retention requirement.
2. Run `timelapse-capture doctor` and stop if it fails.
3. Run `timelapse-capture start <url>` with the chosen duration, interval, and viewport.
4. Record the returned run directory.
5. Run `timelapse-capture status <run-dir>` to monitor progress.
6. Run `timelapse-capture peek <run-dir> --latest` for inspection only.
7. After capture completes, run `timelapse-capture render <run-dir>`.
8. Report artifact paths, especially the run directory and `output.mp4`.

The required command sequence is start -> status -> peek -> render -> report artifact paths, with `doctor` before the start command.

## CLI Example

```bash
timelapse-capture doctor

timelapse-capture start http://localhost:3000 \
  --duration 30s \
  --interval 5s \
  --viewport 1440x900

timelapse-capture status ./runs/localhost-3000-1760000000000
timelapse-capture peek ./runs/localhost-3000-1760000000000 --latest
timelapse-capture render ./runs/localhost-3000-1760000000000
```

If the caller has not linked the binary, use npm from the repository root:

```bash
npm start -- doctor
```

## Frame Inspection

Use `peek` to select exactly one frame:

```bash
timelapse-capture peek <run-dir> --latest --json
timelapse-capture peek <run-dir> --index 0 --json
timelapse-capture peek <run-dir> --near 2 --json
```

Then inspect only the returned image path. Do not load the full `frames/` directory into context.

## Rendering

Run render after the status command reports completion:

```bash
timelapse-capture render <run-dir>
```

Report the final video path:

```text
<run-dir>/output.mp4
```

If render fails, read the error, run `timelapse-capture doctor`, and verify the run has captured frames with `status`. Render failures preserve raw frames for retry.

## Retention Guidance

Default behavior keeps raw frames during capture and removes them after a successful render. The MP4, status, manifest, config, job, and run summary remain in the run directory.

Use `--keep-frames` only when the user explicitly asks to preserve all screenshots or when recording a retention decision during cleanup:

```bash
timelapse-capture cleanup <run-dir> --keep-frames
```

Use sample retention when the reviewer wants a small frame set instead of every screenshot:

```bash
timelapse-capture cleanup <run-dir> --keep-samples
timelapse-capture cleanup <run-dir> --keep-latest
```

Use default cleanup for ordinary review videos so large frame directories do not accumulate.

## Reporting

When the workflow finishes, report:

- `doctor` result.
- Run directory.
- Latest status summary.
- Peeked frame path if inspected.
- Rendered MP4 path.
- Cleanup or retention action taken.

Example use case: an agent captures a local page, validates dependencies with `doctor`, starts capture, monitors with `status`, peeks at only the latest frame, renders, and reports `output.mp4` plus the run directory.
