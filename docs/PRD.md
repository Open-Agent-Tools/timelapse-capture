# PRD: timelapse-capture Skill

## Summary

`timelapse-capture` is a reusable agent skill for starting long-running visual captures of web apps, desktop apps, browser tabs, or screen regions, then compiling the captured frames into a short human-reviewable timelapse video.

The skill is primarily designed for human reviewers who want to observe behavior over time without watching an app live. It should also support agents peeking at selected screenshots while a capture is still running, so they can inspect progress, diagnose blank/error states, or report intermediate status without loading every frame into context.

## Problem

Current agent workflows can take one-off screenshots through tools such as Playwright, browser automation, or desktop capture. These are useful for point-in-time inspection, but they do not cover long-running visual scenarios such as:

- Watching a dashboard update over two hours.
- Capturing a UI during a long background job.
- Observing flaky visual states that appear intermittently.
- Reviewing animation, progress, polling, deployment, or monitoring behavior.
- Producing a compact artifact that a human can review quickly after the run.

Many browser and test harnesses support videos only inside a test lifecycle, and those videos are often too heavy or poorly suited for multi-hour observation. A frame-based timelapse approach is simpler, inspectable, resumable, and easier to clean up after rendering.

## Goals

- Start a long-running capture job with minimal user input.
- Capture screenshots at a configurable interval for a configurable duration.
- Render captured frames into an MP4 timelapse video.
- Let agents inspect individual frames while capture is running.
- Preserve enough metadata for debugging and auditability.
- Clean up raw frame files after successful video render by default.
- Provide explicit retention controls for users who want to keep frames.
- Make the workflow durable enough that the agent does not need to remain active for the whole capture.

## Non-Goals

- Replace full test harness video recording.
- Provide frame-perfect continuous video capture.
- Perform complex visual analysis or computer vision in the MVP.
- Require Playwright as the only capture mechanism.
- Store large image archives indefinitely by default.
- Upload artifacts to external services by default.

## Primary Users

- Human reviewers who want a compact visual summary of a long-running app session.
- Agents that need to start and later check on a visual capture run.
- Engineers debugging UI behavior over time.
- Designers or PMs reviewing long-running UX flows, loading states, dashboards, or real-time surfaces.

## Core Use Cases

### 1. Fire-and-Forget Web App Timelapse

The user asks the agent to capture `http://localhost:3000` every 5 seconds for 2 hours and produce a 1-minute video.

Expected behavior:

- Agent starts a durable capture process.
- Process writes screenshots, manifest entries, status files, and logs.
- Agent returns the run directory and status command.
- User can leave and come back later.
- Render command produces an MP4.
- Raw frames are deleted after successful render unless retention is requested.

### 2. Agent Peeks While Capture Is Running

The user asks, "What does it look like now?" during an active run.

Expected behavior:

- Agent uses the skill's peek command.
- The command returns the latest frame path and metadata.
- Agent inspects only the selected frame, not the entire frame directory.
- Agent reports visible state and any obvious issue.

### 3. Human Review After Completion

The capture finishes and renders a video.

Expected behavior:

- Final output includes an MP4, manifest, capture summary, and optional contact sheet.
- Raw frames are cleaned up by default.
- The run remains understandable without the frames through summary metadata and retained sample frames if configured.

### 4. Debug-Oriented Run With Frame Retention

The user knows they may need to inspect individual frames after rendering.

Expected behavior:

- User can pass `--keep-frames`, `--keep-samples`, or a retention policy.
- The renderer does not delete frames when retention requires them.
- The run summary clearly states what was retained and why.

## MVP Scope

The MVP should support:

- Browser URL capture using Playwright or a similar browser automation backend.
- Configurable duration, interval, viewport, output FPS, and output directory.
- Durable background capture process.
- Status file with progress and error counts.
- JSONL manifest with one record per frame attempt.
- Latest-frame pointer for agent and human inspection.
- Peek command for latest frame, frame by index, and frame near timestamp.
- MP4 rendering through `ffmpeg`.
- Default raw-frame cleanup after successful render.
- Explicit retention flags to keep frames.
- Failure-tolerant capture loop that logs missed frames and continues.

## Future Scope

- Attach to an existing browser via Chrome DevTools Protocol.
- Desktop window or screen-region capture.
- User-provided frame command backend.
- GIF or WebM output.
- Contact sheet generation.
- Duplicate-frame detection.
- Blank-frame and error-screen detection.
- Timestamp overlay.
- Resume interrupted captures.
- Multi-viewport capture in one run.
- Optional lightweight visual anomaly report.

## Proposed Interface

The skill should expose a CLI-like workflow. The exact implementation can be scripts bundled inside the skill.

### Start

```bash
timelapse-capture start \
  --url http://localhost:3000 \
  --duration 2h \
  --interval 5s \
  --viewport 1440x900 \
  --fps 24 \
  --out ./timelapse-runs/app-review
```

Behavior:

- Creates the run directory.
- Starts capture in the background.
- Writes a PID file or job metadata file.
- Writes initial `status.json`.
- Writes `latest.png` as a symlink or small pointer file once the first frame exists.
- Returns immediately with the run path and status command.

### Status

```bash
timelapse-capture status ./timelapse-runs/app-review
```

Output should include:

- State: one of `starting`, `running`, `completed`, `failed`, `rendering`, `rendered`, `render_failed`.
- Started at, elapsed time, estimated completion.
- Frames attempted, captured, failed, skipped.
- Latest frame timestamp.
- Disk usage.
- Render status if applicable.
- Cleanup status.

### Peek

```bash
timelapse-capture peek ./timelapse-runs/app-review --latest
timelapse-capture peek ./timelapse-runs/app-review --index 120
timelapse-capture peek ./timelapse-runs/app-review --near "2026-04-30T14:35:00-05:00"
```

Behavior:

- Returns a single screenshot path plus metadata.
- Does not render or load multiple frames.
- Works while capture is running.
- Allows agents to inspect selected frames through existing image inspection tools.
- Should fail gracefully if no frames have been captured yet.

### Render

```bash
timelapse-capture render ./timelapse-runs/app-review
```

Behavior:

- Converts frames into an MP4 using configured FPS.
- Writes render metadata.
- Verifies the output file exists and has nonzero duration/size.
- Cleans up raw frames after successful render by default.
- Preserves manifest, logs, status, render summary, and final video.

### Cleanup

```bash
timelapse-capture cleanup ./timelapse-runs/app-review --frames
timelapse-capture cleanup ./timelapse-runs/app-review --all
```

Behavior:

- Allows explicit cleanup independent of render.
- Refuses to delete frames before render unless `--force` is provided.
- Records cleanup action in `run-summary.json`.

## Frame Retention And Cleanup

Raw screenshots are useful during capture but can become large quickly. The default policy should optimize for human review and disk hygiene.

Default policy:

- Keep raw frames while capture is running.
- Keep raw frames until render succeeds.
- After successful render, delete raw frames.
- Keep final video, manifest, logs, status, and run summary.
- Keep `poster.png` and optionally a small sample set if enabled.

Retention options:

- `--cleanup after-render`: default.
- `--cleanup never`: keep all frames.
- `--keep-frames`: alias for `--cleanup never`.
- `--keep-samples N`: retain N representative frames after render.
- `--keep-latest`: retain the final captured frame after render.
- `--delete-after 7d`: optional future policy for scheduled cleanup.

Cleanup safety:

- Never delete frames if render fails.
- Never delete manifest or logs as part of frame cleanup.
- Write a cleanup record with timestamp, number of files deleted, and bytes freed.
- If sample frames are retained, copy them to `samples/` before deleting `frames/`.
- Ensure the final video is readable before deleting frames.

## Agent Peek Requirements

The skill should explicitly support agent inspection without requiring bulk frame loading.

Requirements:

- Maintain `latest-frame.json` with path, timestamp, frame index, URL, title, viewport, and capture status.
- Optionally maintain `latest.png` as a symlink or copied image for simple access.
- Provide `peek` commands for latest, index, and timestamp-nearest frame.
- Return machine-readable output with `--json`.
- Keep frame filenames sortable and stable, such as `frame-0001.png`.
- Record failed capture attempts in the manifest so missing frames are explainable.
- Allow peeking during capture without locking or corrupting the frame being written.

Recommended behavior:

- Write each frame to a temporary file first, then atomically rename it into `frames/`.
- Update `latest-frame.json` only after the frame file is complete.
- If the latest frame is older than expected, status should surface that the capture may be stalled.

## Run Directory Structure

```text
timelapse-runs/app-review/
  config.json
  status.json
  latest-frame.json
  manifest.jsonl
  capture.log
  render.log
  run-summary.json
  output.mp4
  poster.png
  frames/
    frame-0001.png
    frame-0002.png
  samples/
    sample-000001.png
```

After default cleanup:

```text
timelapse-runs/app-review/
  config.json
  status.json
  latest-frame.json
  manifest.jsonl
  capture.log
  render.log
  run-summary.json
  output.mp4
  poster.png
  samples/
```

## Manifest Format

Each line in `manifest.jsonl` should represent one capture attempt.

```json
{
  "index": 42,
  "scheduledAt": "2026-04-30T14:03:25.000-05:00",
  "capturedAt": "2026-04-30T14:03:25.180-05:00",
  "path": "frames/frame-0042.png",
  "status": "captured",
  "url": "http://localhost:3000",
  "title": "Dashboard",
  "viewport": { "width": 1440, "height": 900 },
  "error": null
}
```

For a failed attempt:

```json
{
  "index": 43,
  "scheduledAt": "2026-04-30T14:03:30.000-05:00",
  "capturedAt": null,
  "path": null,
  "status": "failed",
  "url": "http://localhost:3000",
  "title": null,
  "viewport": { "width": 1440, "height": 900 },
  "error": "Timeout while waiting for screenshot"
}
```

## Duration And Interval Calculation

The skill should support both direct interval input and target video length input.

Direct interval:

