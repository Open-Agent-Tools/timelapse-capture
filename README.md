# timelapse-capture

A CLI tool for capturing timelapse screenshots of web pages.

## Commands

```
timelapse-capture <command> [options] [args]

Commands:
  start <url>           Start capture in run directory
  status <run-dir>      Print capture status
  render <run-dir>      Render an mp4 from captured frames
  peek <run-dir>        Inspect captured frames
  cleanup <run-dir>     Cleanup artifacts
  doctor                Check runtime dependencies
```

## Render

The `render` command runs ffmpeg to produce an MP4 from captured frames. The output is validated with ffprobe before frames are deleted. If render fails or the output is not a valid MP4, frames are preserved.

```
timelapse-capture render <run-dir>
```

## Cleanup

The `cleanup` command removes frame artifacts. Default behavior deletes all frames after a successful render. Use flags to retain specific frames:

| Flag | Behavior |
|------|----------|
| `--keep-frames` | Preserve all frames |
| `--keep-samples` | Keep first and last frame only |
| `--keep-latest` | Keep only the most recent frame |

```
timelapse-capture cleanup <run-dir> [--keep-frames | --keep-samples | --keep-latest]
```

## Peek

The `peek` command returns the path of a captured frame. By default it returns the latest frame. Use `--index N` to select a specific frame or `--near N` to select the frame nearest to index N.

```
timelapse-capture peek <run-dir> [--latest] [--index N]
```

After cleanup with `--keep-latest`, `peek` returns the single retained frame. After full cleanup (default), `peek` throws an error because no frames remain.

## Testing

The test suite uses fake ffmpeg binaries for deterministic render/cleanup coverage. Tests that require real ffmpeg and ffprobe binaries are automatically skipped when those binaries are not available on PATH — they do not fail.

```
npm test                          # full suite
npm test -- test/render-cleanup.test.js  # render/cleanup suite only
```

Real-ffmpeg tests are labeled `render with real ffmpeg` in output. When skipped, a single passing test `real ffmpeg tests skipped (ffmpeg/ffprobe not found)` appears instead.
