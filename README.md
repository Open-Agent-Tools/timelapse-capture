# timelapse-capture

Fire-and-forget visual timelapse capture for long-running app review.

The MVP captures a browser URL at a fixed interval, lets agents or humans peek at individual frames while capture is running, renders a compact MP4 with `ffmpeg`, and deletes raw frames after a successful render by default.

## Install

```bash
npm install
npm link
```

Install Playwright browsers if needed:

```bash
npx playwright install chromium
```

`ffmpeg` must be available on `PATH` for rendering.

## Example

Capture a two-hour run and render it as a one-minute video at 24 FPS:

```bash
timelapse-capture start \
  --url http://localhost:3000 \
  --duration 2h \
  --video-length 1m \
  --fps 24 \
  --viewport 1440x900 \
  --out ./timelapse-runs/app-review
```

Check progress:

```bash
timelapse-capture status ./timelapse-runs/app-review
```

Peek at the latest completed frame:

```bash
timelapse-capture peek ./timelapse-runs/app-review --latest
```

Render the video:

```bash
timelapse-capture render ./timelapse-runs/app-review
```

By default, `render` deletes `frames/` only after `output.mp4` has been written successfully. Use `--keep-frames` on `start` to retain all screenshots.

## Project Layout

```text
src/timelapse-capture.mjs  CLI implementation
skill/SKILL.md             Draft Codex/Claude-style skill instructions
docs/PRD.md                Product requirements
```
