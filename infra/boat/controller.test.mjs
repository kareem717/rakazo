import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import https from "node:https";
import test, { mock } from "node:test";
import {
  assertModeTransition,
  assertNetworkApplyStopped,
  clientConfig,
  configuredBootstrap,
  ensureNetworkEgress,
  gatewayErrorStatus,
  protectedCreate,
  retryRead,
  runGuardedBootstrap,
  shellQuote,
} from "./controller.mjs";

test("provisioning forces the dedicated credential-free environment and removes unrelated injected variables", () => {
  assert.deepEqual(
    protectedCreate({
      noEnv: false,
      environment: "base",
      ttlSeconds: 7200,
      env: { RAKAZO_BOT_ID: "fake-bot", SECRET: "fake-value" },
    }),
    {
      noEnv: true,
      environment: "rakazo",
      ttlSeconds: 7200,
      env: { RAKAZO_BOT_ID: "fake-bot", RAKAZO_SANDBOX: "computer" },
    },
  );
});
test("missing or malformed bot identities refuse provisioning", () => {
  for (const body of [{}, { env: { RAKAZO_BOT_ID: "../other" } }, { env: { RAKAZO_BOT_ID: "" } }])
    assert.throws(() => protectedCreate(body));
});
test("each tunnel routes only the private browser proxy and reserves the gateway address", () => {
  const config = clientConfig("fake-private", "fake-public", 2);
  assert.match(config, /Address = 10\.202\.0\.2\/32, fd42:202:7261::2\/128/);
  assert.match(config, /Table = auto/);
  assert.match(config, /AllowedIPs = 10\.202\.0\.1\/32/);
  assert.throws(() => clientConfig("a", "b", 1));
  assert.throws(() => clientConfig("a", "b", 251));
});

test("transient reads retry without repeating mutations", async () => {
  let reads = 0;
  assert.equal(
    await retryRead(
      async () => {
        if (++reads < 3) throw new Error("connection lost");
        return "recovered";
      },
      "GET",
      async () => {},
    ),
    "recovered",
  );
  assert.equal(reads, 3);
  let writes = 0;
  await assert.rejects(
    retryRead(
      async () => {
        writes++;
        throw new Error("uncertain create");
      },
      "POST",
      async () => {},
    ),
  );
  assert.equal(writes, 1);
});
test("authorization failures do not retry", async () => {
  let calls = 0;
  await assert.rejects(
    retryRead(
      async () => {
        calls++;
        throw Object.assign(new Error("forbidden"), { status: 403 });
      },
      "GET",
      async () => {},
    ),
  );
  assert.equal(calls, 1);
});

test("bootstrap scripts keep shell metacharacters literal", () => {
  const value = "quote'\n$(printf expanded)`printf expanded`";
  assert.equal(
    execFileSync("sh", ["-c", "printf %s " + shellQuote(value)], { encoding: "utf8" }),
    value,
  );
});

test("gateway preserves provider not-found so completed deletes reconcile successfully", () => {
  assert.equal(gatewayErrorStatus({ status: 404 }), 404);
  assert.equal(gatewayErrorStatus({ status: 403 }), 403);
  assert.equal(gatewayErrorStatus(new Error("network failure")), 503);
  assert.equal(gatewayErrorStatus({ status: 200 }), 503);
});

test("full egress puts both IP families through the computer tunnel", () => {
  const config = clientConfig(
    "fake-private",
    "fake-public",
    2,
    {
      version: 1,
      mode: "all",
      transport: { type: "tailscale-exit-node", exitNode: "exit.example.ts.net" },
    },
    "192.0.2.1:51871",
  );
  assert.match(config, /AllowedIPs = 0\.0\.0\.0\/0, ::\/0/);
  assert.match(config, /Endpoint = 192\.0\.2\.1:51871/);
  assert.match(config, /FwMark = 0x51821/);
});

test("a configured policy checks kernel readiness without uploading again", async () => {
  const calls = [];
  const config = { version: 1, mode: "direct" };
  assert.equal(
    await ensureNetworkEgress(
      async (script) => calls.push(script),
      config,
      () => {
        throw Error("unexpected upload");
      },
    ),
    false,
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0], /policy-digest/);
  assert.match(calls[0], /egress.sh --check/);
});

