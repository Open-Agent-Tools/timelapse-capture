import { mock, test } from "node:test";
import assert from "node:assert/strict";

import { __test__ } from "../src/timelapse-capture.mjs";

test("sleepUntilFrameTime returns immediately when target is in the past", async () => {
  const now = () => 1_000;
  let waitCalls = 0;

  await __test__.waitUntilFrameTime(900, {
    now,
    wait: () => {
      waitCalls += 1;
    },
    maxWaitMs: 200
  });

  assert.equal(waitCalls, 0);
});

test("sleepUntilFrameTime can be driven with mock timers without real sleep", async () => {
  const now = () => 1_000;
  let done = false;
  mock.timers.enable({ apis: ["setTimeout"] });

  const wait = __test__.waitUntilFrameTime(1_050, {
    now,
    maxWaitMs: 200
  }).then(() => {
    done = true;
  });

  await Promise.resolve();
  assert.equal(done, false);
  mock.timers.tick(200);
  await Promise.resolve();
  assert.equal(done, false);
  mock.timers.tick(200);
  await Promise.resolve();
  assert.equal(done, false);
  mock.timers.tick(50);
  await wait;
  assert.equal(done, true);
  mock.timers.reset();
});

test("sleepUntilFrameTime supports abort signals", async () => {
  const now = () => 1_000;
  const controller = new AbortController();
  const promise = __test__.waitUntilFrameTime(1_900, {
    now,
    maxWaitMs: 250,
    signal: controller.signal
  });
  controller.abort();
  await assert.rejects(() => promise, /AbortError|This operation was aborted/i);
});
