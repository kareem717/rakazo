import http from "node:http";
import type { NetworkConnection } from "@rakazo/contracts";
import { NetworkConnectionSchema } from "@rakazo/contracts";

/** A narrow gateway socket, never the Docker socket or raw Tailscale LocalAPI. */
export async function networkConnection(
  connect = false,
  socketPath = process.env.RAKAZO_NETWORK_CONTROL_SOCKET,
): Promise<NetworkConnection> {
  if (!socketPath) return { available: false };
  try {
    return await new Promise<NetworkConnection>((resolve, reject) => {
      const request = http.request(
        {
          socketPath,
          path: connect ? "/tailscale/connect" : "/tailscale",
          method: connect ? "POST" : "GET",
          headers: { Host: "network-control" },
          signal: AbortSignal.timeout(12_000),
        },
        (response) => {
          let body = "";
          response.on("error", reject);
          response.on("data", (data) => {
            body += data;
            if (Buffer.byteLength(body) > 256 * 1024)
              request.destroy(new Error("Response too large"));
          });
          response.on("end", () => {
            try {
              if (response.statusCode !== 200) throw new Error("Gateway unavailable");
              resolve(NetworkConnectionSchema.parse(JSON.parse(body)));
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.on("error", reject);
      request.end();
    });
  } catch {
    throw new Error("Could not connect to the network gateway");
  }
}
