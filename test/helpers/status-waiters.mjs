import fs from "node:fs/promises";
import path from "node:path";

import { pollUntil, isTransientReadError } from "./polling.mjs";

export async function readStatus(runDir) {
  return JSON.parse(
    await fs.readFile(path.join(runDir, "status.json"), "utf8"),
  );
}

export async function readJob(runDir) {
  return JSON.parse(await fs.readFile(path.join(runDir, "job.json"), "utf8"));
}

export async function readStatusAndJob(runDir) {
  const [status, job] = await Promise.all([
    readStatus(runDir),
    readJob(runDir),
  ]);
  return { status, job };
}

export async function waitForCompletedStatus(
  runDir,
  { timeoutMs = 5000 } = {},
) {
  return pollUntil(
    () => readStatusAndJob(runDir),
    ({ status, job }) =>
      status.state === "completed" && job.state === "completed",
    {
      timeoutMs,
      intervalMs: 25,
      onError: isTransientReadError,
      timeoutMessage: "Timed out waiting for completed status",
      describeLastValue: ({ status }) => JSON.stringify(status),
    },
  ).then(({ status }) => status);
}

export async function waitForFailedStatus(runDir, { timeoutMs = 5000 } = {}) {
  return pollUntil(
    () => readStatus(runDir),
    (status) => status.state === "failed",
    {
      timeoutMs,
      intervalMs: 50,
      onError: isTransientReadError,
      timeoutMessage: "Timed out waiting for failed status",
      describeLastValue: (status) => JSON.stringify(status),
    },
  );
}

export async function waitForTerminalStatus(
  runDir,
  { expectedAttempts, timeoutMs = 5000 } = {},
) {
  return pollUntil(
    () => readStatusAndJob(runDir),
    ({ status, job }) => {
      const attempts =
        status.frames?.attempted ??
        (status.frames?.captured ?? 0) +
          (status.frames?.failed ?? 0) +
          (status.frames?.skipped ?? 0);
      const TERMINAL = new Set([
        "completed",
        "failed",
        "rendered",
        "render_failed",
      ]);
      return (
        TERMINAL.has(status.state) &&
        (job.state === "completed" || job.state === "failed") &&
        (expectedAttempts === undefined || attempts >= expectedAttempts)
      );
    },
    {
      timeoutMs,
      intervalMs: 25,
      onError: isTransientReadError,
      timeoutMessage:
        expectedAttempts === undefined
          ? "Timed out waiting for terminal status"
          : `Timed out waiting for ${expectedAttempts} simulated attempts in ${runDir}`,
      describeLastValue: ({ status, job }) =>
        expectedAttempts === undefined
          ? JSON.stringify(status)
          : JSON.stringify({ status, job }),
    },
  ).then(({ status }) => status);
}
