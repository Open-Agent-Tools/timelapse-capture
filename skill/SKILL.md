# timelapse-capture Agent Skill

Use this skill when an agent needs to capture a web page over time, inspect the
captured frames, render an MP4, and report the resulting artifacts.

## Prerequisites

Before using the CLI, make sure the environment has:

- Node >= 20
- Project dependencies installed with `npm install`
- Playwright Chromium installed with `npx playwright install chromium`
- `ffmpeg` and `ffprobe` available on `PATH`

The README.md is the canonical command reference for humans and agents. Keep
this skill focused on the required agent workflow.

## Required Preflight

Run `timelapse-capture doctor` before any capture work.

Use `npx timelapse-capture doctor` from a local checkout unless the command is
already installed globally. Stop and report the failure if doctor does not pass.
Do not start a capture until the runtime check has completed successfully.

## Agent Workflow

Follow this order for capture work:

```text
start -> status -> peek -> render -> report
```

1. Start the capture:

   ```sh
   npx timelapse-capture start <url>
   ```

   Record the printed `run-dir:` path.

2. Check status:

   ```sh
   npx timelapse-capture status <run-dir>
   ```

   Confirm the run has successful frames before rendering.

3. Peek for inspection only:

   ```sh
   npx timelapse-capture peek <run-dir> --latest
   ```

   Use `peek` to inspect the latest PNG path. Do not modify captured frame files.

4. Render the MP4:

   ```sh
   npx timelapse-capture render <run-dir>
   ```

5. Report artifact paths:

   - Run directory: `<run-dir>`
   - MP4: `<run-dir>/output.mp4`
   - Latest inspected frame path from `peek`, if retained
   - Any relevant status or render error message

## Retention Guidance

By default, successful rendering may remove captured frames. Choose retention
intentionally when the user needs evidence beyond the MP4:

- Use `npx timelapse-capture cleanup <run-dir> --keep-frames` when all frames
  must remain available for debugging.
- Use `npx timelapse-capture cleanup <run-dir> --keep-samples` when first and
  last frame evidence is enough.
- Use `npx timelapse-capture cleanup <run-dir> --keep-latest` for a single
  visual sanity-check frame.

## Example Use Case

An agent captures a local page, validates dependencies with doctor, starts
capture, monitors with status, peeks at the latest frame for inspection only,
renders the video, and reports the `output.mp4` path plus the run directory.

For command details, troubleshooting, and artifact layout, read README.md.
