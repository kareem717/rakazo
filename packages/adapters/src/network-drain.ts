import type { AdapterContext, AgentHomeStore, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { revokeScreenControl } from "./computer-control.js";
import { toComputerRef } from "./computer-support.js";
import { checkpointAndRecordComputerWorkspace } from "./computer-workspace.js";
import { isSandboxGoneError } from "./e2b-sandbox.js";

export type NetworkDrainDependencies = {
  prisma: PrismaClient;
  sandbox: SandboxProvider;
  home: AgentHomeStore;
};
const managed = { kind: { not: "desktop" } };
const fence = (operationId: string) => `network:${operationId}`;
export async function networkDrainPreview(prisma: PrismaClient) {
  const computers = await prisma.computer.findMany({
    where: { ...managed, providerRef: { not: null }, state: { notIn: ["stopped", "suspended"] } },
    select: { id: true, bots: { select: { name: true }, orderBy: { createdAt: "asc" }, take: 1 } },
    orderBy: { createdAt: "asc" },
  });
  return {
    computers: computers.map((computer) => ({
      id: computer.id,
      name: computer.bots[0]?.name ?? "Computer",
    })),
  };
}
export async function releaseNetworkDrain(prisma: PrismaClient, operationId: string) {
  await prisma.computer.updateMany({
    where: { maintenanceId: fence(operationId) },
    data: { maintenanceId: null },
  });
}

/** Maintenance claims fence normal boot/lease paths across API and worker processes. */
export async function drainNetworkComputers(
  deps: NetworkDrainDependencies,
  operationId: string,
  signal: AbortSignal,
  wait = () => new Promise<void>((resolve) => setTimeout(resolve, 1000)),
) {
  const maintenanceId = fence(operationId);
  await deps.prisma.$transaction(async (tx) => {
    const busy = await tx.computer.count({
      where: { ...managed, maintenanceId: { not: null, notIn: [maintenanceId] } },
    });
    if (busy)
      throw new Error("Computer maintenance is already running. Try again when it finishes.");
    await tx.computer.updateMany({
      where: { ...managed, maintenanceId: null },
      data: { maintenanceId },
    });
  });
  // Existing work may finish; new execution leases and boots cannot enter the claimed computers.
  for (;;) {
    signal.throwIfAborted();
    const now = new Date();
    const [runs, leases, transitions] = await Promise.all([
      deps.prisma.run.count({
        where: { status: { in: ["leased", "running"] }, bot: { computer: { maintenanceId } } },
      }),
      deps.prisma.computerExecutionLease.count({
        where: { expiresAt: { gt: now }, computer: { maintenanceId } },
      }),
      deps.prisma.computer.count({
        where: { maintenanceId, state: { in: ["booting", "suspending"] } },
      }),
    ]);
    if (!runs && !leases && !transitions) break;
    await wait();
  }
  const computers = await deps.prisma.computer.findMany({ where: { maintenanceId } });
  for (const computer of computers) {
    signal.throwIfAborted();
    if (!computer.providerRef || ["stopped", "suspended"].includes(computer.state)) continue;
    const context: AdapterContext = {
      operationId: maintenanceId,
      traceId: maintenanceId,
      spaceId: computer.spaceId,
      userId: computer.userId,
      signal,
    };
    const ref = toComputerRef(computer);
    const claimed = await deps.prisma.computer.updateMany({
      where: {
        id: computer.id,
        maintenanceId,
        providerRef: computer.providerRef,
        state: computer.state,
        executionLeases: { none: { expiresAt: { gt: new Date() } } },
      },
      data: { state: "suspending", screenGeneration: { increment: 1 } },
    });
    if (claimed.count !== 1) throw new Error("Computer work changed while draining. Try again.");
    try {
      if (!deps.sandbox.isRunning || (await deps.sandbox.isRunning(ref, context))) {
        await revokeScreenControl(deps, computer, context, computer.controlLeaseId ?? undefined, {
          clearGoneRef: false,
        });
        await checkpointAndRecordComputerWorkspace(deps, computer, ref, context);
        await deps.sandbox.stop(ref, context);
      }
      await deps.prisma.computer.updateMany({
        where: { id: computer.id, maintenanceId },
        data: {
          state: "stopped",
          runningSince: null,
          controlHolder: "none",
          controlLeaseId: null,
          controlLeaseExpiresAt: null,
          controlBotId: null,
          controlRunId: null,
        },
      });
    } catch (error) {
      await deps.prisma.computer.updateMany({
        where: { id: computer.id, maintenanceId },
        data: { state: isSandboxGoneError(error) ? "stopped" : "error" },
      });
      if (!isSandboxGoneError(error))
        throw new Error("Could not save and stop a computer. The network was not changed.");
    }
  }
}
