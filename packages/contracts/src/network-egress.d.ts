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

export function parseEgressConfig(input: unknown): EgressConfig;
export function egressProxyUrl(config: EgressConfig): string | undefined;
export function computerEgressPolicy(config: EgressConfig): {
  version: 1;
  mode: EgressMode;
  proxyUrl?: string;
};
