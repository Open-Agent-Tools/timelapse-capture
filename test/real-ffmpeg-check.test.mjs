import { test } from "node:test";
import assert from "node:assert/strict";

import { checkFfmpeg, checkFfprobe, commandDoctor } from "../src/doctor.mjs";
import { hasRealFFmpeg } from "./helpers/fake-ffmpeg.mjs";

const shouldRunRealFFmpegChecks =
  process.env.TIMELAPSE_HAS_REAL_FFMPEG_SUITE === "1" ? true : hasRealFFmpeg();

test(
  "real ffmpeg/ffprobe checks pass when binaries are available",
  { skip: !shouldRunRealFFmpegChecks },
  async () => {
    const result = await commandDoctor({ checks: [checkFfmpeg, checkFfprobe] });

    assert.equal(result.ok, true);
    assert.equal(result.summary.pass, 2);
    assert.equal(result.summary.fail, 0);
    assert.equal(result.checks[0].name, "ffmpeg");
    assert.equal(result.checks[0].status, "pass");
    assert.equal(result.checks[1].name, "ffprobe");
    assert.equal(result.checks[1].status, "pass");
  },
);
