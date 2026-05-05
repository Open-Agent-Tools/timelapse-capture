# ADR-001: Canonical CLI Entrypoint

**Status:** Accepted  
**Date:** 2026-05-05  
**Issue:** #23

## Decision

**Canonical entrypoint: `src/timelapse-capture.mjs`**  
**Demoted scaffold: `src/cli/index.js` + `src/cli/parser.js` + `src/cli/render.js`**

`package.json#bin` must be updated to point at `src/timelapse-capture.mjs`.

## Context

Two parallel CLI implementations exist in the repository:

| Dimension | `src/timelapse-capture.mjs` | `src/cli/` (index + parser + render) |
|---|---|---|
| Module format | ESM | CJS |
| Lines of code | ~748 | ~1150 |
| Real Playwright capture | Yes | No (writes hardcoded 1×1 PNG) |
| Real ffmpeg render | Yes (spawnSync array form) | Yes (execSync string form) |
| Background daemon | Yes (spawn + unref) | No (synchronous, foreground) |
| Frame manifest format | JSONL (`manifest.jsonl`) | JSON object (`manifest.json`) |
| Atomic writes | Yes (temp-file rename) | No (direct writeFile) |
| Status state vocab | `starting/running/completed/failed/rendering/rendered/render_failed` | `starting/running/done/failed` |
| `package.json#bin` | No (not wired up) | **Yes (current bin)** |
| Test coverage | None | Extensive (4 test files) |
| `doctor` command | No | Yes |

## Rationale

`src/timelapse-capture.mjs` is the real implementation. It captures actual screenshots
via Playwright, daemonizes properly for long-running sessions, uses atomic writes to
avoid partial reads, and has a richer status vocabulary that tracks render phases.

`src/cli/` is a test scaffold that evolved into a CLI shape. Its `commandStart` writes
a hardcoded 1×1 PNG instead of launching a browser. The `TIMELAPSE_SIMULATE_*` env
vars confirm it was designed for testing, not production. It is structurally sound and
has excellent test coverage, but it is not dogfood-ready.

ESM is the direction the Node.js ecosystem is moving, which further favors the `.mjs`
file.

## Port Targets (what the scaffold has that the canonical lacks)

These gaps in `src/timelapse-capture.mjs` must be addressed before the scaffold is
removed (tracked as sub-issues under #22):

1. **Structured parser with error codes** — `src/cli/parser.js` has a `ParseError`
   class with machine-readable codes (`E_BAD_DURATION`, `E_UNKNOWN_FLAG`, etc.) and
   validates `--no-<flag>` negation per-command. The `.mjs` parser is a simple
   loop with no error codes.

2. **`doctor` command** — A dependency health-check is missing from `.mjs`.

3. **Stale-frame warning** — The scaffold's `status` command warns when the latest
   frame is older than one capture interval. The `.mjs` `status` command does not.

4. **ETA and elapsed display** — Human-readable `eta` and `elapsed` fields in status
   output are only in the scaffold.

5. **Disk-usage breakdown** — The scaffold reports `runDirBytes` + `framesBytes`
   separately; `.mjs` only reports frame directory size.

6. **Test suite** — All four test files (`parser.test.js`, `smoke.test.js`,
   `render.test.js`, `render-cleanup.test.js`) target the scaffold. These must be
   ported to exercise `timelapse-capture.mjs` directly, or the parser/render modules
   must be extracted as shared modules that both entrypoints can use.

7. **`--no-<flag>` negation** — The scaffold parser supports `--no-keep-frames` etc.;
   the `.mjs` parser does not.

8. **6-digit vs 4-digit frame names** — `.mjs` uses `frame-000001.png` (6-digit
   padding); the scaffold uses `frame-0001.png` (4-digit). Pick one convention.

## Consequences

- Update `package.json#bin` to `src/timelapse-capture.mjs`.
- Add `"type": "module"` to `package.json` **or** rename the file to allow ESM
  without the `.mjs` extension (the former is preferred since all new code should
  be ESM).
- Port or adapt the test suite so tests cover the canonical entrypoint.
- Delete `src/cli/` once port targets are addressed.
