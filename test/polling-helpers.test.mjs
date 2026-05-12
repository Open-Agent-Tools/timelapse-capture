import { test } from "node:test";
import assert from "node:assert/strict";

import { pollUntil } from "./helpers/polling.mjs";

test("pollUntil retries when operation throws transient errors", async () => {
  let attempts = 0;
  const value = await pollUntil(
    async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("ENOENT: status not written yet");
      }
      return { state: "completed" };
    },
    (result) => result.state === "completed",
    {
      timeoutMs: 200,
      intervalMs: 1,
      onError: () => true,
      describeLastValue: (result) => JSON.stringify(result),
      timeoutMessage: "Timed out waiting for completion",
    },
  );

  assert.equal(value.state, "completed");
  assert.equal(attempts, 3);
});

test("pollUntil fails with timeout message and last value details", async () => {
  await assert.rejects(
    pollUntil(
      async () => ({ state: "running" }),
      (result) => result.state === "completed",
      {
        timeoutMs: 30,
        intervalMs: 1,
        describeLastValue: (result) => JSON.stringify(result),
        timeoutMessage: "Timed out waiting for completion",
      },
    ),
    /Timed out waiting for completion\. Last value: \{"state":"running"\}/,
  );
});
