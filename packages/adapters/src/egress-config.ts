import { readFileSync } from "node:fs";

export type EgressMode = "direct" | "browser" | "tools" | "all";

export type EgressTransport =
  | { type: "socks5"; url: string }
  | { type: "ssh"; target: string; tailscale: boolean }
  | { type: "tailscale-exit-node"; exitNode: string };

export type EgressConfig =
  | { version: 1; mode: "direct" }
  | {
      version: 1;
      mode: "browser" | "tools";
      transport: Exclude<EgressTransport, { type: "tailscale-exit-node" }>;
    }
  | {
      version: 1;
      mode: "all";
      transport: Extract<EgressTransport, { type: "tailscale-exit-node" }>;
    };

const MODES = new Set(["direct", "browser", "tools", "all"]);
const INTERNAL_SOCKS_URL = "socks5://10.202.0.1:1080";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Network egress configuration must be an object");
  }
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error("Unknown network egress configuration field");
  }
}

/** Errors intentionally omit configuration values, which can contain credentials. */
export function parseEgressConfig(input: unknown): EgressConfig {
  const value = object(input);
  keys(value, ["version", "mode", "transport"]);
  if (value.version !== 1 || typeof value.mode !== "string" || !MODES.has(value.mode)) {
    throw new Error("Network egress requires version 1 and a valid mode");
  }
  if (value.mode === "direct") {
    if (value.transport !== undefined) throw new Error("Direct egress does not use a transport");
    return { version: 1, mode: "direct" };
  }
  const transport = object(value.transport);
  if (value.mode === "all") {
    keys(transport, ["type", "exitNode"]);
    if (
      transport.type !== "tailscale-exit-node" ||
      typeof transport.exitNode !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9.:_-]{0,252}$/.test(transport.exitNode)
    ) {
      throw new Error("All egress requires a configured Tailscale exit node");
    }
    return {
      version: 1,
      mode: "all",
      transport: { type: "tailscale-exit-node", exitNode: transport.exitNode },
    };
  }
  const mode = value.mode as "browser" | "tools";
  if (transport.type === "socks5") {
    keys(transport, ["type", "url"]);
    try {
      if (typeof transport.url !== "string") throw new Error();
      const url = new URL(transport.url);
      if (
        !["socks5:", "socks5h:"].includes(url.protocol) ||
        !url.hostname ||
        url.search ||
        url.hash ||
        url.username ||
        url.password ||
        (url.pathname && url.pathname !== "/") ||
        (url.port && (Number(url.port) < 1 || Number(url.port) > 65535))
      )
        throw new Error();
      // Validate percent escapes before a request can discover malformed credentials.
      decodeURIComponent(url.username);
      decodeURIComponent(url.password);
      return { version: 1, mode, transport: { type: "socks5", url: url.toString() } };
    } catch {
      throw new Error("Network egress requires a valid SOCKS5 URL");
    }
  }
  if (transport.type === "ssh") {
    keys(transport, ["type", "target", "tailscale"]);
    if (
      typeof transport.target !== "string" ||
      !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*@[a-zA-Z0-9][a-zA-Z0-9.:-]{0,252}$/.test(transport.target) ||
      (transport.tailscale !== undefined && typeof transport.tailscale !== "boolean")
    )
      throw new Error("Network egress requires a valid SSH target");
    return {
      version: 1,
      mode,
      transport: { type: "ssh", target: transport.target, tailscale: transport.tailscale ?? false },
    };
  }
  throw new Error("Browser and tool egress require a SOCKS5 or SSH transport");
}

/** No config means normal networking. An explicitly configured file must be valid. */
export function readEgressConfig(path?: string): EgressConfig {
  if (!path) return { version: 1, mode: "direct" };
  try {
    return parseEgressConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    throw new Error("Unable to load valid network egress configuration");
  }
}

export function egressProxyUrl(config: EgressConfig): string | undefined {
  if (config.mode === "direct" || config.mode === "all") return undefined;
  return config.transport.type === "ssh" ? INTERNAL_SOCKS_URL : config.transport.url;
}

/** Computers reach all selective transports through the gateway's private listener. */
export function computerEgressPolicy(config: EgressConfig) {
  return {
    version: 1,
    mode: config.mode,
    ...(config.mode === "browser" || config.mode === "tools"
      ? { proxyUrl: INTERNAL_SOCKS_URL }
      : {}),
  };
}

/** Shared web/MCP/connector routing. Full mode is enforced by the network namespace. */
export function toolEgressProxyUrl(source: NodeJS.ProcessEnv = process.env): string | undefined {
  if (source.RAKAZO_NETWORK_CONFIG !== undefined) {
    if (!source.RAKAZO_NETWORK_CONFIG.trim())
      throw new Error("Network egress config path is empty");
    const config = configured(source.RAKAZO_NETWORK_CONFIG);
    return config.mode === "tools" ? egressProxyUrl(config) : undefined;
  }
  return source.TOOL_EGRESS_PROXY_URL || undefined;
}

// A routing change is applied by restarting the deployment, not by racing requests
// against a file edit while its network namespace still has the previous policy.
const configurations = new Map<string, EgressConfig>();
function configured(path: string): EgressConfig {
  let config = configurations.get(path);
  if (!config) {
    config = readEgressConfig(path);
    configurations.set(path, config);
  }
  return config;
}
if (process.env.RAKAZO_NETWORK_CONFIG !== undefined) {
  if (!process.env.RAKAZO_NETWORK_CONFIG.trim())
    throw new Error("Network egress config path is empty");
  configured(process.env.RAKAZO_NETWORK_CONFIG);
}
