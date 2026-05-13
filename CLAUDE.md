# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:7510c1e2 -->

## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**

- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->

## Beads Local Setup

`.beads/` is gitignored, so fresh clones do not include the local Dolt DB, hooks (`post-checkout`, `post-merge`, `pre-commit`, `pre-push`, `prepare-commit-msg`), or `config.yaml` / `metadata.json`. After cloning, run `bd init` once to bootstrap a local `.beads/` directory and install its git hooks. Issue history is synced separately via `refs/dolt/data` on the git remote.

## Build & Test

```bash
npm install                 # Install dependencies (requires Node.js 20+)
npm run check               # Syntax-check src/timelapse-capture.mjs and src/doctor.mjs
npm run typecheck           # TypeScript type-check (tsc --noEmit)
npm test                    # Run the full Node test suite (test/**/*.test.{js,mjs})
npm run check:local         # Local integration check; skips ffmpeg/ffprobe checks if absent
npm run ci                  # check + format:check + typecheck + test (what CI runs)
```

## Architecture Overview

- `src/timelapse-capture.mjs` — canonical CLI entry point; all commands (`start`, `capture`, `status`, `peek`, `render`, `cleanup`, `doctor`) are handled here (`capture` is the internal child entrypoint that `start` dispatches)
- `src/doctor.mjs` — dependency doctor that checks Node.js, Playwright/Chromium, ffmpeg, and ffprobe versions before any capture work
- `test/` — Node built-in test runner (`node --test`); unit and integration tests live here
- `docs/` — user-facing documentation including the dogfood protocol
- `skill/SKILL.md` — agent-facing skill guide describing the capture workflow and frame inspection discipline

## Conventions & Patterns

- Use `bd` for ALL task tracking — no TodoWrite, no markdown TODO files
- Run `bd prime` at session start for the full workflow context and session-close protocol
- Use `bd remember "insight"` for persistent knowledge across sessions — not MEMORY.md files
- Always use non-interactive flags for shell file operations (`cp -f`, `mv -f`, `rm -f`) to avoid agent hangs
- Write run artifacts (manifest, frames) through the existing helpers in the CLI; do not write them ad-hoc
- When inspecting captured frames, use `peek` to get a single image path — do not load the full `frames/` directory
