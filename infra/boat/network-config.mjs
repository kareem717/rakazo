import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  computerEgressPolicy,
  parseEgressConfig,
  readEgressConfig,
} from "../../packages/adapters/src/egress-config.ts";

export function gatewayEgressConfig(source = process.env) {
  if (source.RAKAZO_NETWORK_CONFIG !== undefined) {
    if (!source.RAKAZO_NETWORK_CONFIG.trim())
      throw new Error("Network egress config path is empty");
    return readEgressConfig(source.RAKAZO_NETWORK_CONFIG);
  }
  // Old deployments retain their existing routing until explicitly migrated.
  if (source.BROWSER_PROXY_SSH_TARGET)
    return parseEgressConfig({
      version: 1,
      mode: "tools",
      transport: { type: "ssh", target: source.BROWSER_PROXY_SSH_TARGET, tailscale: true },
    });
  return readEgressConfig();
}

export function policyDigest(config) {
  return createHash("sha256")
    .update(JSON.stringify(computerEgressPolicy(config)))
    .digest("hex");
}

function quote(value) {
  return "'" + String(value).replaceAll("'", "'\\''") + "'";
}

export function gatewayEnvironment(config) {
  const transport = config.mode === "direct" ? undefined : config.transport;
  const proxy = transport?.type === "socks5" ? new URL(transport.url) : undefined;
  return (
    Object.entries({
      EGRESS_MODE: config.mode,
      EGRESS_TRANSPORT: transport?.type ?? "direct",
      EGRESS_USE_TAILSCALE:
        transport?.type === "tailscale-exit-node" ||
        (transport?.type === "ssh" && transport.tailscale)
          ? "true"
          : "false",
      EGRESS_SSH_TARGET: transport?.type === "ssh" ? transport.target : "",
      EGRESS_EXIT_NODE: transport?.type === "tailscale-exit-node" ? transport.exitNode : "",
      EGRESS_PROXY_HOST: proxy?.hostname ?? "",
      EGRESS_PROXY_PORT: proxy?.port || "1080",
    })
      .map(([key, value]) => `${key}=${quote(value)}`)
      .join("\n") + "\n"
  );
}

export { computerEgressPolicy };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const config = gatewayEgressConfig();
    if (process.argv[2] === "--check")
      console.log(`Network egress configuration is valid (${config.mode})`);
    else
      await writeFile(process.argv[2] ?? "/state/egress.env", gatewayEnvironment(config), {
        mode: 0o600,
      });
  } catch {
    console.error("Invalid network egress configuration; gateway did not start");
    process.exitCode = 1;
  }
}
