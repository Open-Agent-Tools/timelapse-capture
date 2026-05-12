# Dogfood Protocol & Feedback Capture

This document gives a tester a complete protocol for exercising
`timelapse-capture` end-to-end and recording structured feedback. The aim is to
surface install friction, unclear commands, artifacts that are hard to find,
and whether the rendered video is actually useful for review.

The protocol assumes a fresh checkout. A tester should not have to read
`README.md`, `docs/PRD.md`, or `skill/SKILL.md` before starting; they should
follow the steps below and only consult those files when stuck.

## Tester Install Steps

These are the steps a brand-new tester runs before any scenario. Treat each
step as a checkpoint — if it fails, capture the failure in the feedback
template at the end of this document.

1. Confirm system prerequisites:
   - Node.js 20 or newer (`node --version`).
   - `npm` available on `PATH` (`npm --version`).
   - `ffmpeg` and `ffprobe` available on `PATH`
     (`ffmpeg -version`, `ffprobe -version`). On macOS install with
     `brew install ffmpeg`; on Debian or Ubuntu use
     `sudo apt-get install ffmpeg`.

   **Expected:** Each command prints a version string and exits 0. No "command
   not found" errors.

2. Clone the repository and install dependencies from the repository root:

   ```bash
   git clone <repo-url> timelapse-capture
   cd timelapse-capture
   npm install
   ```

   **Expected:** `npm install` completes without errors. A `node_modules/`
   directory is created.

3. Install the Playwright Chromium browser:

   ```bash
   npx playwright install chromium
   ```

   **Expected:** Playwright downloads and installs the Chromium browser without
   errors.

4. Make the CLI runnable. Pick one of the two forms and use it consistently
   for every scenario:

   ```bash
   # Option A: link the binary once
   npm link
   timelapse-capture doctor

   # Option B: run through npm without linking
   npm start -- doctor
   ```

   **Expected:** The command runs without "command not found" and prints
   `doctor` output.

5. Run `doctor` and confirm every check reports `[PASS]`:

   ```bash
   timelapse-capture doctor
   ```

   **Expected:** Output ends with `summary: 5 passed, 0 failed, 5 total`.
   If anything fails, follow the printed `fix:` line and re-run `doctor` until
   it is clean. Do not start a scenario while `doctor` is failing.

6. Start a local web server you can target. Any small static or app server
   that responds at `http://localhost:3000` works. A minimal option:

   ```bash
   npx http-server -p 3000
   ```

   **Expected:** The server prints a listening message such as
   `Available on: http://127.0.0.1:3000` and accepts connections.
   Leave it running in a separate terminal.

## Scenario 1: Default Capture, Peek, Render, Cleanup

Goal: confirm the happy path works and that default cleanup leaves the run
directory understandable without raw frames.

1. Start a short capture against the local server:

   ```bash
   timelapse-capture start http://localhost:3000 \
     --duration 15s \
     --interval 1s \
     --viewport 1440x900
   ```

   **Expected:** The command prints a `run-dir` value such as
   `timelapse-runs/localhost-3000-<timestamp>`. Record this path as `RUN_DIR`.

2. Within the first 5 seconds of the run, peek at the latest frame:

   ```bash
   timelapse-capture peek "$RUN_DIR" --latest
   ```

   **Expected:** A file path to a `.png` is printed. Opening that path shows a
   real screenshot of the target URL — not blank or all white. Record the
   wall-clock time you peeked.

3. Wait for the capture to finish. Poll status until state is `completed`:

   ```bash
   timelapse-capture status "$RUN_DIR"
   ```

   **Expected:** `state` field reads `completed`. The output also shows a
   non-zero captured frame count, an elapsed time, and a disk-usage figure.

4. Render the MP4:

   ```bash
   timelapse-capture render "$RUN_DIR"
   ```

   **Expected:** `output.mp4` is created inside `$RUN_DIR` and the command
   exits 0.

5. Open the rendered video and confirm it plays:

   ```bash
   open "$RUN_DIR/output.mp4"   # macOS
   # On Linux, use the desktop file opener or a video player.
   ```

   **Expected:** The video plays without errors and shows visible motion or
   page changes that match what was visible at peek time.

6. Inspect the run directory after the default render cleanup:

   ```bash
   ls "$RUN_DIR"
   ```

   **Expected:**
   - `output.mp4` is present and non-empty.
   - `manifest.jsonl` (or `manifest.json`) is present.
   - `status.json` is present and reports a terminal state.
   - `run-summary.json` is present and records the cleanup action.
   - `poster.png` is present if the run produced at least one frame.
   - `frames/` is removed or empty.

   If any of those are missing, record the gap in the feedback template.

## Scenario 2: Keep Frames Through Render

Goal: confirm `--keep-frames` retention preserves raw frames after render and
that `peek` still works on the kept frames.

1. Start a fresh capture; `--duration` short enough to finish quickly:

   ```bash
   timelapse-capture start http://localhost:3000 \
     --duration 15s \
     --interval 1s \
     --viewport 1440x900
   ```

   **Expected:** A new `run-dir` is printed. Record it as `RUN_DIR`.

2. Wait for `status` to report a terminal capture state:

   ```bash
   timelapse-capture status "$RUN_DIR"
   ```

   **Expected:** `state` reads `completed` (or another terminal state). Frame
   count is non-zero.

