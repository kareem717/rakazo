import { execFile } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import http from "node:http";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gatewayEgressConfig, policyDigest } from "./network-config.mjs";

const exec = promisify(execFile);
const root = "/state";
const upstream = "https://ascii.dev/api/box/v1";
const modern = "https://boat.dev/api/v1";
const environment = process.env.BOAT_ENVIRONMENT ?? "rakazo";
const environmentId = process.env.BOAT_ENVIRONMENT_ID;
const networkConfig = gatewayEgressConfig();
const networkDigest = policyDigest(networkConfig);
let wireguardEndpoint = process.env.BOAT_WIREGUARD_ENDPOINT ?? "vpn.example.com:51871";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let key, state;
const busy = new Map();
let saves = Promise.resolve();
let registrations = Promise.resolve();

export function gatewayErrorStatus(error) {
  return Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 503;
}

export function protectedCreate(body) {
  const botId = body?.env?.RAKAZO_BOT_ID;
  if (typeof botId !== "string" || !/^[a-zA-Z0-9_-]{1,150}$/.test(botId))
    throw new Error("missing valid bot identity");
  return {
    ...body,
    environment,
    noEnv: true,
    env: { RAKAZO_BOT_ID: botId, RAKAZO_SANDBOX: "computer" },
  };
}

export function clientConfig(
  privateKey,
  publicKey,
  index,
  config = networkConfig,
  endpoint = wireguardEndpoint,
) {
  if (!Number.isInteger(index) || index < 2 || index > 250)
    throw new Error("peer capacity exceeded");
  const routes = config.mode === "all" ? "0.0.0.0/0, ::/0" : "10.202.0.1/32";
  return `[Interface]\nPrivateKey = ${privateKey}\nAddress = 10.202.0.${index}/32, fd42:202:7261::${index.toString(16)}/128\nFwMark = 0x51821\nTable = auto\nMTU = 1280\n\n[Peer]\nPublicKey = ${publicKey}\nEndpoint = ${endpoint}\nAllowedIPs = ${routes}\nPersistentKeepalive = 25\n`;
}

function save() {
  const job = saves.then(async () => {
    await writeFile(`${root}/controller.json.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(`${root}/controller.json.tmp`, `${root}/controller.json`);
  });
  saves = job.catch(() => {});
  return job;
}

async function ready() {
  if (networkConfig.mode === "direct") return true;
  try {
    if (networkConfig.mode === "all") {
      const route = await exec("ip", ["-4", "route", "get", "1.1.1.1"]);
      if (!route.stdout.includes("dev tailscale0")) return false;
    }
    await exec(
      "curl",
      [
        ...(networkConfig.mode === "all"
          ? ["--noproxy", "*"]
          : ["--socks5-hostname", "10.202.0.1:1080"]),
        "--fail",
        "--silent",
        "--max-time",
        "15",
        "https://api.ipify.org",
      ],
      { timeout: 20000 },
    );
    return true;
  } catch {
    return false;
  }
}

export async function retryRead(operation, method = "GET", wait = sleep) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (
        method !== "GET" ||
        attempt >= 2 ||
        (error.status && ![429, 502, 503, 504].includes(error.status))
      )
        throw error;
      await wait(500 * 2 ** attempt);
    }
  }
}

async function api(
  path,
  { method = "GET", body, headers = {}, current = false, idempotent = false } = {},
) {
  return retryRead(
    async () => {
      const response = await fetch(`${current ? modern : upstream}${path}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(method === "GET" || idempotent ? 20000 : 650000),
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw Object.assign(new Error(`Boat HTTP ${response.status}`), { status: response.status });
      }
      return response.json();
    },
    idempotent ? "GET" : method,
  );
}

async function environmentSafe() {
  const d = await api("/environments", { current: true });
  const e = d.environments?.find((e) => e.id === environmentId);
  if (
    !e ||
    !e.safeForThirdParties ||
    e.proxyAiCredentials ||
    e.credentialProfileId ||
    e.envContents ||
    e.secretFiles?.length ||
    e.selectedRepositories?.length ||
    Object.values(e.effective ?? {}).some(Boolean) ||
    Object.keys(e.effective ?? {}).length !== 4
  ) {
    throw new Error("Boat environment safety check failed");
  }
}

async function command(id, command, timeoutSeconds = 60) {
  const d = await api(`/sandboxes/${id}/commands`, {
    current: true,
    method: "POST",
    body: { command, timeoutSeconds },
  });
  if (d.exitCode !== 0 || d.timedOut) throw new Error("VM command failed");
  return d.stdout;
}

