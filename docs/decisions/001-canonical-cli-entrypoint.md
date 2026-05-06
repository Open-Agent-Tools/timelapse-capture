# ADR 001: Canonical CLI Entrypoint

## Status

Accepted

## Context

The repository currently has two CLI implementations for the same user-facing
`timelapse-capture` command family:

- `src/timelapse-capture.mjs`
- `src/cli/index.js`, `src/cli/parser.js`, and `src/cli/render.js`

Both paths cover `start`, `status`, `render`, `peek`, and `cleanup`, but they
do not implement the same behavior. Keeping both as peer entrypoints makes
published behavior ambiguous and creates duplicate maintenance work.

## Decision

`src/timelapse-capture.mjs` is the canonical CLI entrypoint.

`src/cli/index.js`, `src/cli/parser.js`, and `src/cli/render.js` are demoted to
port-target scaffolding. They should not be treated as the published CLI target,
but they should remain available until their useful behavior and test coverage
have been ported to the canonical entrypoint.

## Comparison

| Criterion | `src/timelapse-capture.mjs` | `src/cli/index.js` + `src/cli/parser.js` + `src/cli/render.js` |
| --- | --- | --- |
| Feature completeness | Implements the real Playwright capture flow, background capture process, JSONL manifest writes, latest-frame tracking, render staging, cleanup, and argv-form ffmpeg execution. | Implements a broader test-shaped command surface, but capture behavior is simulated with hardcoded 1x1 PNG output. |
| Test coverage | Has limited direct coverage today and needs a canonical-entrypoint test suite before deleting the demoted CLI. | Has substantially more parser, smoke, render, status, and cleanup coverage. |
| Status state vocabulary | Uses the canonical status vocabulary for active and render lifecycle states, including `starting`, `running`, `completed`, `failed`, `rendering`, `rendered`, and `render_failed`. | Uses divergent labels such as `done`, which increases migration and compatibility risk. |
| Code clarity | Keeps the real capture lifecycle in one ESM implementation with durable file writes and direct operational behavior. | Splits parser and render helpers cleanly, but mixes production-shaped commands with scaffolded capture behavior. |
| ESM vs CJS | Matches the package's `"type": "module"` setting and published ESM direction. | Uses CommonJS modules inside an ESM package, which complicates package semantics and test execution. |
| Dogfood readiness | Ready to dogfood because it drives real Playwright captures and ffmpeg rendering. | Not dogfood-ready as the main binary because capture does not observe the target app. |

## Rationale

The published binary should run the implementation that captures real browser
state. `src/timelapse-capture.mjs` is the only entrypoint that performs real
Playwright capture, writes frame metadata to a JSONL manifest, updates
`latest-frame.json` after completed frame writes, uses atomic frame writes, and
executes ffmpeg with argument arrays rather than shell-assembled commands.

The demoted `src/cli/*` implementation still contains useful CLI ergonomics,
parser behavior, status formatting, and tests. Those pieces should be treated as
port targets rather than a reason to keep publishing the scaffold.

## Port Targets

Before removing `src/cli/index.js`, `src/cli/parser.js`, and
`src/cli/render.js`, port or resolve these capabilities in
`src/timelapse-capture.mjs`:

- Structured `ParseError` codes such as `E_BAD_DURATION`, `E_UNKNOWN_FLAG`, and
  related parse-time validation failures.
- `--no-<flag>` boolean negation for command flags.
- The `doctor` command.
- `stale-frame` warning support in `status`.
- ETA and elapsed time in `status` output.
- Separate disk usage fields for `runDirBytes` and `framesBytes`.
- A test suite that covers the canonical entrypoint.
- Consistent frame-name padding; choose and document either the existing
  6-digit canonical form or the demoted CLI's 4-digit form.

These port targets are follow-up work. They do not change the canonical
entrypoint decision.
