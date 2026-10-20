import { chmod, chown, mkdir, unlink } from "node:fs/promises";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { runHostCommand } from "./index.js";
import { NetworkApplier, networkApplyConfig } from "./network-apply.js";

export function createNetworkApplyServer(applier: NetworkApplier) {
  return http.createServer(async (req, res) => {
    const json = (code: number, value: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(value));
    };
    if (req.headers.origin || req.headers.referer) return json(403, { error: "Forbidden" });
    if (req.method === "GET" && req.url === "/health") return json(200, { ok: true });
    if (req.method === "GET" && req.url === "/network") return json(200, applier.status);
    if (req.method !== "POST" || req.url !== "/network") return json(404, { error: "Not found" });
    try {
      let body = "";
      for await (const part of req) {
        body += part;
        if (Buffer.byteLength(body) > 512) return json(413, { error: "Request too large" });
      }
      return json(202, await applier.start(JSON.parse(body)));
    } catch {
      return json(409, {
        error: "Network settings changed or an apply is already running. Reload and try again.",
      });
    }
  });
}
async function main() {
  await mkdir("/control", { recursive: true, mode: 0o750 });
  await chmod("/control", 0o750);
  await chown("/control", 0, 1000);
  const applier = new NetworkApplier(
    networkApplyConfig(process.env),
    "/control/state",
    runHostCommand,
  );
  await applier.initialize();
  await unlink("/control/network.sock").catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  const server = createNetworkApplyServer(applier);
  server.listen("/control/network.sock", async () => {
    try {
      await chmod("/control/network.sock", 0o660);
      await chown("/control/network.sock", 0, 1000);
    } catch {
      process.exit(1);
    }
  });
  server.on("error", () => {
    process.stderr.write("Network restart service failed\n");
    process.exit(1);
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  void main().catch(() => {
    process.stderr.write("Network restart service failed\n");
    process.exit(1);
  });