test("policy repair passes the selected mode and enforcement through one guarded install", async () => {
  const calls = [];
  const config = {
    version: 1,
    mode: "browser",
    transport: { type: "ssh", target: "proxy@egress.example.test", tailscale: false },
  };
  assert.equal(
    await ensureNetworkEgress(
      async (script) => {
        calls.push(script);
        if (calls.length === 1) throw Error("stale");
      },
      config,
      async () => 'printf "%s:%s" "$RAKAZO_EGRESS_MODE" "$RAKAZO_EGRESS_SCRIPT"',
      async () => "literal'$(printf wrong)",
    ),
    true,
  );
  assert.equal(calls.length, 3);
  assert.match(calls[1], /-- --egress-only$/);
  const output = execFileSync("sh", ["-c", calls[1].replace("sudo -n ", "")], { encoding: "utf8" });
  assert.equal(output, "browser:literal'$(printf wrong)");
  assert.match(calls[2], /egress.sh --check/);
});

test("failed policy installation never publishes a ready digest or retries uncertain writes", async () => {
  let calls = 0;
  await assert.rejects(
    ensureNetworkEgress(
      async () => {
        calls++;
        throw Error("offline");
      },
      { version: 1, mode: "direct" },
      async () => "fake",
      async () => "fake",
    ),
    /offline/,
  );
  assert.equal(calls, 2);
});

test("routing-mode changes reject active computers before changing network namespaces", async () => {
  for (const state of ["ready", "idle", "running", "starting", "unknown"]) {
    await assert.rejects(
      assertModeTransition({ fake: { egressMode: "tools" } }, "all", async () => ({ state })),
      /Stop computers/,
    );
  }
});

test("stopped computers accept mode changes and unchanged modes do not need a provider read", async () => {
  await assertModeTransition({ fake: { egressMode: "all" } }, "browser", async () => ({
    state: "archived",
  }));
  await assertModeTransition({ fake: { egressMode: "tools" } }, "tools", async () => {
    throw Error("must not inspect");
  });
  await assertModeTransition({ legacy: {} }, "tools", async () => {
    throw Error("must not inspect legacy tools");
  });
  await assert.rejects(
    assertModeTransition({ fake: { egressMode: "tools" } }, "direct", async () => {
      throw Error("provider unavailable");
    }),
    /provider unavailable/,
  );
});

test("bootstrap generation preserves mode and script as literal configuration", () => {
  const script = configuredBootstrap(
    { version: 1, mode: "direct" },
    'printf %s "$RAKAZO_EGRESS_SCRIPT"',
    "value'`printf expanded`",
  );
  assert.equal(
    execFileSync("bash", ["-c", script], { encoding: "utf8" }),
    "value'`printf expanded`",
  );
});

test("guarded bootstrap submits one command and reads its response without replay", async () => {
  let calls = 0;
  let payload;
  const stub = mock.method(https, "request", (url, options, onResponse) => {
    calls++;
    assert.equal(new URL(url).pathname, "/api/v1/sandboxes/fake-computer/commands");
    assert.equal(options.method, "POST");
    const request = new EventEmitter();
    request.destroy = (error) => request.emit("error", error);
    request.end = (body) => {
      payload = JSON.parse(body);
      queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = 200;
        onResponse(response);
        response.emit("data", Buffer.from(JSON.stringify({ exitCode: 0 })));
        response.emit("end");
        request.emit("close");
      });
    };
    return request;
  });
  try {
    assert.deepEqual(await runGuardedBootstrap("fake-computer"), { exitCode: 0 });
    assert.equal(calls, 1);
    assert.deepEqual(payload, {
      command: "sudo -n bash /home/user/.rakazo-network/bootstrap.sh",
      timeoutSeconds: 600,
    });
  } finally {
    stub.mock.restore();
  }
});

test("network apply refuses live computers and unresolved provisioning even when mode is unchanged", async () => {
  await assert.rejects(
    () => assertNetworkApplyStopped({ vm: {} }, {}, async () => ({ state: "running" })),
    /Stop computers/,
  );
  await assert.rejects(
    () =>
      assertNetworkApplyStopped({}, { bot: { phase: "intent" } }, async () => ({
        state: "stopped",
      })),
    /pending/,
  );
  await assertNetworkApplyStopped({ vm: {} }, { bot: { phase: "created" } }, async () => ({
    state: "stopped",
  }));
});
