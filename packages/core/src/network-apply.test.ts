import type { NetworkApplyStatus } from "@rakazo/contracts";
import { expect, it, vi } from "vitest";
import { waitForNetworkApply } from "./network-apply.js";

const started: NetworkApplyStatus = {
  available: true,
  phase: "restarting",
  operationId: "operation",
  revision: "revision",
  error: null,
};
it("waits through API loss and requires the matching control operation to finish", async () => {
  const read = vi
    .fn()
    .mockRejectedValueOnce(new Error("API restarting"))
    .mockResolvedValueOnce({ ...started, phase: "verifying" })
    .mockResolvedValueOnce({ ...started, phase: "succeeded" });
  const seen = vi.fn();
  await waitForNetworkApply(read, started, new AbortController().signal, seen, async () => {});
  expect(read).toHaveBeenCalledTimes(3);
  expect(seen).toHaveBeenLastCalledWith({ ...started, phase: "succeeded" });
});
it("does not claim a different operation or a failed recovery succeeded", async () => {
  await expect(
    waitForNetworkApply(
      async () => ({ ...started, operationId: "other", phase: "succeeded" }),
      started,
      new AbortController().signal,
      () => {},
      async () => {},
    ),
  ).rejects.toThrow("changed");
  await expect(
    waitForNetworkApply(
      async () => ({ ...started, phase: "failed", error: "The previous route was restored" }),
      started,
      new AbortController().signal,
      () => {},
      async () => {},
    ),
  ).rejects.toThrow("previous route");
});