```bash
--duration 2h --interval 5s --fps 24
```

Target video length:

```bash
--duration 2h --video-length 1m --fps 24
```

Calculation:

```text
target_frames = video_length_seconds * fps
interval_seconds = duration_seconds / target_frames
```

Example:

```text
duration = 7200 seconds
video_length = 60 seconds
fps = 24
target_frames = 1440
interval = 5 seconds
```

If the computed interval is too small for the selected backend, the tool should warn and either ask for confirmation or clamp to a backend-specific minimum.

## Backend Strategy

The product should be backend-agnostic. Playwright is a strong MVP backend, but the skill should not be described as Playwright-only.

Initial backend:

- `playwright-url`: launches a browser, opens a URL, captures page screenshots.
  For this backend, enforce a 1000ms minimum capture interval because page navigation,
  script execution, and screenshot encoding are not reliably schedulable below 1 second
  across typical local and CI environments.

Future backends:

- `cdp-browser`: attaches to an existing Chromium session.
- `desktop-region`: captures a window or screen region using OS tools.
- `ffmpeg-screen`: uses `ffmpeg` directly for region or screen capture where appropriate.
- `command-frame`: runs a command that emits a PNG per capture tick.

Backend interface:

```text
initialize(config) -> session
capture(session, frameIndex) -> frameResult
shutdown(session) -> summary
```

## Rendering Requirements

Rendering should use `ffmpeg` where available.

Minimum render behavior:

- Use numbered frame files as input.
- Support FPS configuration.
- Output H.264 MP4 by default.
- Use broadly compatible pixel format, such as `yuv420p`.
- Write render logs.
- Verify output file exists and is non-empty.

Example render command shape:

```bash
ffmpeg \
  -framerate 24 \
  -i frames/frame-%04d.png \
  -c:v libx264 \
  -pix_fmt yuv420p \
  output.mp4
```

The implementation must account for missing frames. Options include:

- Write only successful frames into a render staging directory with contiguous numbering.
- Generate a concat input file from the manifest.
- Duplicate the previous good frame when a capture fails, if configured.

MVP recommendation:

- Stage successful frames into contiguous render order before invoking `ffmpeg`.

## User Experience

The agent should minimize questions. If required inputs are missing, ask for only:

- Target: URL, browser tab, desktop region, or command.
- Duration.
- Interval or final video length.
- Viewport or resolution.
- Output folder, if the default is not acceptable.

Reasonable defaults:

- Backend: `playwright-url` when a URL is provided.
- FPS: 24.
- Viewport: 1440x900 for desktop web.
- Cleanup: after successful render.
- Output folder: `./timelapse-runs/<slug>-<timestamp>`.
- Video filename: `output.mp4`.

## Success Metrics

- A user can start a 2-hour capture with one command or one agent request.
- The agent can report status during the run without disrupting capture.
- The agent can inspect the latest screenshot during the run.
- A successful render produces a playable MP4.
- Raw frames are removed after successful render by default.
- Failed captures do not stop the entire run.
- Run artifacts are understandable after frame cleanup.

## Risks And Mitigations

### Disk Growth

Risk: Multi-hour captures can create large frame directories.

Mitigations:

- Show estimated disk use before start.
- Track disk usage in status.
- Cleanup frames after render by default.
- Offer lower resolution or longer interval recommendations.

### Agent Context Overload

Risk: Agent attempts to inspect too many screenshots.

Mitigations:

- Provide `peek` for single-frame access.
- Provide contact sheet in future versions.
- Keep manifest machine-readable.
- Avoid loading frame directories wholesale.

### Failed Or Blank Captures

Risk: App crashes, browser disconnects, or screenshots are blank.

Mitigations:

- Continue after individual frame failures.
- Record errors in manifest.
- Add blank-frame detection in future scope.
- Surface stale latest-frame timestamps in status.

### Premature Cleanup

Risk: Raw frames are deleted before a valid video exists.

Mitigations:

- Delete frames only after render verification.
- Never cleanup on render failure.
- Require `--force` for cleanup before render.
- Preserve manifest, logs, summary, poster, and samples.

## Open Questions

- Should the default post-render cleanup keep a small sample set, or only `poster.png`?
- Should the skill provide a wrapper command named `timelapse-capture`, or just scripts with documented usage?
- Should desktop capture be part of MVP or first follow-up?
- What is the minimum supported environment for `ffmpeg` and browser dependencies?
- Should the capture process expose a local dashboard, or are files and CLI status enough?

## MVP Acceptance Criteria

- Given a URL, duration, interval, viewport, FPS, and output path, the skill can start a background capture job.
- While running, `status` reports progress and `peek --latest` returns the latest completed screenshot.
- The capture process writes `manifest.jsonl`, `status.json`, `latest-frame.json`, and frame PNGs.
- `render` produces a playable MP4.
- After successful render, raw frames are removed by default.
- Frame cleanup preserves final video, manifest, logs, summary, poster, and configured samples.
- Failed screenshot attempts are logged and do not stop the run unless a fatal backend error occurs.
