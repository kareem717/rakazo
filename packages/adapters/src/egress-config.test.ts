import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activeEgressConfig,
  egressProxyUrl,
  parseEgressConfig,
  readEgressConfig,
  toolEgressProxyUrl,
} from "./egress-config.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function configFile(value: unknown) {
  const directory = mkdtempSync(path.join(tmpdir(), "egress-config-"));
  directories.push(directory);
  const file = path.join(directory, "network.json");
  writeFileSync(file, JSON.stringify(value));
  return file;
}

describe("network egress configuration", () => {
  it("uses the gateway snapshot after a partial API restart while edits stay pending", () => {
    const saved = configFile({
      version: 1,
      mode: "all",
      transport: { type: "tailscale-exit-node", exitNode: "exit.example.ts.net" },
    });
    const active = configFile({
      version: 1,
      mode: "tools",
      transport: { type: "ssh", target: "proxy@egress.example.test", tailscale: true },
    });
    expect(activeEgressConfig(saved, active).mode).toBe("tools");
    expect(
      toolEgressProxyUrl({ RAKAZO_NETWORK_CONFIG: saved, RAKAZO_NETWORK_ACTIVE_CONFIG: active }),
    ).toBe("socks5://10.202.0.1:1080");
    expect(() =>
      toolEgressProxyUrl({
        RAKAZO_NETWORK_CONFIG: saved,
        RAKAZO_NETWORK_ACTIVE_CONFIG: active + ".missing",
      }),
    ).toThrow();
  });
  it("keeps the core product direct when no network config is selected", () => {
    expect(readEgressConfig()).toEqual({ version: 1, mode: "direct" });
    expect(toolEgressProxyUrl({})).toBeUndefined();
  });

  it("supports an external SOCKS proxy without Tailscale or SSH", () => {
    const config = parseEgressConfig({
      version: 1,
      mode: "browser",
      transport: { type: "socks5", url: "socks5://proxy.example.test:1080" },
    });
    expect(egressProxyUrl(config)).toBe("socks5://proxy.example.test:1080");
  });

  it("makes the same SSH transport work with or without Tailscale", () => {
    for (const tailscale of [false, true]) {
      const config = parseEgressConfig({
        version: 1,
        mode: "tools",
        transport: { type: "ssh", target: "proxy@egress.example.test", tailscale },
      });
      expect(egressProxyUrl(config)).toBe("socks5://10.202.0.1:1080");
    }
  });

  it("only proxies backend tools in tools mode, overriding legacy configuration", () => {
    for (const mode of ["direct", "browser", "tools", "all"] as const) {
      const config =
        mode === "direct"
          ? { version: 1, mode }
          : mode === "all"
            ? {
                version: 1,
                mode,
                transport: { type: "tailscale-exit-node", exitNode: "exit.example.ts.net" },
              }
            : {
                version: 1,
                mode,
                transport: { type: "socks5", url: "socks5://proxy.example.test:1080" },
              };
      expect(
        toolEgressProxyUrl({
          RAKAZO_NETWORK_CONFIG: configFile(config),
          TOOL_EGRESS_PROXY_URL: "socks5://legacy.example.test:1080",
        }),
      ).toBe(mode === "tools" ? "socks5://proxy.example.test:1080" : undefined);
    }
  });

  it("keeps routing stable until the deployment restarts", () => {
    const file = configFile({
      version: 1,
      mode: "tools",
      transport: { type: "socks5", url: "socks5://proxy.example.test:1080" },
    });
    expect(toolEgressProxyUrl({ RAKAZO_NETWORK_CONFIG: file })).toBe(
      "socks5://proxy.example.test:1080",
    );
    writeFileSync(file, JSON.stringify({ version: 1, mode: "direct" }));
    expect(toolEgressProxyUrl({ RAKAZO_NETWORK_CONFIG: file })).toBe(
      "socks5://proxy.example.test:1080",
    );
  });

  it("retains the existing tool proxy variable until a config file is explicitly selected", () => {
    expect(toolEgressProxyUrl({ TOOL_EGRESS_PROXY_URL: "socks5://legacy.example.test:1080" })).toBe(
      "socks5://legacy.example.test:1080",
    );
  });

  it.each([
    {},
    { version: 2, mode: "direct" },
    { version: 1, mode: "typo" },
    { version: 1, mode: "direct", transport: {} },
    { version: 1, mode: "tools", transport: { type: "ssh", target: "-oProxyCommand=bad" } },
    { version: 1, mode: "tools", transport: { type: "ssh", target: "proxy@host;bad" } },
    {
      version: 1,
      mode: "browser",
      transport: { type: "socks5", url: "https://proxy.example.test" },
    },
    {
      version: 1,
      mode: "browser",
      transport: { type: "socks5", url: "socks5://proxy.example.test/#fragment" },
    },
    { version: 1, mode: "all", transport: { type: "socks5", url: "socks5://proxy.example.test" } },
    { version: 1, mode: "all", transport: { type: "tailscale-exit-node", exitNode: "exit;bad" } },
    { version: 1, mode: "direct", unexpected: true },
  ])("refuses malformed or unsupported policy instead of falling back directly", (config) => {
    expect(() => parseEgressConfig(config)).toThrow();
  });

  it("fails closed for unreadable, empty and invalid explicit config paths", () => {
    for (const selected of ["", "/nonexistent/network.json", configFile({ mode: "wrong" })]) {
      expect(() =>
        toolEgressProxyUrl({
          RAKAZO_NETWORK_CONFIG: selected,
          TOOL_EGRESS_PROXY_URL: "socks5://legacy.example.test",
        }),
      ).toThrow();
    }
  });

  it("never includes protected values in validation errors", () => {
    const secret = "fake-proxy-password";
    try {
      parseEgressConfig({
        version: 1,
        mode: "tools",
        transport: { type: "socks5", url: `https://user:${secret}@proxy.example.test` },
      });
      throw new Error("Expected validation failure");
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});
