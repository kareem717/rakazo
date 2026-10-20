import type { NetworkApplyStatus } from "@rakazo/contracts";

export function isNetworkApplying(status: NetworkApplyStatus) {
  return ["checking", "draining", "restarting", "verifying"].includes(status.phase);
}

/** The control service survives API restarts; API availability alone is not success. */
export async function waitForNetworkApply(
  read: () => Promise<NetworkApplyStatus>,
  operation: NetworkApplyStatus,
  signal: AbortSignal,
  onStatus: (status: NetworkApplyStatus) => void,
  wait = () => new Promise<void>((resolve) => setTimeout(resolve, 2000)),
) {
  if (!operation.available || !operation.operationId)
    throw new Error("Network restart service is unavailable");
  for (let attempt = 0; attempt < 600 && !signal.aborted; attempt++) {
    let next: NetworkApplyStatus;
    try {
      next = await read();
    } catch {
      await wait();
      continue;
    }
    if (signal.aborted) return;
    if (next.operationId !== operation.operationId || next.revision !== operation.revision)
      throw new Error("Network apply changed. Reload settings.");
    onStatus(next);
    if (next.phase === "failed") throw new Error(next.error ?? "Could not apply network settings");
    if (next.phase === "succeeded") return;
    await wait();
  }
  if (!signal.aborted)
    throw new Error(
      "Restart is taking longer than expected. Reopen Network settings to check progress.",
    );
}
