import type { EgressConfig, EgressMode } from "./network-egress.js";
import { parseEgressConfig } from "./network-egress.js";

export type NetworkSettingsDraft = {
  mode: EgressMode;
  transport: "ssh" | "socks5";
  target: string;
  url: string;
  exitNode: string;
  tailscale: boolean;
};
export function networkSettingsDraft(config: EgressConfig): NetworkSettingsDraft {
  const transport = config.mode === "direct" ? undefined : config.transport;
  return {
    mode: config.mode,
    transport: transport?.type === "socks5" ? "socks5" : "ssh",
    target: transport?.type === "ssh" ? transport.target : "",
    tailscale: transport?.type === "ssh" ? transport.tailscale : false,
    url: transport?.type === "socks5" ? transport.url : "",
    exitNode: transport?.type === "tailscale-exit-node" ? transport.exitNode : "",
  };
}
export function networkConfigFromDraft(draft: NetworkSettingsDraft): EgressConfig | null {
  try {
    return parseEgressConfig(
      draft.mode === "direct"
        ? { version: 1, mode: "direct" }
        : {
            version: 1,
            mode: draft.mode,
            transport:
              draft.mode === "all"
                ? { type: "tailscale-exit-node", exitNode: draft.exitNode.trim() }
                : draft.transport === "ssh"
                  ? { type: "ssh", target: draft.target.trim(), tailscale: draft.tailscale }
                  : { type: "socks5", url: draft.url.trim() },
          },
    );
  } catch {
    return null;
  }
}
