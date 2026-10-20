import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { connect, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecureContext, createServer as createTlsServer } from "node:tls";
import { Composio } from "@composio/core";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposioConnector } from "./composio-connector.js";
import { KeylessHttpWebProvider, parseDuckDuckGoResults } from "./keyless-http-web.js";
import { createAddressCheckedLookup } from "./network-address.js";
import { createSafeRemoteFetch } from "./remote-mcp.js";
import { closeToolEgress, connectorFetch, createToolAgent } from "./tool-egress.js";
import { dispatcherFetch } from "./undici-fetch.js";
import { fetchSafeWebText } from "./web-ssrf.js";

const publicAddress = "203.0.113.10";
const resolve = async () => [{ address: publicAddress, family: 4 }];
const context: AdapterContext = {
  operationId: "test",
  traceId: "test",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

afterEach(async () => {
  await closeToolEgress();
  vi.unstubAllEnvs();
});

/** Real SOCKS negotiation with all targets mapped to a loopback test peer.
 * No connection to the requested public documentation addresses is attempted. */
async function fixture(tls = false) {
  const requests: { host?: string; path?: string; body: string; authorization?: string }[] = [];
  const targets: { host: string; port: number }[] = [];
  const sockets = new Set<Socket>();
  const serverNames: string[] = [];
  let directory: string | undefined;
  const peer = tls
    ? (() => {
        directory = mkdtempSync(join(tmpdir(), "rakazo-tool-egress-"));
        execFileSync(
          "openssl",
          [
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "1",
            "-subj",
            "/CN=tool.example.test",
            "-keyout",
            join(directory, "key.pem"),
            "-out",
            join(directory, "cert.pem"),
          ],
          { stdio: "ignore" },
        );
        const credentials = {
          key: readFileSync(join(directory, "key.pem")),
          cert: readFileSync(join(directory, "cert.pem")),
        };
        const secureContext = createSecureContext(credentials);
        const server = createTlsServer({
          ...credentials,
          SNICallback(serverName, callback) {
            serverNames.push(serverName);
            callback(null, secureContext);
          },
        });
        server.on("tlsClientError", () => undefined);
        return server;
      })()
    : createHttpServer(async (request, response) => {
        const parts: Buffer[] = [];
        for await (const part of request) parts.push(Buffer.from(part));
        requests.push({
          host: request.headers.host,
          path: request.url,
          body: Buffer.concat(parts).toString(),
          authorization: request.headers.authorization,
        });
        if (request.url === "/redirect") {
          response.writeHead(302, { location: "http://127.0.0.1/private" });
          response.end();
        } else if (request.url?.startsWith("/search")) {
          response.end(
            '<div class="result"><a class="result__a" href="https://result.example.test/">Result</a><span class="result__snippet">Found it</span></div>',
          );
        } else if (request.url?.startsWith("/api/")) {
          response.setHeader("content-type", "application/json");
          response.end(
            request.url.includes("/session")
              ? JSON.stringify({
                  session_id: "test-session",
                  config: { preload: { tools: [] } },
                  config_version: 1,
                  mcp: { type: "http", url: "https://tool.example.test/mcp" },
                })
              : '{"items":[],"total_pages":1}',
          );
        } else {
          response.end("<html><title>Proxied</title><p>Proxy response</p></html>");
        }
      });
  function track(socket: Socket) {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
  }
  peer.on("connection", track);
  await new Promise<void>((ready) => peer.listen(0, "127.0.0.1", ready));
  const peerPort = (peer.address() as AddressInfo).port;
  const proxy = createTcpServer((client) => {
    track(client);
    let stage = 0;
    let pending = Buffer.alloc(0);
    const read = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (stage === 0) {
        if (pending.length < 2 || pending.length < 2 + pending[1]!) return;
        pending = pending.subarray(2 + pending[1]!);
        stage = 1;
        client.write(Buffer.from([5, 0]));
      }
      if (stage === 1) {
        if (pending.length < 4) return;
        const length = pending[3] === 1 ? 4 : pending[3] === 4 ? 16 : 1 + (pending[4] ?? 0);
        if (pending.length < 6 + length) return;
        const host =
          pending[3] === 1
            ? Array.from(pending.subarray(4, 8)).join(".")
            : pending[3] === 3
              ? pending.subarray(5, 4 + length).toString()
              : "ipv6";
        targets.push({ host, port: pending.readUInt16BE(4 + length) });
        pending = pending.subarray(6 + length);
        stage = 2;
        client.off("data", read);
        const upstream = connect(peerPort, "127.0.0.1", () => {
          client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          if (pending.length) upstream.write(pending);
          client.pipe(upstream);
          upstream.pipe(client);
        });
        track(upstream);
        upstream.on("error", () => client.destroy());
        client.on("close", () => upstream.destroy());
      }
    };
    client.on("data", read);
  });
  await new Promise<void>((ready) => proxy.listen(0, "127.0.0.1", ready));
  const proxyUrl = `socks5://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  return {
    requests,
    targets,
    serverNames,
    proxyUrl,
    peerPort,
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all([
        new Promise<void>((done) => proxy.close(() => done())),
        new Promise<void>((done) => peer.close(() => done())),
      ]);
      if (directory) rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe("tool egress", () => {
  it("uses the selected tools config instead of a conflicting legacy proxy", async () => {
    const peer = await fixture();
    const directory = mkdtempSync(join(tmpdir(), "rakazo-network-config-"));
    const file = join(directory, "network.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        mode: "tools",
        transport: { type: "socks5", url: peer.proxyUrl },
      }),
    );
    vi.stubEnv("RAKAZO_NETWORK_CONFIG", file);
    vi.stubEnv("TOOL_EGRESS_PROXY_URL", "socks5://127.0.0.1:1");
    try {
      const result = await fetchSafeWebText("http://tool.example.test/page", {
        resolveHostname: resolve,
      });
      expect(result.body).toContain("Proxy response");
      expect(peer.targets).toEqual([{ host: publicAddress, port: 80 }]);
    } finally {
      await peer.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("routes built-in web fetch and search through SOCKS using checked IPs and the original Host", async () => {
    const peer = await fixture();
    vi.stubEnv("TOOL_EGRESS_PROXY_URL", peer.proxyUrl);
    try {
      const web = new KeylessHttpWebProvider({
        resolveHostname: resolve,
        searchBackend: {
          id: "test",
          endpoint: "http://search.example.test/search",
          parse: parseDuckDuckGoResults,
        },
      });
      expect((await web.fetch({ url: "http://tool.example.test/page" }, context)).text).toContain(
        "Proxy response",
      );
      expect(await web.search({ query: "test" }, context)).toEqual([
        { title: "Result", url: "https://result.example.test/", snippet: "Found it" },
      ]);
      expect(peer.targets).toEqual([
        { host: publicAddress, port: 80 },
        { host: publicAddress, port: 80 },
      ]);
      expect(peer.requests.map((r) => r.host)).toEqual([
        "tool.example.test",
        "search.example.test",
      ]);
    } finally {
      await peer.close();
    }
  });

  it("preserves SSRF and DNS-rebinding checks, including redirects, before reaching the proxy", async () => {
    const peer = await fixture();
    vi.stubEnv("TOOL_EGRESS_PROXY_URL", peer.proxyUrl);
    try {
      await expect(
        fetchSafeWebText("http://tool.example.test/redirect", { resolveHostname: resolve }),
      ).rejects.toThrow(/private|internal/i);
      const rebinding = vi
        .fn()
        .mockResolvedValueOnce(await resolve())
        .mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
      await expect(
        fetchSafeWebText("http://tool.example.test/", { resolveHostname: rebinding }),
      ).rejects.toThrow();
      const remote = createSafeRemoteFetch(undefined, async () => [
        { address: "169.254.169.254", family: 4 },
      ]);
      try {
        await expect(remote("https://tool.example.test/mcp")).rejects.toThrow(/private/);
      } finally {
        await remote.close();
      }
      expect(peer.targets).toHaveLength(1);
    } finally {
      await peer.close();
    }
  });

  it("routes public MCP HTTPS connections through the proxy while retaining certificate validation", async () => {
    const peer = await fixture(true);
    vi.stubEnv("TOOL_EGRESS_PROXY_URL", peer.proxyUrl);
    const remote = createSafeRemoteFetch(undefined, resolve);
    try {
      await expect(remote("https://tool.example.test/mcp")).rejects.toThrow(
        /self.signed|certificate/i,
      );
      expect(peer.targets).toEqual([{ host: publicAddress, port: 443 }]);
      expect(peer.serverNames).toEqual(["tool.example.test"]);
      expect(peer.requests).toHaveLength(0);
    } finally {
      await remote.close();
      await peer.close();
    }
  });

  it("keeps authorized private MCP endpoints direct, and never changes global fetch", async () => {
    const peer = await fixture();
    vi.stubEnv("TOOL_EGRESS_PROXY_URL", peer.proxyUrl);
    const original = globalThis.fetch;
    const remote = createSafeRemoteFetch(
      undefined,
      async () => [{ address: "127.0.0.1", family: 4 }],
      { allowPrivateEndpoint: true },
    );
    try {
      const response = await remote(`http://127.0.0.1:${peer.peerPort}/internal`);
      await response.text();
      expect(peer.targets).toHaveLength(0);
      expect(peer.requests).toHaveLength(1);
      expect(globalThis.fetch).toBe(original);
    } finally {
      await remote.close();
      await peer.close();
    }
  });

  it("proxies connector Request bodies and credentials without global routing", async () => {
    const peer = await fixture();
    vi.stubEnv("TOOL_EGRESS_PROXY_URL", peer.proxyUrl);
    try {
      const response = await connectorFetch(
        new Request(`http://${publicAddress}/post`, {
          method: "POST",
          headers: { authorization: "Bearer fake-test-value" },
          body: "test-body",
        }),
      );
      await response.text();
      expect(peer.targets).toEqual([{ host: publicAddress, port: 80 }]);
      expect(peer.requests[0]).toMatchObject({
        body: "test-body",
        authorization: "Bearer fake-test-value",
      });
    } finally {
      await closeToolEgress();
      await peer.close();
    }
  });

  it("routes the real managed connector SDK through its proxied transport", async () => {
    const peer = await fixture();
    vi.stubEnv("TOOL_EGRESS_PROXY_URL", peer.proxyUrl);
    vi.stubEnv("COMPOSIO_BASE_URL", `http://${publicAddress}`);
    const direct = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected direct request"));
    const sdkClient = vi.spyOn(Composio.prototype, "getClient");
    try {
      const connector = new ComposioConnector("fake-test-key");
      expect((await connector.sessionFor("user")).sessionId).toBe("test-session");
      const client = sdkClient.mock.results[0]!.value;
      expect(await client.withOptions({ maxRetries: 0 }).get("/api/clone-probe")).toMatchObject({
        items: [],
      });
      expect(peer.requests.some((request) => request.path === "/api/clone-probe")).toBe(true);
      expect(direct).not.toHaveBeenCalled();
      expect(peer.targets.length).toBeGreaterThan(0);
      expect(peer.targets.every((target) => target.host === publicAddress)).toBe(true);
      expect(peer.requests[0]?.path).toMatch(/session/);
    } finally {
      sdkClient.mockRestore();
      direct.mockRestore();
      await closeToolEgress();
      await peer.close();
    }
  });

  it("fails closed if SOCKS is unavailable and redacts invalid configuration", async () => {
    const peer = await fixture();
    const unavailable = peer.proxyUrl;
    await peer.close();
    const agent = createToolAgent(
      createAddressCheckedLookup(resolve, () => undefined),
      unavailable,
    );
    try {
      await expect(
        dispatcherFetch("http://tool.example.test/", { dispatcher: agent } as RequestInit),
      ).rejects.toThrow();
    } finally {
      await agent.destroy();
    }
    expect(() =>
      createToolAgent(undefined, "https://user:fake-password@proxy.example.test"),
    ).toThrow("must be a valid SOCKS5");
    expect(() =>
      createToolAgent(undefined, "https://user:fake-password@proxy.example.test"),
    ).not.toThrow(/fake-password/);
  });
});
