# 001: Canonical CLI Entrypoint

## Status

Accepted

## Decision

`src/timelapse-capture.mjs` is the canonical and only `timelapse-capture` CLI implementation.

The former CommonJS scaffold under `src/cli/` was removed by issue #25 after its useful behavior was ported into the canonical entrypoint:

- `src/cli/index.js`
- `src/cli/parser.js`
- `src/cli/render.js`

`package.json#bin.timelapse-capture` and `npm start` invoke `src/timelapse-capture.mjs`.

## Comparison

| Area | `src/timelapse-capture.mjs` | `src/cli/index.js` + `src/cli/parser.js` + `src/cli/render.js` |
| --- | --- | --- |
| Feature completeness | Implements the real Playwright URL capture flow, detached background capture process, JSONL manifest writes, atomic JSON writes, latest-frame samples, render, peek, cleanup, doctor, and argv-form ffmpeg execution. | Removed. It implemented command-shaped flows, but capture wrote simulated 1x1 PNG frames instead of driving Playwright. |
| Test coverage | Canonical-entrypoint tests cover parsing, smoke flows, render behavior, cleanup, status formatting, doctor behavior, package wiring, and status vocabulary. | Removed after behavior coverage moved to canonical tests. |
| Status state vocabulary | Uses the durable run-state vocabulary `starting`, `running`, `completed`, `failed`, `rendering`, `rendered`, and `render_failed`. | Removed. It used a divergent completion state that is now read-compatible only through canonical migration. |
| Code clarity | A single ESM file contains the full real workflow, making dogfood behavior easy to trace but large enough to deserve later extraction once behavior is stable. | Removed. |
| ESM vs CJS | Native ESM via `.mjs`; no package-wide module-type change is required. | Removed CommonJS `.js` modules. |
| Dogfood readiness | Best target because it performs real browser capture and can be used by agents against live app review runs. | Removed because it was not dogfood-ready as the published binary. |

## Rationale

The project needs the published `timelapse-capture` command to exercise the implementation that captures real browser state. `src/timelapse-capture.mjs` is the only entrypoint that launches Playwright, maintains a durable background capture process, records JSONL frame manifests, writes run metadata atomically, and invokes ffmpeg with argument arrays rather than shell-assembled command strings.

The removed `src/cli/*` implementation was valuable as a porting reference. Its parser ergonomics, focused tests, status presentation, and `doctor` command have been moved into `src/timelapse-capture.mjs` so the canonical path has the scaffold's useful behavior without preserving two parallel CLIs.

## Ported Targets From The Removed Entrypoint

Issue #25 completed the removal after porting or replacing these behaviors in `src/timelapse-capture.mjs`:

- Structured `ParseError` class with deterministic error codes.
- `--no-<flag>` boolean negation for command flags.
- `doctor` command for runtime dependency checks.
- `stale-frame` warning in `status` output.
- ETA and elapsed timing fields in `status` output.
- Separate `runDirBytes` and `framesBytes` disk usage reporting.
- Canonical-entrypoint tests that prove real command behavior after scaffold tests were retired.
- Consistent frame-name padding; choose the final frame-name padding width and enforce it everywhere.

## Consequences

Follow-up issues should treat `src/timelapse-capture.mjs` as the target for all CLI behavior.
