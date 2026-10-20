import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { networkConnection } from "./network-connection.js";

it("requires deployment configuration and hides socket errors", async () => {
  expect(await networkConnection(false, "")).toEqual({ available: false });
  await expect(networkConnection(false, "/missing/network.sock")).rejects.toThrow(
    "Could not connect to the network gateway",
  );
});
it("only sends the fixed status/login operations and validates authorization URLs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "network-control-"));
  const socket = join(dir, "control.sock");
  const requests: string[] = [];
  let authUrl = "https://login.tailscale.com/a/abc123";
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.end(
      JSON.stringify({
        available: true,
        provider: "tailscale",
        state: "needs-login",
        tailnet: null,
        authUrl,
        exitNodes: [],
        privateKey: "never return",
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    expect(await networkConnection(false, socket)).not.toHaveProperty("privateKey");
    expect(await networkConnection(true, socket)).toMatchObject({ authUrl });
    expect(requests).toEqual(["GET /tailscale", "POST /tailscale/connect"]);
    authUrl = "https://evil.example/auth";
    await expect(networkConnection(true, socket)).rejects.toThrow(
      "Could not connect to the network gateway",
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
