import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  computerEgressPolicy,
  gatewayEgressConfig,
  gatewayEnvironment,
  policyDigest,
} from "./network-config.mjs";

test("no optional transport starts for direct egress", () => {
  const config = gatewayEgressConfig({});
  assert.deepEqual(config, { version: 1, mode: "direct" });
  const env = gatewayEnvironment(config);
  assert.match(env, /EGRESS_USE_TAILSCALE='false'/);
  assert.match(env, /EGRESS_TRANSPORT='direct'/);
});

test("legacy SSH deployments retain tools routing until explicitly migrated", () => {
  assert.deepEqual(
    gatewayEgressConfig({ BROWSER_PROXY_SSH_TARGET: "proxy@egress.example.ts.net" }),
    {
      version: 1,
      mode: "tools",
      transport: { type: "ssh", target: "proxy@egress.example.ts.net", tailscale: true },
    },
  );
});

test("Tailscale is optional for SSH and independent from the routing scope", () => {
  for (const mode of ["browser", "tools"])
    for (const tailscale of [false, true]) {
      const config = {
        version: 1,
        mode,
        transport: { type: "ssh", target: "proxy@egress.example.test", tailscale },
      };
      const env = gatewayEnvironment(config);
      const value = execFileSync(
        "sh",
        ["-c", env + 'printf "%s:%s" "$EGRESS_MODE" "$EGRESS_USE_TAILSCALE"'],
        { encoding: "utf8" },
      );
      assert.equal(value, `${mode}:${tailscale}`);
      assert.deepEqual(computerEgressPolicy(config), {
        version: 1,
        mode,
        proxyUrl: "socks5://10.202.0.1:1080",
      });
    }
});

test("external SOCKS and full exit nodes have different process plans", () => {
  const external = gatewayEnvironment({
    version: 1,
    mode: "tools",
    transport: { type: "socks5", url: "socks5://[2001:db8::1]:1081" },
  });
  assert.match(external, /EGRESS_PROXY_HOST='\[2001:db8::1\]'/);
  assert.match(external, /EGRESS_PROXY_PORT='1081'/);
  assert.match(external, /EGRESS_USE_TAILSCALE='false'/);
  const full = {
    version: 1,
    mode: "all",
    transport: { type: "tailscale-exit-node", exitNode: "exit.example.ts.net" },
  };
  assert.match(gatewayEnvironment(full), /EGRESS_USE_TAILSCALE='true'/);
  assert.match(gatewayEnvironment(full), /EGRESS_EXIT_NODE='exit.example.ts.net'/);
  assert.deepEqual(computerEgressPolicy(full), { version: 1, mode: "all" });
});

test("each routing mode changes its readiness digest, without copying gateway identities to guests", () => {
  const first = {
    version: 1,
    mode: "tools",
    transport: { type: "ssh", target: "proxy@one.example.test", tailscale: true },
  };
  const second = { ...first, transport: { ...first.transport, target: "proxy@two.example.test" } };
  assert.equal(policyDigest(first), policyDigest(second));
  assert.notEqual(policyDigest(first), policyDigest({ ...first, mode: "browser" }));
  assert.doesNotMatch(JSON.stringify(computerEgressPolicy(first)), /one.example/);
});
