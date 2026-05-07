---
name: timelapse-capture
description: Start, monitor, inspect, render, and clean up long-running visual timelapse captures of web apps or app surfaces for human review. Use when a user wants screenshots captured every N seconds over a duration, a short MP4 timelapse, agent peeking at individual frames while capture runs, or post-render frame cleanup.
---

# timelapse-capture

Use this skill for long-running visual observation where a human reviewer wants a compact video artifact and the agent may need to inspect individual frames while the capture is still running.

README.md is the canonical user-facing command reference. This skill adds agent-specific workflow rules.

## Prerequisites

Before using the CLI, confirm the environment has:

- Node >= 20
- Project dependencies installed with `npm install`
- Chromium installed with `npx playwright install chromium`
- `ffmpeg` and `ffprobe` available on `PATH`
- The `timelapse-capture` command available through `npm link`, or use `node ./src/timelapse-capture.mjs`

## Required Doctor Check

Run `timelapse-capture doctor` before any capture work.

Do not start a capture until doctor passes or the user explicitly accepts the failed check. Doctor validates Node, Playwright, Chromium, `ffmpeg`, and `ffprobe`; failures usually mean capture or render will fail later.

Use JSON output when you need structured evidence:

```bash
timelapse-capture doctor --json
```

## Agent Workflow

1. Identify the target URL, duration, interval or final video intent, viewport, and output folder.
2. Run `timelapse-capture doctor` before any capture work.
3. Start the capture with `timelapse-capture start <url>`.
4. Report the run directory plus exact `status` and `peek` commands.
5. Use `status` to monitor progress.
6. Use `peek` only to inspect one selected frame, usually `--latest`.
7. After capture completes, run `render`.
8. Report artifact paths: `output.mp4`, `run-summary.json`, `status.json`, and any retained frame or sample paths.

## Example

```bash
timelapse-capture doctor

timelapse-capture start http://localhost:3000 \
  --duration 10m \
  --interval 5s \
  --fps 24 \
  --viewport 1440x900 \
  --out ./timelapse-runs/app-review

timelapse-capture status ./timelapse-runs/app-review
timelapse-capture peek ./timelapse-runs/app-review --latest --json
timelapse-capture render ./timelapse-runs/app-review
```

## Frame Inspection

Do not load the full `frames/` directory into context. Use `peek` to select one frame:

```bash
timelapse-capture peek <run-dir> --latest --json
timelapse-capture peek <run-dir> --index 120 --json
timelapse-capture peek <run-dir> --near 120 --json
```

Inspect only the returned image path.

## Retention Guidance

Default behavior keeps raw frames during capture and until render succeeds. After a successful render, raw frames are deleted. The final video, manifest, logs, status, and run summary are retained.

Use `render --keep-frames` when the user wants all raw screenshots preserved after render:

```bash
timelapse-capture render <run-dir> --keep-frames
```

Use explicit cleanup commands when the user wants fewer retained images:

```bash
timelapse-capture cleanup <run-dir> --keep-samples
timelapse-capture cleanup <run-dir> --keep-latest
```

## Reporting

When the work is complete, report:

- Whether doctor passed.
- The run directory.
- The latest status summary.
- The render output path, usually `<run-dir>/output.mp4`.
- Any cleanup or retention choice used, especially `--keep-frames`.
- Any failures from `capture.log`, `status.json`, or `run-summary.json`.