3. Render and explicitly keep frames:

   ```bash
   timelapse-capture render "$RUN_DIR" --keep-frames
   ```

   **Expected:** `output.mp4` is created inside `$RUN_DIR`. The `frames/`
   directory is not removed — raw PNGs are still present alongside the video.

4. Confirm raw frames remain:

   ```bash
   ls "$RUN_DIR/frames" | head
   ```

   **Expected:** At least one `frame-*.png` file is listed. The directory is
   not empty.

5. Peek at a specific index and at the latest frame to confirm both still
   resolve to a real file path:

   ```bash
   timelapse-capture peek "$RUN_DIR" --index 0
   timelapse-capture peek "$RUN_DIR" --latest
   ```

   **Expected:** Both commands print a `.png` file path. Opening each path
   shows a valid screenshot — not a missing-file error.

6. Inspect `run-summary.json` and confirm it records that frames were
   intentionally retained:

   ```bash
   cat "$RUN_DIR/run-summary.json"
   ```

   **Expected:** The JSON contains a field indicating frames were preserved
   (e.g. `"reason": "keep-frames"` or `"cleanup": "never"`). The retention
   should be explicit, not silently kept.

## Scenario 3: Bad URL Or Stopped Server

Goal: confirm failure modes are understandable from `status` and the
manifest, and that the failure does not leave the tool in a confusing state.

Pick one of the two failure modes:

- A: Use a URL that cannot resolve, e.g. `http://localhost:9` (closed port)
  or `http://does-not-exist.invalid`.
- B: Start a capture against the local server, then stop the server while
  the capture is still running.

Run:

1. Start the capture against the chosen failing target:

   ```bash
   timelapse-capture start http://localhost:9 \
     --duration 15s \
     --interval 1s \
     --viewport 1440x900
   ```

   **Expected:** The command starts and prints a `run-dir`. Errors or warnings
   may appear immediately (failed frame attempts), but the tool should not
   crash outright.

   Record `RUN_DIR`.

2. While the run progresses, watch `status`:

   ```bash
   timelapse-capture status "$RUN_DIR"
   ```

   **Expected:**
   - `state` eventually reaches `failed`, `completed`, or another terminal
     state without hanging indefinitely.
   - `failedCount` is non-zero, or the run reports a fatal startup error.
   - The error message names the URL or backend problem; it should not be
     a bare stack trace.

3. Inspect the manifest:

   ```bash
   head "$RUN_DIR/manifest.jsonl" 2>/dev/null \
     || cat "$RUN_DIR/manifest.json"
   ```

   **Expected:** At least one record has a non-null `error` field. The error
   string should make the cause obvious to a tester who did not write the code
   (e.g. "net::ERR_CONNECTION_REFUSED" or a human-readable equivalent).

4. Try to render. The behavior depends on whether any frame was captured:

   ```bash
   timelapse-capture render "$RUN_DIR"
   ```

   **Expected:**
   - If frames exist: render succeeds and produces `output.mp4`.
   - If no frames exist: render exits with a message that names the problem
     (no frames, manifest empty, etc.) and does not delete any existing
     artifacts.

5. Confirm the run directory is safe to keep for diagnosis:

   ```bash
   ls "$RUN_DIR"
   ```

   **Expected:** `manifest.jsonl` (or `manifest.json`), `status.json`, and
   any captured frames or logs are still present. Nothing was silently wiped
   by a failed render.

## Tester Feedback Template

Copy this template into a plain text file or issue comment after running the
scenarios. Be specific. Quote exact commands and exact output.

```text
Tester:
Date:
OS / shell:
Node version:
ffmpeg version:
Install option used: A (npm link) | B (npm start --)

# Install Friction
- What worked smoothly?
- What was confusing or required guessing?
- Did doctor report any failures? If so, paste the output and the fix you
  applied.
- Time from clone to a clean doctor run: ____ minutes.

# Command Clarity
- For each command you ran (doctor, start, status, peek, render, cleanup),
  was the help text and arguments obvious?
- Were there flags you expected but did not find?
- Were there flags you tried that were silently ignored?
- Did any command print output you did not understand?

# Artifact Discoverability
- Was the run directory printed clearly enough to find again later?
- After default cleanup, could you tell from the remaining files what
  happened during the run?
- Were `output.mp4`, `status.json`, `manifest`, and the run summary easy to
  locate without listing the directory?
- Did `--keep-frames` produce a directory layout you could explain to
  someone else?

# Video Usefulness
- Did the rendered MP4 actually let you review what happened over time?
- Was the playback length reasonable for the duration captured?
- Did the video reveal anything you missed in a single peek?
- Would you use this tool again for a real long-running review? Why or
  why not?

# Failure Mode Behavior (Scenario 3)
- Which failure mode did you trigger (bad URL or stopped server)?
- Did status, manifest, and any error message let you diagnose the
  failure without reading the source?
- Did the tool leave the run directory in a recoverable state?

# Open Questions / Surprises
- List anything that surprised you, even if it eventually worked.

# Top 3 Improvements
1.
2.
3.
```

## Reporting Feedback

File completed feedback as a comment on the dogfood tracking issue, or open a
new issue per concrete bug or rough edge. Link the run directory you used so
the maintainers can reproduce. Do not paste raw frame images — link or
attach the rendered MP4 instead.
