---
name: timelapse-capture
description: Start, monitor, inspect, render, and clean up long-running visual timelapse captures of web apps or app surfaces for human review. Use when a user wants screenshots captured every N seconds over a duration, a short MP4 timelapse, agent peeking at individual frames while capture runs, or post-render frame cleanup.
---

# timelapse-capture

Use this skill for long-running visual observation where a human reviewer wants a compact video artifact and the agent may need to inspect individual frames while the capture is still running.

## Prerequisites

Before using the CLI, confirm the environment has:

- Node.js 24 or newer
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
4. Record the returned run directory and printed alias (e.g. `cheeky-monkey-427`).
5. Run `timelapse-capture status <run-dir-or-alias>` to monitor progress. With no argument, status defaults to the most recent run in `./timelapse-runs/`.
6. Run `timelapse-capture peek <run-dir-or-alias> --latest` for inspection only.
7. Wait for `status` to report `state: rendered` — render runs automatically when capture completes.
8. Report artifact paths, especially the run directory and `output.mp4`.

The required command sequence is start -> status -> peek -> wait for rendered -> report artifact paths, with `doctor` before the start command.

To cancel a capture in progress:

```bash
timelapse-capture stop <run-dir>
```

`stop` sends SIGTERM to the background process and marks the run as failed. Any frames captured before the stop remain in the run directory and can be rendered manually.

## CLI Example

```bash
timelapse-capture doctor

timelapse-capture start http://localhost:3000 \
  --duration 30s \
  --interval 5s \
  --viewport 1440x900

timelapse-capture status ./timelapse-runs/localhost-3000-20260507-121530
timelapse-capture peek ./timelapse-runs/localhost-3000-20260507-121530 --latest
# render runs automatically; poll status until state: rendered
timelapse-capture status ./timelapse-runs/localhost-3000-20260507-121530
```

If the caller has not linked the binary, use npm from the repository root:

```bash
npm start -- doctor
```

If the target SPA opens a WebSocket that is also consumed by other clients (e.g. a dashboard bridge fanning to a real browser tab plus this capture), add `--block-websockets` to `start`. The flag stubs `window.WebSocket` before page scripts run, so a CPU-saturated headless renderer cannot wedge the upstream sender. Captured frames will show the SPA's WS-disconnected state — fine for visual timelapses, not for SPAs that need live data to paint.

## Frame Inspection

Use `peek` to select exactly one frame:

```bash
timelapse-capture peek <run-dir> --latest --json
timelapse-capture peek <run-dir> --index 0 --json
timelapse-capture peek <run-dir> --near "2026-05-07T12:00:00Z" --json
```

Then inspect only the returned image path. Do not load the full `frames/` directory into context.

## Rendering

Render runs automatically when capture completes. The status will transition: `running` → `completed` → `rendering` → `rendered`. Poll `status` until `state: rendered` before reporting the artifact path.

To skip auto-render and produce the MP4 manually:

```bash
timelapse-capture start <url> --no-render ...
# then after status reports completed:
timelapse-capture render <run-dir>
```

Report the final video path:

```text
<run-dir>/output.mp4
```

If render fails, read the error, run `timelapse-capture doctor`, and verify the run has captured frames with `status`. Render failures preserve raw frames for retry.

## Retention Guidance

Default behavior keeps raw frames during capture and removes them after a successful render. The MP4, status, manifest.json, manifest.jsonl, config, job, and run summary remain in the run directory.

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