async function addPeer(vm) {
  await exec("wg", [
    "set",
    "rakazo0",
    "peer",
    vm.publicKey,
    "allowed-ips",
    `10.202.0.${vm.index}/32,fd42:202:7261::${vm.index.toString(16)}/128`,
  ]);
}

async function bootstrapState(id, operation) {
  const script = await readFile("/deployment/bootstrap-probe.py", "utf8");
  return (
    await retryRead(() =>
      command(id, "sudo -n python3 -c " + shellQuote(script) + " " + shellQuote(operation), 15),
    )
  ).trim();
}

async function runGuardedBootstrap(id) {
  const body = JSON.stringify({
    command: "sudo -n bash /home/user/.rakazo-network/bootstrap.sh",
    timeoutSeconds: 600,
  });
  return new Promise((resolve, reject) => {
    const req = https.request(
      `${modern}/sandboxes/${id}/commands`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (response) => {
        const parts = [];
        let size = 0;
        response.on("data", (part) => {
          size += part.length;
          if (size > 4 * 1024 * 1024) req.destroy(new Error("Bootstrap response too large"));
          else parts.push(part);
        });
        response.on("error", reject);
        response.on("end", () => {
          if (response.statusCode < 200 || response.statusCode >= 300)
            return reject(
              Object.assign(new Error(`Boat HTTP ${response.statusCode}`), {
                status: response.statusCode,
              }),
            );
          try {
            resolve(JSON.parse(Buffer.concat(parts).toString("utf8")));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    const timer = setTimeout(
      () => req.destroy(new Error("Guarded bootstrap request timed out")),
      650000,
    );
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.end(body);
  });
}

async function bootstrap(id) {
  if (busy.has(id)) return busy.get(id);
  const job = bootstrapOnce(id).finally(() => busy.delete(id));
  busy.set(id, job);
  return job;
}

export function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export function configuredBootstrap(config, bootstrap, enforcement) {
  return `export RAKAZO_EGRESS_MODE=${shellQuote(config.mode)}\nexport RAKAZO_EGRESS_SCRIPT=${shellQuote(enforcement)}\n${bootstrap}`;
}

export async function ensureNetworkEgress(
  run,
  config,
  readBootstrap = () => readFile("/deployment/vm-bootstrap.sh", "utf8"),
  readEnforcement = () => readFile("/deployment/vm-egress.sh", "utf8"),
) {
  const digest = policyDigest(config);
  const check = `test "$(cat /etc/rakazo-network/policy-digest 2>/dev/null)" = ${shellQuote(digest)} && sudo -n /usr/local/lib/rakazo-network/egress.sh --check`;
  try {
    await run(check, 20);
    return false;
  } catch {
    /* Install or restore actual kernel policy. */
  }
  const script = configuredBootstrap(config, await readBootstrap(), await readEnforcement());
  await run(`sudo -n bash -c ${shellQuote(script)} -- --egress-only`, 600);
  await run(
    `sudo -n /usr/local/lib/rakazo-network/egress.sh --check && printf '%s\\n' ${shellQuote(digest)} | sudo -n tee /etc/rakazo-network/policy-digest >/dev/null`,
    20,
  );
  return true;
}

/** Browser policy and existing sockets must not straddle a routing-mode change. */
export async function assertModeTransition(vms, mode, inspect) {
  for (const [id, vm] of Object.entries(vms)) {
    if ((vm.egressMode ?? "tools") === mode) continue;
    const box = await inspect(id);
    if (!["archived", "stopped", "deleted"].includes(box.state)) {
      throw new Error("Stop computers before changing the network egress mode");
    }
  }
}

async function bootstrapOnce(id) {
  if (!(await ready())) throw new Error("Configured network egress is unavailable");
  const vm = state.vms[id];
  if (!vm) throw new Error("VM not registered");
  for (let attempt = 0; ; attempt++) {
    const d = await api(`/boxes/${id}`);
    if (["ready", "idle", "running"].includes(d.box.state) && d.box.environment) {
      if (d.box.environment !== environment || d.box.holdsCreatorLogins === true)
        throw new Error("VM environment mismatch");
      break;
    }
    if (attempt >= 150 || ["error", "archived"].includes(d.box.state))
      throw new Error("VM not ready");
    await sleep(2000);
  }
  await addPeer(vm);
  if (vm.phase === "ready") {
    if (
      vm.networkVersion >= 8 &&
      (vm.egressDigest === networkDigest || (!vm.egressDigest && networkConfig.mode !== "all"))
    ) {
      let browserReady = false;
      try {
        await verify(id);
        browserReady = true;
      } catch {
        /* Reapply the persistent kernel policy after resume. */
      }
      if (browserReady) {
        await ensureNetworkEgress((script, timeout) => command(id, script, timeout), networkConfig);
        vm.networkVersion = 9;
        vm.egressDigest = networkDigest;
        vm.egressMode = networkConfig.mode;
        await save();
        return;
      }
    }
    delete vm.bootstrapProcess;
    delete vm.bootstrapComplete;
    delete vm.bootstrapOperation;
    vm.phase = "created";
    await save();
  }
  if (!vm.bootstrapComplete) {
    if (!vm.bootstrapOperation) {
      if (vm.phase === "bootstrap-intent")
        throw new Error("Legacy uncertain bootstrap requires operator reconciliation");
      vm.bootstrapOperation = randomUUID();
      await save();
    }
    let status = await bootstrapState(id, vm.bootstrapOperation);
    if (status === "NOT_COMPLETE") {
      await retryRead(() =>
        command(
          id,
          "mkdir -p /home/user/.rakazo-network && chmod 700 /home/user/.rakazo-network",
          15,
        ),
      );
      const serverPublic = (await readFile(`${root}/wireguard/server.pub`, "utf8")).trim();
      const files = {
        "bootstrap-operation": vm.bootstrapOperation,
        hostname: "rakazo-" + id.replaceAll("_", "-"),
        "wireguard.conf": clientConfig(vm.privateKey, serverPublic, vm.index),
        "lock.sh": await readFile("/deployment/vm-lock.sh", "utf8"),
        "bootstrap.sh": configuredBootstrap(
          networkConfig,
          await readFile("/deployment/vm-bootstrap.sh", "utf8"),
          await readFile("/deployment/vm-egress.sh", "utf8"),
        ),
        "desktop-install.py": await readFile("/deployment/parallel-apt.py", "utf8"),
      };
      for (const [name, content] of Object.entries(files)) {
        await api(`/sandboxes/${id}/files`, {
          current: true,
          method: "PUT",
          idempotent: true,
          body: {
            path: `.rakazo-network/${name === "bootstrap.sh" ? "bootstrap.sh.next" : name}`,
            content,
            encoding: "utf8",
          },
        });
      }
      await retryRead(() =>
        command(
          id,
          "if [ -f /home/user/.rakazo-network/bootstrap.sh.next ]; then mv /home/user/.rakazo-network/bootstrap.sh.next /home/user/.rakazo-network/bootstrap.sh; fi",
          15,
        ),
      );
      vm.phase = "bootstrap-intent";
      await save();
      try {
        const result = await runGuardedBootstrap(id);
        if (result.exitCode !== 0 && result.exitCode !== 75)
          throw new Error("Guarded bootstrap returned a failure");
      } catch (error) {
        status = await bootstrapState(id, vm.bootstrapOperation);
        if (!["RUNNING", "COMPLETE"].includes(status)) throw error;
      }
    }
    for (let attempt = 0; ; attempt++) {
      status = await bootstrapState(id, vm.bootstrapOperation);
      if (status === "COMPLETE") break;
      if (status !== "RUNNING" || attempt >= 300)
        throw new Error("Guarded bootstrap incomplete; operation retained for safe recovery");
      await sleep(2000);
    }
    vm.bootstrapComplete = true;
    vm.phase = "bootstrapping";
    await save();
  }
  await verify(id);
  await ensureNetworkEgress((script, timeout) => command(id, script, timeout), networkConfig);
  vm.networkVersion = 9;
  vm.egressDigest = networkDigest;
  vm.egressMode = networkConfig.mode;
  vm.phase = "ready";
  vm.verifiedAt = new Date().toISOString();
  await save();
  console.log(JSON.stringify({ event: "vm.network.ready", id }));
}

async function verify(id) {
  const proxy =
    networkConfig.mode === "browser" || networkConfig.mode === "tools"
      ? "--socks5-hostname 10.202.0.1:1080"
      : "--noproxy '*'";
  await command(
    id,
    `curl ${proxy} --fail --silent --show-error --max-time 25 https://api.ipify.org && test -f /etc/chromium/policies/managed/rakazo-proxy.json`,
    35,
  );
}

function register(id, botId) {
  const job = registrations.then(() => registerOnce(id, botId));
  registrations = job.catch(() => {});
  return job;
}

async function registerOnce(id, botId) {
  if (state.vms[id]) return;
  const index = Math.max(1, ...Object.values(state.vms).map((v) => v.index)) + 1;
  if (index > 250) throw new Error("peer capacity exceeded");
  const privateKey = (await exec("wg", ["genkey"])).stdout.trim();
  const publicKey = await new Promise((resolve, reject) => {
    const p = execFile("wg", ["pubkey"], (e, stdout) => (e ? reject(e) : resolve(stdout.trim())));
    p.stdin.end(privateKey);
  });
  state.vms[id] = {
    index,
    botId,
    privateKey,
    publicKey,
    phase: "created",
    egressMode: networkConfig.mode,
  };
  await save();
}

async function create(body) {
  body = protectedCreate(body);
  await environmentSafe();
  const botId = body.env.RAKAZO_BOT_ID;
  let intent = state.bots[botId];
  if (intent?.id) {
    try {
      const d = await api(`/boxes/${intent.id}`);
      if (d.box.state === "archived") {
        const vm = state.vms[intent.id];
        vm.phase = "created";
        delete vm.bootstrapProcess;
        delete vm.bootstrapComplete;
        delete vm.bootstrapOperation;
        await save();
        await api(`/boxes/${intent.id}/resume`, {
          method: "POST",
          body: { noEnv: true, environment, ttlSeconds: 7200 },
        });
      }
      await bootstrap(intent.id);
      return { ok: true, type: "box.created", box: (await api(`/boxes/${intent.id}`)).box };
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  } else if (intent) throw new Error("Uncertain create intent requires operator reconciliation");
  intent = { operation: randomUUID(), phase: "intent" };
  state.bots[botId] = intent;
  await save();
  const result = await api("/boxes", {
    method: "POST",
    body,
    headers: { "Idempotency-Key": intent.operation },
  });
  if (!result.box?.id) throw new Error("Create response missing VM identity");
  intent.id = result.box.id;
  intent.phase = "created";
  await save();
  await register(intent.id, botId);
  await bootstrap(intent.id);
  return result;
}

function authorized(value) {
  const supplied = Buffer.from(value ?? "");
  const expected = Buffer.from(`Bearer ${key}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readBody(req) {
  const parts = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > 32 * 1024 * 1024) throw new Error("request too large");
    parts.push(part);
  }
  return parts.length ? Buffer.concat(parts) : undefined;
}

async function handler(req, res) {
  const json = (status, value) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(value));
  };
  try {
    if (req.url === "/health") {
      const available = await ready();
      return json(available ? 200 : 503, {
        ready: available,
        provider: "boat",
        mode: networkConfig.mode,
      });
    }
    if (!authorized(req.headers.authorization)) return json(401, { error: "unauthorized" });
    if (!(await ready())) return json(503, { error: "Configured network egress is unavailable" });
    const body = await readBody(req);
    if (req.url === "/admin/retry-bootstrap" && req.method === "POST") {
      const { id } = JSON.parse(body);
      const vm = state.vms[id];
      if (!vm || busy.has(id)) throw new Error("No idle bootstrap to reconcile");
      if (vm.bootstrapOperation) {
        if ((await bootstrapState(id, vm.bootstrapOperation)) === "RUNNING")
          throw new Error("Bootstrap is still running");
        await bootstrap(id);
        return json(200, { ready: true, id });
      }
      if (vm.phase !== "bootstrapping" || !vm.bootstrapProcess)
        throw new Error("No terminal legacy bootstrap to reconcile");
      const process = await api(`/sandboxes/${id}/commands/${vm.bootstrapProcess}?tailBytes=100`, {
        current: true,
      });
      if (process.running) throw new Error("Bootstrap is still running");
      delete vm.bootstrapProcess;
      vm.phase = "created";
      await save();
      await bootstrap(id);
      return json(200, { ready: true, id });
    }
    if (req.url === "/admin/adopt" && req.method === "POST") {
      const { id } = JSON.parse(body);
      if (!/^bx_[a-z0-9]+$/.test(id)) throw new Error("invalid ID");
      const d = await api(`/boxes/${id}`);
      if (d.box.environment !== environment) throw new Error("wrong environment");
      await register(id, "network-acceptance");
      await bootstrap(id);
      return json(200, { ready: true, id });
    }
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/api/box/v1/")) return json(404, { error: "not found" });
    const path = url.pathname.slice("/api/box/v1".length) + url.search;
    if (path === "/boxes" && req.method === "POST")
      return json(200, await create(JSON.parse(body)));
    const match = /^\/boxes\/(bx_[a-z0-9]+)(?:\/(.*))?$/.exec(
      url.pathname.slice("/api/box/v1".length),
    );
    if (match) {
      const [, id, action] = match;
      if (!state.vms[id]) return json(404, { error: "VM not registered" });
      if (action === "resume" && req.method === "POST") {
        await environmentSafe();
        const vm = state.vms[id];
        vm.phase = "created";
        delete vm.bootstrapProcess;
        delete vm.bootstrapComplete;
        delete vm.bootstrapOperation;
        await save();
        const d = await api(path, {
          method: "POST",
          body: { ...JSON.parse(body ?? "{}"), environment, noEnv: true },
        });
        await bootstrap(id);
        return json(200, d);
      }
      if (!action && req.method === "GET") {
        const d = await api(path);
        if (
          ["ready", "idle", "running"].includes(d.box.state) &&
          !["pending", "failing"].includes(d.box.stop?.status)
        )
          await bootstrap(id);
        return json(200, d);
      }
      if (
        req.method === "POST" &&
        ["command", "commands", "desktop", "host"].some((x) => action?.startsWith(x)) &&
        state.vms[id].phase !== "ready"
      )
        throw new Error("VM network is not verified");
    }
    const response = await retryRead(async () => {
      const result = await fetch(`${upstream}${path}`, {
        method: req.method,
        headers: {
          Authorization: `Bearer ${key}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(req.headers["x-ascii-confirm-delete"]
            ? { "X-Ascii-Confirm-Delete": req.headers["x-ascii-confirm-delete"] }
            : {}),
        },
        body,
        signal: AbortSignal.timeout(650000),
        redirect: "error",
      });
      if (req.method === "GET" && [429, 502, 503, 504].includes(result.status)) {
        await result.body?.cancel();
        throw Object.assign(new Error(`Boat HTTP ${result.status}`), { status: result.status });
      }
      return result;
    }, req.method);
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    res.writeHead(response.status, { "Content-Type": contentType, "Cache-Control": "no-store" });
    if (contentType.includes("application/json")) {
      const d = await response.json();
      if (typeof d.stdout === "string")
        d.stdout = d.stdout.replace(
          /https:\/\/([a-z0-9-]+)\.on\.boat\.dev/g,
          "https://$1.on.ascii.dev",
        );
      res.end(JSON.stringify(d));
    } else if (response.body) Readable.fromWeb(response.body).pipe(res);
    else res.end();
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "request.failed",
        reason: error.message.startsWith("Boat HTTP")
          ? error.message
          : error.message.replace(/boat_[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 180),
      }),
    );
    if (!res.headersSent)
      json(gatewayErrorStatus(error), {
        error:
          "Boat provisioning or network verification failed; inspect the gateway state before retrying",
      });
    else res.end();
  }
}

