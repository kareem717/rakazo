import type { RunRetry } from "@rakazo/contracts";

/** Three startup attempts, with short delays, rather than hours of queue backoff. */
export const RUN_SETUP_MAX_ATTEMPTS = 3;

export function runSetupRetryDelay(failures: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, failures - 1), 60_000);
}

export type RunSetupAttempt = {
  error: string | null;
  finishedAt: Date | string | null;
};

export function runRetryState(run: {
  status: string;
  error?: string | null;
  attempts?: readonly RunSetupAttempt[];
}): RunRetry | null {
  if (run.status !== "queued" || !run.error) return null;
  const attempts = (run.attempts ?? []).filter((attempt) => attempt.error && attempt.finishedAt);
  if (!attempts.length) return null;
  const latest = Math.max(...attempts.map((attempt) => new Date(attempt.finishedAt!).getTime()));
  if (!Number.isFinite(latest)) return null;
  return {
    attempt: Math.min(attempts.length + 1, RUN_SETUP_MAX_ATTEMPTS),
    maxAttempts: RUN_SETUP_MAX_ATTEMPTS,
    at: new Date(latest + runSetupRetryDelay(attempts.length)).toISOString(),
    error: run.error.slice(0, 2_000),
  };
}
