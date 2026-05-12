import assert from "node:assert/strict";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function toError(error) {
  if (error instanceof Error) return error;
  return new Error(String(error));
}

export async function pollUntil(
  read,
  predicate,
  {
    timeoutMs = 5000,
    intervalMs = 25,
    onError = () => false,
    timeoutMessage = "Timed out waiting for condition",
    describeLastValue,
    describeLastError,
  } = {},
) {
  const started = Date.now();
  let lastValue;
  let lastError;

  while (Date.now() - started < timeoutMs) {
    try {
      const value = await read();
      lastValue = value;
      if (predicate(value)) {
        return value;
      }
    } catch (error) {
      const normalized = toError(error);
      lastError = normalized;
      if (!onError(normalized)) {
        throw normalized;
      }
    }
    await sleep(intervalMs);
  }

  const details = [];
  if (lastValue !== undefined) {
    details.push(
      `Last value: ${describeLastValue ? describeLastValue(lastValue) : JSON.stringify(lastValue)}`,
    );
  }
  if (lastError) {
    details.push(
      `Last error: ${describeLastError ? describeLastError(lastError) : lastError.message}`,
    );
  }
  assert.fail(
    details.length > 0
      ? `${timeoutMessage}. ${details.join(". ")}`
      : timeoutMessage,
  );
}

export function isTransientReadError(error) {
  const message = error?.message ?? "";
  return (
    error?.code === "ENOENT" ||
    message.includes("ENOENT") ||
    message.includes("Unexpected end of JSON input")
  );
}
