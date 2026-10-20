import assert from "node:assert/strict";
import test from "node:test";
import { connectionStatus, createControlServer } from "./tailscale-control.mjs";

test("returns only owner connection metadata and advertised exit nodes", () => {
  const value = connectionStatus({
    BackendState: "Running",
    AuthURL: "https://login.tailscale.com/a/abc123",
    PrivateKey: "secret",
    User: { email: "private@example.test" },
    CurrentTailnet: { Name: "example.test" },
    Peer: {
      ordinary: { DNSName: "other.example.ts.net.", Online: true },
      exit: { DNSName: "exit.example.ts.net.", Online: true, ExitNodeOption: true, Key: "secret" },
    },
  });
  assert.deepEqual(value, {
    available: true,
    provider: "tailscale",
    state: "connected",
    tailnet: "example.test",
    authUrl: null,
    exitNodes: [{ name: "exit.example.ts.net", value: "exit.example.ts.net", online: true }],
  });
  for (const AuthURL of [
    "https://evil.example/a/abc",
    "javascript:alert(1)",
    "https://login.tailscale.com.evil.example/a/abc",
    "https://login.tailscale.com/a/abc?redirect=evil",
    "https://user:pass@login.tailscale.com/a/abc",
  ]) {
    assert.equal(connectionStatus({ BackendState: "NeedsLogin", AuthURL }).authUrl, null);
  }
  assert.equal(
    connectionStatus({
      BackendState: "NeedsLogin",
      AuthURL: "https://login.tailscale.com/a/abc123",
    }).authUrl,
    "https://login.tailscale.com/a/abc123",
  );
});

async function fixture(t, api) {
  const server = createControlServer(api);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return async (path, method = "GET", headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers,
    });
    return { code: response.status, body: await response.json() };
  };
}
test("connect is idempotent for connected and approval-pending identities", async (t) => {
  for (const BackendState of ["Running", "NeedsMachineAuth"]) {
    const calls = [];
    const request = await fixture(t, async (path) => {
      calls.push(path);
      return { BackendState };
    });
    assert.equal((await request("/tailscale/connect", "POST")).code, 200);
    assert.deepEqual(calls, ["status"]);
  }
});
test("starts device authorization without accepting host commands or auth keys", async (t) => {
  const calls = [];
  let authorized = false;
  const request = await fixture(t, async (...args) => {
    calls.push(args);
    if (args[0] === "login-interactive") authorized = true;
    return {
      BackendState: "NeedsLogin",
      ...(authorized ? { AuthURL: "https://login.tailscale.com/a/abc123" } : {}),
    };
  });
  const response = await request("/tailscale/connect", "POST");
  assert.equal(response.body.authUrl, "https://login.tailscale.com/a/abc123");
  assert.deepEqual(
    calls.map((c) => c[0]),
    ["status", "prefs", "start", "status", "login-interactive", "status"],
  );
  assert.equal(calls[1][2].NetfilterMode, 0);
  assert.equal(calls[1][2].CorpDNS, false);
  assert.deepEqual(calls[2], ["start", "POST", {}]);
  assert.equal((await request("/localapi/v0/logout", "POST")).code, 404);
  assert.equal((await request("/tailscale/connect", "GET")).code, 404);
  assert.equal(
    (await request("/tailscale/connect", "POST", { Origin: "https://evil.example" })).code,
    403,
  );
});
test("redacts daemon errors and keeps enrollment health separate from route readiness", async (t) => {
  const request = await fixture(t, async () => {
    throw new Error("private path and secret");
  });
  assert.deepEqual(await request("/tailscale"), {
    code: 503,
    body: { error: "Network gateway unavailable" },
  });
  assert.equal((await request("/health")).code, 503);
  const fresh = await fixture(t, async () => ({ BackendState: "NeedsLogin" }));
  assert.equal((await fresh("/health")).code, 200);
});