async function main() {
  key = (await readFile(`${root}/boat-key`, "utf8")).trim();
  try {
    state = JSON.parse(await readFile(`${root}/controller.json`, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    state = { bots: {}, vms: {} };
  }
  await assertModeTransition(state.vms, networkConfig.mode, async (id) => {
    try {
      return (await api(`/boxes/${id}`)).box;
    } catch (error) {
      if (error.status === 404) return { state: "deleted" };
      throw error;
    }
  });
  if (process.argv.includes("--check-network-transition")) return;
  if (networkConfig.mode === "all") {
    const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(wireguardEndpoint);
    if (!match) throw new Error("Invalid WireGuard endpoint");
    const host = match[1].replace(/^\[|\]$/g, "");
    const address = isIP(host) ? host : (await lookup(host, { family: 4 })).address;
    wireguardEndpoint = `${isIP(address) === 6 ? `[${address}]` : address}:${match[2]}`;
  }
  for (const [id, vm] of Object.entries(state.vms)) {
    try {
      await api(`/boxes/${id}`);
    } catch (error) {
      if (error.status === 404) {
        await exec("wg", ["set", "rakazo0", "peer", vm.publicKey, "remove"]);
        delete state.vms[id];
        for (const [bot, intent] of Object.entries(state.bots))
          if (intent.id === id) delete state.bots[bot];
        await save();
        continue;
      }
    }
    await addPeer(vm);
  }
  http
    .createServer((req, res) => {
      void handler(req, res);
    })
    .listen(8788, "127.0.0.1", () => console.log("Rakazo Boat gateway listening on loopback"));
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(
      error.message === "Stop computers before changing the network egress mode"
        ? error.message
        : "Gateway initialization failed",
    );
    process.exit(1);
  });
