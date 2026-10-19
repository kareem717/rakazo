import http from "node:http";
import type { NetworkConnection } from "@rakazo/contracts";
import { NetworkConnectionSchema } from "@rakazo/contracts";

export async function networkSocketRequest(
  socketPath: string,
  path: string,
  method = "GET",
  input?: unknown,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath,
        path,
        method,
        headers: { Host: "network-control", "Content-Type": "application/json" },
        signal: AbortSignal.timeout(12_000),
      },
      (response) => {
        let body = "";
        response.on("error", reject);
        response.on("data", (part) => {
          body += part;
          if (Buffer.byteLength(body) > 256 * 1024)
            request.destroy(new Error("Response too large"));
        });
        response.on("end", () => {
          try {
            if (response.statusCode !== 200 && response.statusCode !== 202)
              throw new Error("Network control unavailable");
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on("error", reject);
    request.end(input === undefined ? undefined : JSON.stringify(input));
  });
}

/** A narrow gateway socket, never the Docker socket or raw Tailscale LocalAPI. */
export async function networkConnection(
  connect = false,
  socketPath = process.env.RAKAZO_NETWORK_CONTROL_SOCKET,
): Promise<NetworkConnection> {
  if (!socketPath) return { available: false };
  try {
    return NetworkConnectionSchema.parse(
      await networkSocketRequest(
        socketPath,
        connect ? "/tailscale/connect" : "/tailscale",
        connect ? "POST" : "GET",
      ),
    );
  } catch {
    throw new Error("Could not connect to the network gateway");
  }
}
