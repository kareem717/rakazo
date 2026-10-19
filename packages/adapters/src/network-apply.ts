import type { NetworkApplyStatus } from "@rakazo/contracts";
import { NetworkApplyStatusSchema } from "@rakazo/contracts";
import { NetworkControlError, networkSocketRequest } from "./network-connection.js";

export class NetworkApplyConflict extends Error {
  constructor() {
    super("Network settings changed or an apply is already running. Reload and try again.");
  }
}

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
  } catch (error) {
    if (error instanceof NetworkControlError && error.status === 409)
      throw new NetworkApplyConflict();
    throw new Error("Could not reach the network restart service");
  }
}
