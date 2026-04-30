---
name: timelapse-capture
description: Start, monitor, inspect, render, and clean up long-running visual timelapse captures of web apps or app surfaces for human review. Use when a user wants screenshots captured every N seconds over a duration, a short MP4 timelapse, agent peeking at individual frames while capture runs, or post-render frame cleanup.
---

# timelapse-capture

Use this skill for long-running visual observation where a human reviewer wants a compact video artifact and the agent may need to inspect individual frames while the capture is still running.

## Workflow

1. Identify the target, duration, interval or final video length, viewport, and output folder.
2. Start a durable capture job with the CLI.
3. Return the run directory, status command, and peek command to the user.
4. Use `status` to check progress.
5. Use `peek` to inspect one selected screenshot, usually `--latest`, while the run is active.
6. After capture completes, run `render`.
7. Let default cleanup remove raw frames after a successful render unless the user asked to keep them.

## CLI

```bash
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

Use `--keep-frames` or `--cleanup never` when the user explicitly wants all raw screenshots preserved after render.

