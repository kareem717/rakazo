import { expect, it, vi } from "vitest";
import type { NetworkDrainDependencies } from "./network-drain.js";
import { drainNetworkComputers, releaseNetworkDrain } from "./network-drain.js";

const checkpoint = vi.hoisted(() => vi.fn());
vi.mock("./computer-workspace.js", () => ({ checkpointAndRecordComputerWorkspace: checkpoint }));
vi.mock("./computer-control.js", () => ({ revokeScreenControl: vi.fn() }));
function fixture() {
  checkpoint.mockReset().mockResolvedValue("saved");
  const computer = {
    id: "computer",
    homeKey: "home",
    kind: "fake",
    providerRef: "provider",
    state: "running",
    spaceId: "space",
    userId: "user",
    controlLeaseId: null,
  };
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const prisma = {
    computer: {
      count: vi.fn().mockResolvedValue(0),
      updateMany,
      findMany: vi.fn().mockResolvedValue([computer]),
    },
    run: { count: vi.fn().mockResolvedValue(0) },
    computerExecutionLease: { count: vi.fn().mockResolvedValue(0) },
    $transaction: vi.fn(async (fn) => fn(prisma)),
  };
  const stop = vi.fn().mockResolvedValue(undefined);
  const deps = {
    prisma,
    home: {},
    sandbox: { stop, isRunning: vi.fn().mockResolvedValue(true) },
  } as unknown as NetworkDrainDependencies;
  return { deps, prisma, stop, updateMany };
}
it("waits for running work, checkpoints before stopping, and keeps the fence until release", async () => {
  const { deps, prisma, stop, updateMany } = fixture();
  prisma.run.count.mockResolvedValueOnce(1).mockResolvedValue(0);
  const wait = vi.fn(async () => {
    expect(stop).not.toHaveBeenCalled();
  });
  await drainNetworkComputers(deps, "operation", new AbortController().signal, wait);
  expect(wait).toHaveBeenCalledOnce();
  expect(checkpoint).toHaveBeenCalledOnce();
  expect(checkpoint.mock.invocationCallOrder[0]).toBeLessThan(stop.mock.invocationCallOrder[0]);
  expect(updateMany).toHaveBeenLastCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ state: "stopped" }) }),
  );
  expect(updateMany.mock.calls.some(([call]) => call.data.maintenanceId === null)).toBe(false);
  await releaseNetworkDrain(deps.prisma, "operation");
  expect(updateMany).toHaveBeenLastCalledWith({
    where: { maintenanceId: "network:operation" },
    data: { maintenanceId: null },
  });
});
it("never stops a computer whose checkpoint fails", async () => {
  const { deps, stop } = fixture();
  checkpoint.mockRejectedValue(new Error("private provider failure"));
  await expect(
    drainNetworkComputers(deps, "operation", new AbortController().signal),
  ).rejects.toThrow("Could not save and stop");
  expect(stop).not.toHaveBeenCalled();
});
it("refuses competing maintenance before changing any computer", async () => {
  const { deps, prisma, updateMany, stop } = fixture();
  prisma.computer.count.mockResolvedValue(1);
  await expect(
    drainNetworkComputers(deps, "operation", new AbortController().signal),
  ).rejects.toThrow("maintenance");
  expect(updateMany).not.toHaveBeenCalled();
  expect(stop).not.toHaveBeenCalled();
});
it("times out waiting for work without stopping or checkpointing", async () => {
  const { deps, prisma, stop } = fixture();
  prisma.run.count.mockResolvedValue(1);
  const controller = new AbortController();
  await expect(
    drainNetworkComputers(deps, "operation", controller.signal, async () => controller.abort()),
  ).rejects.toThrow();
  expect(checkpoint).not.toHaveBeenCalled();
  expect(stop).not.toHaveBeenCalled();
});
