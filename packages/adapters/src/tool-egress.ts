import { lookup } from "node:dns/promises";
import type { LookupFunction, Socket } from "node:net";
import { isIP } from "node:net";
import { SocksClient } from "socks";
import { Agent, buildConnector } from "undici";
import { toolEgressProxyUrl } from "./egress-config.js";
import { createAddressCheckedLookup, isPrivateAddress } from "./network-address.js";
import { dispatcherFetch } from "./undici-fetch.js";

const CONNECT_TIMEOUT_MS = 10_000;
const publicLookup = createAddressCheckedLookup(
  (hostname) => lookup(hostname, { all: true, verbatim: true }),
  (addresses) => {
    if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
      throw new Error("Tool endpoint resolved to a private address");
    }
  },
);

/** Optional deployment-wide egress for web tools and connectors, never models or memory.
 * Guarded callers supply their address-checking lookup. The SOCKS request receives
 * that checked IP, not a hostname the proxy could resolve differently. */
export function createToolAgent(
  lookup: LookupFunction = publicLookup,
  proxyUrl = toolEgressProxyUrl(),
): Agent {
  if (!proxyUrl) return new Agent({ connect: { lookup } });
  const proxy = parseToolProxy(proxyUrl);
  const direct = buildConnector({ lookup, timeout: CONNECT_TIMEOUT_MS });
  const tls = buildConnector({ timeout: CONNECT_TIMEOUT_MS });
  return new Agent({
    connect(options, callback) {
      let finished = false;
      let socket: Socket | undefined;
      const done: typeof callback = (error, connected) => {
        if (finished) {
          connected?.destroy();
          return;
        }
        finished = true;
        clearTimeout(timer);
        if (error) {
          socket?.destroy();
          callback(error, null);
        } else callback(null, connected);
      };
      const timer = setTimeout(
        () => done(new Error("Tool egress connection timed out"), null),
        CONNECT_TIMEOUT_MS,
      );
      const hostname = options.hostname.replace(/^\[|\]$/g, "");
      lookup(hostname, { all: true, family: 0, hints: 0 }, (error, resolved) => {
        if (finished) return;
        if (error) return done(error, null);
        const address =
          typeof resolved === "string"
            ? resolved
            : (resolved.find((entry) => entry.family === 4) ?? resolved[0])?.address;
        if (!address || !isIP(address))
          return done(new Error("Tool endpoint did not resolve"), null);
        // Authorized loopback, LAN, Docker and tailnet endpoints stay reachable
        // on this host. Their authorization remains the guarded caller's job.
        if (isPrivateAddress(address)) {
          direct(
            { ...options, hostname: address, servername: options.servername || hostname },
            done,
          );
          return;
        }
        void SocksClient.createConnection({
          proxy,
          command: "connect",
          destination: {
            host: address,
            port: Number(options.port || (options.protocol === "https:" ? 443 : 80)),
          },
          timeout: CONNECT_TIMEOUT_MS,
        }).then(
          ({ socket: connected }) => {
            socket = connected;
            if (finished) return connected.destroy();
            connected.setNoDelay(true);
            connected.setKeepAlive(true, 60_000);
            if (options.protocol === "https:") tls({ ...options, httpSocket: connected }, done);
            else done(null, connected);
          },
          () => done(new Error("Tool egress proxy connection failed"), null),
        );
      });
    },
  });
}

function parseToolProxy(value: string) {
  try {
    const url = new URL(value);
    if (
      !["socks5:", "socks5h:"].includes(url.protocol) ||
      !url.hostname ||
      url.search ||
      url.hash ||
      (url.pathname && url.pathname !== "/")
    )
      throw new Error();
    const port = Number(url.port || 1080);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
    return {
      host: url.hostname.replace(/^\[|\]$/g, ""),
      port,
      type: 5 as const,
      userId: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };
  } catch {
    // Never echo a proxy URL: it can contain credentials.
    throw new Error("TOOL_EGRESS_PROXY_URL must be a valid SOCKS5 proxy URL");
  }
}

let shared: { url: string; agent: Agent } | undefined;

/** For fixed provider API URLs (SDKs and token requests). Unconfigured deployments
 * keep their original fetch. URL-controlled web/MCP calls use guarded agents. */
export const connectorFetch: typeof globalThis.fetch = async (input, init) => {
  const url = toolEgressProxyUrl();
  if (!url) return globalThis.fetch(input, init);
  if (shared?.url !== url) {
    const previous = shared;
    shared = { url, agent: createToolAgent() };
    void previous?.agent.destroy().catch(() => undefined);
  }
  // The package fetch and dispatcher must come from the same undici version.
  // Request objects from SDKs are re-created in the package's realm too.
  if (input instanceof Request) {
    const request = new Request(input, init);
    return dispatcherFetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
      signal: request.signal,
      redirect: request.redirect,
      dispatcher: shared.agent,
    } as RequestInit & { dispatcher: Agent });
  }
  return dispatcherFetch(input, { ...init, dispatcher: shared.agent } as RequestInit & {
    dispatcher: Agent;
  });
};

export async function closeToolEgress(): Promise<void> {
  const current = shared;
  shared = undefined;
  await current?.agent.destroy();
}
