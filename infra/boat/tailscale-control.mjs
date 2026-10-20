// The API gets this restricted Unix socket, never tailscaled's privileged socket.

import { chmod, chown, mkdir, unlink } from "node:fs/promises";
import http from "node:http";
import { fileURLToPath } from "node:url";

const authUrlPattern = /^https:\/\/login\.tailscale\.com\/a\/[a-zA-Z0-9]+$/;
export function connectionStatus(status) {
  const state =
    {
      Running: "connected",
      NeedsLogin: "needs-login",
      NeedsMachineAuth: "needs-approval",
      Stopped: "stopped",
    }[status.BackendState] ?? "starting";
  return {
    available: true,
    provider: "tailscale",
    state,
    tailnet:
      typeof status.CurrentTailnet?.Name === "string"
        ? status.CurrentTailnet.Name.slice(0, 253)
        : null,
    authUrl:
      state !== "connected" &&
      typeof status.AuthURL === "string" &&
      authUrlPattern.test(status.AuthURL)
        ? status.AuthURL
        : null,
    exitNodes:
      state === "connected"
        ? Object.values(status.Peer ?? {})
            .filter(
              (peer) =>
                peer.ExitNodeOption &&
                typeof peer.DNSName === "string" &&
                peer.DNSName.length &&
                peer.DNSName.length <= 253,
            )
            .slice(0, 512)
            .map((peer) => ({
              name: peer.DNSName.replace(/\.$/, ""),
              value: peer.DNSName.replace(/\.$/, ""),
              online: peer.Online === true,
            }))
            .sort((a, b) => a.name.localeCompare(b.name))
        : [],
  };
}

export function localApi(path, method = "GET", body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: "/var/run/tailscale/tailscaled.sock",
        path: `/localapi/v0/${path}`,
        method,
        headers: { Host: "local-tailscaled.sock", "Content-Type": "application/json" },
        signal: AbortSignal.timeout(5000),
      },
      (res) => {
        let data = "";
        res.on("error", reject);
        res.on("data", (part) => {
          data += part;
          if (Buffer.byteLength(data) > 4 * 1024 * 1024)
            req.destroy(new Error("Response too large"));
        });
        res.on("end", () => {
          try {
            if (res.statusCode < 200 || res.statusCode >= 300)
              throw new Error("Tailscale unavailable");
            resolve(data ? JSON.parse(data) : null);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

export function createControlServer(api = localApi) {
  let connecting;
  async function connect() {
    const status = connectionStatus(await api("status"));
    // Clicking Connect never logs out or reauthorizes an existing identity.
    if (status.state === "connected" || status.state === "needs-approval" || status.authUrl)
      return status;
    await api("prefs", "PATCH", {
      WantRunning: true,
      WantRunningSet: true,
      CorpDNS: false,
      CorpDNSSet: true,
      NetfilterMode: 0,
      NetfilterModeSet: true,
      Hostname: "rakazo-egress",
      HostnameSet: true,
    });
    await api("start", "POST", {});
    const resumed = connectionStatus(await api("status"));
    if (resumed.state === "needs-login" && !resumed.authUrl) await api("login-interactive", "POST");
    return connectionStatus(await api("status"));
  }
  return http.createServer(async (req, res) => {
    const json = (code, value) => {
      res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(value));
    };
    if (req.headers.origin || req.headers.referer) return json(403, { error: "Forbidden" });
    if (
      req.headers["transfer-encoding"] ||
      (req.headers["content-length"] && req.headers["content-length"] !== "0")
    )
      return json(400, { error: "Unexpected body" });
    if (req.method === "GET" && req.url === "/health") {
      try {
        await api("status");
        return json(200, { ready: true });
      } catch {
        return json(503, { error: "Network gateway unavailable" });
      }
    }
    if (
      !(
        (req.method === "GET" && req.url === "/tailscale") ||
        (req.method === "POST" && req.url === "/tailscale/connect")
      )
    )
      return json(404, { error: "Not found" });
    try {
      if (req.method === "GET") return json(200, connectionStatus(await api("status")));
      // Coalesce simultaneous requests; no raw LocalAPI path or settings from the caller.
      connecting ??= connect().finally(() => {
        connecting = undefined;
      });
      return json(200, await connecting);
    } catch {
      return json(503, { error: "Network gateway unavailable" });
    }
  });
}

async function main() {
  await mkdir("/control", { recursive: true, mode: 0o750 });
  await chmod("/control", 0o750);
  await chown("/control", 0, 1000);
  await unlink("/control/network.sock").catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  const server = createControlServer();
  server.listen("/control/network.sock", async () => {
    try {
      await chmod("/control/network.sock", 0o660);
      await chown("/control/network.sock", 0, 1000);
    } catch {
      process.exit(1);
    }
  });
  server.on("error", () => {
    console.error("Network control startup failed");
    process.exit(1);
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  void main().catch(() => {
    console.error("Network control startup failed");
    process.exit(1);
  });
