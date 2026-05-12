# 001: Canonical CLI Entrypoint

## Status

Accepted

## Decision

`src/timelapse-capture.mjs` is the canonical `timelapse-capture` CLI entrypoint.

The CommonJS scaffold under `src/cli/` is demoted:

- `src/cli/index.js`
- `src/cli/parser.js`
- `src/cli/render.js`

`package.json#bin.timelapse-capture` and `npm start` should invoke `src/timelapse-capture.mjs`. Follow-up work should port the useful scaffold behavior into the canonical entrypoint before deleting `src/cli/*`.

## Comparison

| Area                    | `src/timelapse-capture.mjs`                                                                                                                                                                                   | `src/cli/index.js` + `src/cli/parser.js` + `src/cli/render.js`                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Feature completeness    | Implements the real Playwright URL capture flow, detached background capture process, JSONL manifest writes, atomic JSON writes, latest-frame samples, render, peek, cleanup, and argv-form ffmpeg execution. | Implements command-shaped start, status, render, peek, cleanup, and doctor flows, but capture writes simulated 1x1 PNG frames instead of driving Playwright.      |
| Test coverage           | Has little direct test coverage today and needs focused canonical-entrypoint tests before scaffold removal.                                                                                                   | Has the stronger current test suite for parsing, smoke flows, render behavior, cleanup, status formatting, and doctor behavior.                                   |
| Status state vocabulary | Uses the durable run-state vocabulary `starting`, `running`, `completed`, `failed`, `rendering`, `rendered`, and `render_failed`.                                                                             | Uses and normalizes a divergent vocabulary including `starting`, `running`, `done`, and `failed`, with compatibility handling for `completed` and `idle`.         |
| Code clarity            | A single ESM file contains the full real workflow, making dogfood behavior easy to trace but large enough to deserve later extraction once behavior is stable.                                                | The scaffold is split by parser, doctor, render, and command orchestration, which is easier to unit test but currently obscures that capture itself is simulated. |
| ESM vs CJS              | Native ESM via `.mjs`; no package-wide module-type change is required.                                                                                                                                        | CommonJS `.js` modules; keeping them while the package has no `"type": "module"` preserves the existing scaffold tests during the port.                           |
| Dogfood readiness       | Best target because it performs real browser capture and can be used by agents against live app review runs.                                                                                                  | Useful as a behavior reference and regression-test source, but not dogfood-ready as the published binary because its capture path is a stub.                      |

## Rationale

The project needs the published `timelapse-capture` command to exercise the implementation that captures real browser state. `src/timelapse-capture.mjs` is the only entrypoint that launches Playwright, maintains a durable background capture process, records JSONL frame manifests, writes run metadata atomically, and invokes ffmpeg with argument arrays rather than shell-assembled command strings.

The demoted `src/cli/*` implementation is still valuable. It has better command parsing structure, more focused tests, richer status presentation, and the `doctor` command. Those capabilities should be ported deliberately into `src/timelapse-capture.mjs` so the canonical path gains the scaffold's ergonomics without preserving two parallel CLIs.

## Port Targets From The Demoted Entrypoint

Before `src/cli/*` can be removed, port or replace these behaviors in `src/timelapse-capture.mjs`:

- Structured `ParseError` class with deterministic error codes.
- `--no-<flag>` boolean negation for command flags.
- `doctor` command for runtime dependency checks.
- `stale-frame` warning in `status` output.
- ETA and elapsed timing fields in `status` output.
- Separate `runDirBytes` and `framesBytes` disk usage reporting.
- Canonical-entrypoint tests that prove real command behavior before scaffold tests are retired.
- Consistent frame-name padding; choose the final frame-name padding width and enforce it everywhere.

## Consequences

Follow-up issues should treat `src/timelapse-capture.mjs` as the target for new CLI behavior. The scaffold remains temporarily as a source of tested behavior to port, but new published-binary behavior should not be added only to `src/cli/*`.
