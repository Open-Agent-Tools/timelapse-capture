# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **Run quality gates** (if code changed) - Tests, linters, builds
2. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   git push
   git status  # MUST show "up to date with origin"
   ```
3. **Clean up** - Clear stashes, prune remote branches
4. **Verify** - All changes committed AND pushed
5. **Hand off** - Provide context for next session

**CRITICAL RULES:**

- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds

## Build & Test

```bash
npm install                 # Install dependencies (requires Node.js 20+)
npm run check               # Syntax-check src/timelapse-capture.mjs and src/doctor.mjs
npm run typecheck           # TypeScript type-check (tsc --noEmit)
npm test                    # Run the full Node test suite (test/**/*.test.{js,mjs})
npm run check:local         # Local integration check; skips ffmpeg/ffprobe checks if absent
npm run ci                  # check + format:check + typecheck + test (local-only; no remote CI enforces this)
```

This project has no remote CI workflow; contributors must run `npm run ci` themselves before pushing or opening a PR.

## Architecture Overview

- `src/timelapse-capture.mjs` — canonical CLI entry point; all commands (`start`, `capture`, `status`, `peek`, `render`, `cleanup`, `doctor`) are handled here (`capture` is the internal child entrypoint that `start` dispatches)
- `src/doctor.mjs` — dependency doctor that checks Node.js, Playwright/Chromium, ffmpeg, and ffprobe versions before any capture work
- `test/` — Node built-in test runner (`node --test`); unit and integration tests live here
- `docs/` — user-facing documentation including the dogfood protocol
- `skill/SKILL.md` — agent-facing skill guide describing the capture workflow and frame inspection discipline

## Conventions & Patterns

- Always use non-interactive flags for shell file operations (`cp -f`, `mv -f`, `rm -f`) to avoid agent hangs
- Write run artifacts (manifest, frames) through the existing helpers in the CLI; do not write them ad-hoc
- When inspecting captured frames, use `peek` to get a single image path — do not load the full `frames/` directory
