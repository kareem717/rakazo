import type { NetworkApplyStatus } from "@rakazo/contracts";
import { NetworkApplyStatusSchema } from "@rakazo/contracts";
import { networkSocketRequest } from "./network-connection.js";

export async function networkApplyStatus(
  revision?: string,
  socketPath = process.env.RAKAZO_NETWORK_APPLY_SOCKET,
): Promise<NetworkApplyStatus> {
  if (!socketPath)
    return { available: false, phase: "idle", operationId: null, revision: null, error: null };
  try {
    return NetworkApplyStatusSchema.parse(
      await networkSocketRequest(
        socketPath,
        "/network",
        revision ? "POST" : "GET",
        revision ? { revision } : undefined,
      ),
    );
  } catch {
    throw new Error("Could not reach the network restart service");
  }
}
