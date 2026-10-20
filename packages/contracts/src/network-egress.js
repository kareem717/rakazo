// Shared with the standalone gateway; keep this module dependency-free.
const MODES = new Set(["direct", "browser", "tools", "all"]);
const INTERNAL_SOCKS_URL = "socks5://10.202.0.1:1080";

function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Network egress configuration must be an object");
  }
  return value;
}

function keys(value, allowed) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error("Unknown network egress configuration field");
  }
}

/** Errors intentionally omit configuration values, which can contain credentials. */
export function parseEgressConfig(input) {
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
  const mode = value.mode;
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

export function egressProxyUrl(config) {
  if (config.mode === "direct" || config.mode === "all") return undefined;
  return config.transport.type === "ssh" ? INTERNAL_SOCKS_URL : config.transport.url;
}

/** Computers reach all selective transports through the gateway's private listener. */
export function computerEgressPolicy(config) {
  return {
    version: 1,
    mode: config.mode,
    ...(config.mode === "browser" || config.mode === "tools"
      ? { proxyUrl: INTERNAL_SOCKS_URL }
      : {}),
  };
}
