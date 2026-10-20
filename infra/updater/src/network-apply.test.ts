import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EgressConfig } from "@rakazo/contracts";
import { afterEach, expect, it } from "vitest";
import type { UpdaterCommandRunner } from "./index.js";
import { NetworkApplier, networkApplyConfig, networkRevision } from "./network-apply.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const previous: EgressConfig = { version: 1, mode: "direct" };
const target: EgressConfig = {
  version: 1,
  mode: "tools",
  transport: { type: "socks5", url: "socks5://proxy.example.test:1080" },
};
async function fixture(
  options: {
    busy?: boolean;
    failFirstRestart?: boolean;
    failAllRestarts?: boolean;
    tailscaleStatus?: string;
    failDrain?: boolean;
  } = {},
) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "network-apply-")));
  directories.push(dir);
  const configPath = path.join(dir, "network.json");
  await writeFile(configPath, JSON.stringify(target));
  const commands: string[][] = [];
  const modes: string[] = [];
  let restarts = 0,
    booted = previous;
  const run: UpdaterCommandRunner = async (command, args, execution) => {
    expect(command).toBe("docker");
    commands.push(args);
    const ok = (output = "") => ({ ok: true, exitCode: 0, output });
    if (args.includes("tailscale")) {
      expect(execution.output).toBe("stdout");
      return ok(options.tailscaleStatus);
    }
    if (args.includes("tsx") && options.failDrain && args.at(-1)?.includes('"action":"begin"'))
      return { ok: false, exitCode: 1, output: "private drain failure" };
    if (args.includes("cat")) return ok(JSON.stringify(booted));
    if (args.includes("--check-network-apply") && options.busy)
      return { ok: false, exitCode: 1, output: "private provider diagnostic" };
    if (args.includes("up")) {
      restarts++;
      booted = JSON.parse(await readFile(configPath, "utf8"));
      modes.push(booted.mode);
      if (options.failAllRestarts || (options.failFirstRestart && restarts === 1))
        return { ok: false, exitCode: 1, output: "private network diagnostic" };
    }
    if (args.includes("curl")) return ok(JSON.stringify({ ready: true, mode: booted.mode }));
    return ok();
  };
  const config = networkApplyConfig({
    RAKAZO_DEPLOY_DIR: dir,
    RAKAZO_NETWORK_CONFIG: configPath,
    RAKAZO_COMPOSE_FILE: "base.yml:network.yml:apply.yml",
    COMPOSE_PROJECT_NAME: "test-network",
  });
  const applier = new NetworkApplier(config, path.join(dir, "state"), run);
  await applier.initialize();
  return { applier, dir, configPath, commands, modes };
}
it("verifies a large exit-node status response before applying everything", async () => {
  const { applier, configPath, modes } = await fixture({
    tailscaleStatus: JSON.stringify({
      BackendState: "Running",
      Peer: {
        selected: { DNSName: "exit.example.test.", ExitNodeOption: true, Online: true },
      },
      User: { example: { ProfilePicURL: "x".repeat(100000) } },
    }),
  });
  const all: EgressConfig = {
    version: 1,
    mode: "all",
    transport: { type: "tailscale-exit-node", exitNode: "exit.example.test" },
  };
  await writeFile(configPath, JSON.stringify(all));
  await applier.start({ revision: networkRevision(all) });
  await applier.wait();
  expect(applier.status.phase).toBe("succeeded");
  expect(modes).toEqual(["all"]);
});
it("reports an unreadable Tailscale response without exposing command output", async () => {
  const { applier, configPath, commands } = await fixture({
    tailscaleStatus: "private invalid response",
  });
  const all: EgressConfig = {
    version: 1,
    mode: "all",
    transport: { type: "tailscale-exit-node", exitNode: "exit.example.test" },
  };
  await writeFile(configPath, JSON.stringify(all));
  await applier.start({ revision: networkRevision(all) });
  await applier.wait();
  expect(applier.status.error).toBe(
    "Could not verify Tailscale status. Check the connection and retry.",
  );
  expect(commands.some((args) => args.includes("stop") || args.includes("up"))).toBe(false);
});
it("rejects caller commands, stale edits and paths outside the deployment", async () => {
  const { applier, commands, dir } = await fixture();
  await expect(
    applier.start({ revision: networkRevision(target), command: "restart" }),
  ).rejects.toThrow();
  await expect(applier.start({ revision: "0".repeat(64) })).rejects.toThrow("changed");
  expect(commands).toHaveLength(0);
  expect(await readdir(dir)).not.toContain("network.json.lock");
  expect(() =>
    networkApplyConfig({
      RAKAZO_DEPLOY_DIR: "/deployment",
      RAKAZO_NETWORK_CONFIG: "/etc/secret",
      RAKAZO_COMPOSE_FILE: "base.yml",
    }),
  ).toThrow();
});
it("refuses active computers before any stop or recreate and releases both locks", async () => {
  const { applier, commands, dir, configPath } = await fixture({ busy: true });
  await applier.start({ revision: networkRevision(target) });
  await applier.wait();
  expect(applier.status).toMatchObject({
    phase: "failed",
    error: expect.stringContaining("Stop computers"),
  });
  expect(commands.some((args) => args.includes("stop") || args.includes("up"))).toBe(false);
  expect(commands.some((args) => args.includes("--unfreeze-network"))).toBe(true);
  expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(target);
  expect(await readdir(dir)).not.toContain("network.json.lock");
});
it("locks settings during restart, rechecks provider state and verifies the new route", async () => {
  const { applier, commands, configPath, dir, modes } = await fixture();
  await applier.start({ revision: networkRevision(target) });
  await expect(applier.start({ revision: networkRevision(target) })).rejects.toThrow();
  await applier.wait();
  expect(applier.status.phase).toBe("succeeded");
  expect(modes).toEqual(["tools"]);
  expect(commands.filter((args) => args.includes("--check-network-apply"))).toHaveLength(2);
  const up = commands.find((args) => args.includes("up"))!;
  expect(up).toContain("--force-recreate");
  expect(up).toContain("--no-build");
  expect(up).toContain("never");
  expect(up.slice(-5)).toEqual(["egress", "api", "worker", "web", "supervisor"]);
  expect(up).not.toContain("network-applier");
  expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(target);
  expect(await readdir(dir)).not.toContain("network.json.lock");
});
it("restores the old route on failure while retaining the owner's pending choice", async () => {
  const { applier, modes, configPath } = await fixture({ failFirstRestart: true });
  await applier.start({ revision: networkRevision(target) });
  await applier.wait();
  expect(modes).toEqual(["tools", "direct"]);
  expect(applier.status).toMatchObject({
    phase: "failed",
    error: expect.stringContaining("previous route was restored"),
  });
  expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(target);
});
it("keeps recovery information and refuses retries when rollback also fails", async () => {
  const { applier, dir, commands } = await fixture({ failAllRestarts: true });
  await applier.start({ revision: networkRevision(target) });
  await applier.wait();
  expect(applier.status.error).toContain("Recovery requires server access");
  expect(commands.some((args) => args.includes("--unfreeze-network"))).toBe(false);
  const recovery = JSON.parse(await readFile(path.join(dir, "state/recovery.json"), "utf8"));
  expect(recovery).toMatchObject({ previous, target });
  await expect(applier.start({ revision: networkRevision(previous) })).rejects.toThrow("Recovery");
});
it("reports interrupted runs after the control service restarts", async () => {
  const { dir } = await fixture();
  await mkdir(path.join(dir, "interrupted"));
  await writeFile(
    path.join(dir, "interrupted/status.json"),
    JSON.stringify({
      available: true,
      phase: "restarting",
      operationId: "operation",
      revision: networkRevision(target),
      error: null,
    }),
  );
  const config = networkApplyConfig({
    RAKAZO_DEPLOY_DIR: dir,
    RAKAZO_NETWORK_CONFIG: path.join(dir, "network.json"),
    RAKAZO_COMPOSE_FILE: "base.yml",
  });
  const recovered = new NetworkApplier(config, path.join(dir, "interrupted"), async () => {
    throw Error("Must not run commands");
  });
  await recovered.initialize();
  expect(recovered.status.error).toContain("interrupted");
});

it("drains only after explicit consent and releases maintenance after verification", async () => {
  const { applier, commands } = await fixture();
  await applier.start({ revision: networkRevision(target), stopComputers: true });
  await applier.wait();
  expect(applier.status.phase).toBe("succeeded");
  const begin = commands.findIndex((args) => args.at(-1)?.includes('"action":"begin"'));
  const stop = commands.findIndex((args) => args.includes("stop"));
  const release = commands.findIndex((args) => args.at(-1)?.includes('"action":"release"'));
  expect(begin).toBeGreaterThanOrEqual(0);
  expect(stop).toBeGreaterThan(begin);
  expect(release).toBeGreaterThan(stop);
});
it("releases a failed drain without restarting the app or route", async () => {
  const { applier, commands } = await fixture({ failDrain: true });
  await applier.start({ revision: networkRevision(target), stopComputers: true });
  await applier.wait();
  expect(applier.status).toMatchObject({
    available: true,
    phase: "failed",
    error: expect.stringContaining("Could not drain"),
  });
  expect(commands.some((args) => args.includes("stop") || args.includes("up"))).toBe(false);
  expect(commands.some((args) => args.at(-1)?.includes('"action":"release"'))).toBe(true);
});
