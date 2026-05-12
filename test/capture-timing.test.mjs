import { test } from "node:test";
import assert from "node:assert/strict";

import { __test__ } from "../src/timelapse-capture.mjs";

test("computeWaitSchedule returns no chunks when target time has passed", () => {
  const now = () => 1_000;
  const schedule = __test__.computeWaitSchedule(900, { now, maxWaitMs: 250 });
  assert.deepEqual(schedule, []);
});

test("waitUntilFrameTime uses one wait for short delays", async () => {
  const events = [];
  let now = 1_000;
  const nowProvider = () => now;
  const wait = async (ms) => {
    events.push(ms);
    now += ms;
  };

  await __test__.waitUntilFrameTime(1_050, {
    now: nowProvider,
    wait,
    maxWaitMs: 200,
  });
  assert.deepEqual(events, [50]);
});

test("waitUntilFrameTime splits long delays into bounded chunks", async () => {
  const events = [];
  let now = 10_000;
  const nowProvider = () => now;
  const wait = async (ms) => {
    events.push(ms);
    now += ms;
  };

  await __test__.waitUntilFrameTime(11_001, {
    now: nowProvider,
    wait,
    maxWaitMs: 250,
  });
  assert.deepEqual(events, [250, 250, 250, 250, 1]);
  assert.equal(
    events.reduce((sum, item) => sum + item, 0),
    1_001,
  );
});

test("computeWaitSchedule clamps non-positive maxWaitMs to 1ms", () => {
  const now = () => 1_000;
  const schedule = __test__.computeWaitSchedule(1_003, {
    now,
    maxWaitMs: -500,
  });
  assert.equal(schedule.length, 3);
  assert.equal(
    schedule.every((value) => value === 1),
    true,
  );
  assert.equal(
    schedule.reduce((sum, value) => sum + value, 0),
    3,
  );
});

test("computeWaitSchedule returns no chunks when target equals now", () => {
  const now = () => 1_000;
  const schedule = __test__.computeWaitSchedule(1_000, { now, maxWaitMs: 250 });
  assert.deepEqual(schedule, []);
});

test("computeWaitSchedule produces equal-sized chunks when delay is exact multiple of maxWaitMs", () => {
  const now = () => 1_000;
  const schedule = __test__.computeWaitSchedule(1_500, { now, maxWaitMs: 250 });
  assert.deepEqual(schedule, [250, 250]);
});
