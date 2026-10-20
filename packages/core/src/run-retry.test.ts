import { describe, expect, it } from "vitest";
import { RUN_SETUP_MAX_ATTEMPTS, runRetryState, runSetupRetryDelay } from "./run-retry.js";

describe("startup retries", () => {
  it("bounds retries to three startup attempts with short delays", () => {
    expect(RUN_SETUP_MAX_ATTEMPTS).toBe(3);
    expect([1, 2, 20].map(runSetupRetryDelay)).toEqual([30_000, 60_000, 60_000]);
  });
  it("distinguishes a failed startup from an ordinary queued job", () => {
    const attempt = { error: "Computer unavailable", finishedAt: "2026-01-01T00:00:00Z" };
    expect(runRetryState({ status: "queued", error: null, attempts: [attempt] })).toBeNull();
    expect(
      runRetryState({ status: "running", error: attempt.error, attempts: [attempt] }),
    ).toBeNull();
    expect(runRetryState({ status: "queued", error: attempt.error, attempts: [attempt] })).toEqual({
      attempt: 2,
      maxAttempts: 3,
      at: "2026-01-01T00:00:30.000Z",
      error: attempt.error,
    });
  });
  it("ignores resource waits and unfinished attempts", () => {
    expect(
      runRetryState({
        status: "queued",
        error: "Computer unavailable",
        attempts: [
          { error: null, finishedAt: "2026-01-01T00:00:00Z" },
          { error: "error", finishedAt: null },
        ],
      }),
    ).toBeNull();
  });
});
