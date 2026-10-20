import { readFileSync } from "node:fs";
import type { EgressConfig } from "../../contracts/src/network-egress.js";
import { egressProxyUrl, parseEgressConfig } from "../../contracts/src/network-egress.js";

export type {
  EgressConfig,
  EgressMode,
  EgressTransport,
} from "../../contracts/src/network-egress.js";
export {
  computerEgressPolicy,
  egressProxyUrl,
  parseEgressConfig,
} from "../../contracts/src/network-egress.js";

/** No config means normal networking. An explicitly configured file must be valid. */
export function readEgressConfig(path?: string): EgressConfig {
  if (!path) return { version: 1, mode: "direct" };
  try {
    return parseEgressConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    throw new Error("Unable to load valid network egress configuration");
  }
}

/** Shared web/MCP/connector routing. Full mode is enforced by the network namespace. */
export function toolEgressProxyUrl(source: NodeJS.ProcessEnv = process.env): string | undefined {
  if (source.RAKAZO_NETWORK_CONFIG !== undefined) {
    if (!source.RAKAZO_NETWORK_CONFIG.trim())
      throw new Error("Network egress config path is empty");
    const config = activeEgressConfig(
      source.RAKAZO_NETWORK_CONFIG,
      source.RAKAZO_NETWORK_ACTIVE_CONFIG ?? source.RAKAZO_NETWORK_CONFIG,
    );
    return config.mode === "tools" ? egressProxyUrl(config) : undefined;
  }
  return source.TOOL_EGRESS_PROXY_URL || undefined;
}

// A routing change is applied by restarting the deployment, not by racing requests
// against a file edit while its network namespace still has the previous policy.
const configurations = new Map<string, EgressConfig>();
export function activeEgressConfig(
  path: string,
  activePath = process.env.RAKAZO_NETWORK_ACTIVE_CONFIG ?? path,
): EgressConfig {
  if (!activePath.trim()) throw new Error("Active network config path is empty");
  let config = configurations.get(activePath);
  if (!config) {
    config = readEgressConfig(activePath);
    configurations.set(activePath, config);
  }
  return config;
}
if (process.env.RAKAZO_NETWORK_CONFIG !== undefined) {
  if (!process.env.RAKAZO_NETWORK_CONFIG.trim())
    throw new Error("Network egress config path is empty");
  activeEgressConfig(process.env.RAKAZO_NETWORK_CONFIG);
}
