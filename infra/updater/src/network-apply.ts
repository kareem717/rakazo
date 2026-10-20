import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { EgressConfig, NetworkApplyStatus } from "@rakazo/contracts";
import {
  NetworkApplyInputSchema,
  NetworkApplyStatusSchema,
  parseEgressConfig,
} from "@rakazo/contracts";
import { composeUpArgv, resolveComposeProjectName } from "@rakazo/core";
import type { UpdaterCommandRunner } from "./index.js";

export function networkRevision(config: EgressConfig) {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}
const terminal = new Set(["idle", "succeeded", "failed"]);
const services = ["egress", "api", "worker", "web", "supervisor"];

export function networkApplyConfig(env: NodeJS.ProcessEnv) {
  const deployDir = env.RAKAZO_DEPLOY_DIR?.trim() ?? "";
  const configPath = env.RAKAZO_NETWORK_CONFIG?.trim() ?? "";
  if (
    !path.isAbsolute(deployDir) ||
    !path.isAbsolute(configPath) ||
    !configPath.startsWith(`${deployDir}/`)
  )
    throw new Error("Network apply requires a configuration inside the deployment directory");
  const composeFiles = (env.RAKAZO_COMPOSE_FILE ?? "")
    .split(env.COMPOSE_PATH_SEPARATOR || ":")
    .filter(Boolean);
  if (
    !composeFiles.length ||
    composeFiles.some((file) => path.isAbsolute(file) || file.split("/").includes(".."))
  )
    throw new Error("Network apply requires deployment-relative Compose files");
  return {
    deployDir,
    configPath,
    composeFiles: composeFiles.map((file) => path.join(deployDir, file)),
    projectName: resolveComposeProjectName(env),
  };
}
type Config = ReturnType<typeof networkApplyConfig>;

export class NetworkApplier {
  status: NetworkApplyStatus = {
    available: true,
    phase: "idle",
    operationId: null,
    revision: null,
    error: null,
  };
  private work: Promise<void> | null = null;
  private readonly base: string[];
  private readonly up: string[];
  constructor(
    private readonly config: Config,
    private readonly stateDir: string,
    private readonly run: UpdaterCommandRunner,
  ) {
    const invocation = composeUpArgv({
      composeFiles: config.composeFiles,
      envFiles: [path.join(config.deployDir, ".env")],
      projectName: config.projectName,
      services,
    });
    const index = invocation.args.indexOf("up");
    this.base = invocation.args.slice(0, index);
    this.up = [...this.base, "up", "--force-recreate", ...invocation.args.slice(index + 1)];
  }
  async initialize() {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    try {
      this.status = NetworkApplyStatusSchema.parse(
        JSON.parse(await readFile(path.join(this.stateDir, "status.json"), "utf8")),
      );
      if (!terminal.has(this.status.phase)) {
        this.status = {
          ...this.status,
          available: false,
          phase: "failed",
          error: "Network apply was interrupted. Recovery requires server access.",
        };
        await this.persist();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  private async persist() {
    const file = path.join(this.stateDir, "status.json");
    await writeFile(`${file}.tmp`, JSON.stringify(this.status), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }
  private async phase(phase: NetworkApplyStatus["phase"], error: string | null = null) {
    this.status = { ...this.status, phase, error };
    await this.persist();
  }
  private async command(args: string[], timeoutMs = 30_000) {
    const result = await this.run("docker", [...this.base, ...args], {
      cwd: this.config.deployDir,
      timeoutMs,
      output: "stdout",
    });
    if (!result.ok) throw new Error("Network deployment command failed");
    return result.output;
  }
  private async gateway(args: string[], timeoutMs = 30_000) {
    return this.command(["exec", "-T", "egress", ...args], timeoutMs);
  }
  private async recreate(expected: EgressConfig) {
    const result = await this.run("docker", this.up, {
      cwd: this.config.deployDir,
      timeoutMs: 420_000,
    });
    if (!result.ok) throw new Error("Network deployment restart failed");
    const health = JSON.parse(
      await this.gateway(
        [
          "curl",
          "--fail",
          "--silent",
          "--retry",
          "20",
          "--retry-delay",
          "2",
          "--retry-all-errors",
          "--max-time",
          "5",
          "http://127.0.0.1:8788/health",
        ],
        150_000,
      ),
    );
    if (!health.ready || health.mode !== expected.mode)
      throw new Error("Route verification failed");
  }
  private freeze(operation: string, undo = false) {
    return this.gateway([
      "node",
      "/deployment/controller.mjs",
      undo ? "--unfreeze-network" : "--freeze-network",
      operation,
    ]);
  }
  private async replaceConfig(bytes: string, uid: number, gid: number) {
    const file = `${this.config.configPath}.${randomUUID()}.tmp`;
    const handle = await open(file, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.chown(uid, gid);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(file, this.config.configPath);
    } finally {
      await unlink(file).catch(() => undefined);
    }
  }
  async start(input: unknown) {
    if (!this.status.available) throw new Error("Recovery requires server access");
    const { revision } = NetworkApplyInputSchema.parse(input);
    if (this.work || !terminal.has(this.status.phase))
      throw new Error("A network apply is already running");
    if (
      (await realpath(path.dirname(this.config.configPath))) !==
      path.dirname(this.config.configPath)
    )
      throw new Error("Invalid network configuration directory");
    const metadata = await lstat(this.config.configPath);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new Error("Invalid network configuration file");
    const lockPath = `${this.config.configPath}.lock`;
    const lock = await open(lockPath, "wx", 0o600);
    try {
      const targetBytes = await readFile(this.config.configPath, "utf8");
      const target = parseEgressConfig(JSON.parse(targetBytes));
      if (networkRevision(target) !== revision)
        throw new Error("Network settings changed. Reload and try again.");
      this.status = {
        available: true,
        phase: "checking",
        operationId: randomUUID(),
        revision,
        error: null,
      };
      await this.persist();
      this.work = this.apply(target, targetBytes, metadata.uid, metadata.gid).finally(async () => {
        await lock.close();
        await unlink(lockPath);
        this.work = null;
      });
      // All failures become durable status; a disconnected API must not kill this work.
      void this.work.catch(() => undefined);
      return this.status;
    } catch (error) {
      await lock.close();
      await unlink(lockPath);
      throw error;
    }
  }
  async wait() {
    await this.work;
  }
  private async apply(target: EgressConfig, targetBytes: string, uid: number, gid: number) {
    const operation = this.status.operationId!;
    let frozen = false,
      restarted = false,
      previous: EgressConfig | undefined;
    let preflightError = "Could not read the active network policy. Try again.";
    try {
      previous = parseEgressConfig(
        JSON.parse(await this.gateway(["cat", "/network-runtime/active.json"])),
      );
      await writeFile(
        path.join(this.stateDir, "recovery.json"),
        JSON.stringify({ operation, previous, target }),
        { mode: 0o600 },
      );
      if (target.mode === "all") {
        preflightError = "Could not verify Tailscale status. Check the connection and retry.";
        const status = JSON.parse(await this.gateway(["tailscale", "status", "--json"]));
        const peers = Object.values(status.Peer ?? {}) as {
          DNSName?: string;
          TailscaleIPs?: string[];
          ExitNodeOption?: boolean;
          Online?: boolean;
        }[];
        const selected = target.transport.exitNode.replace(/\.$/, "");
        if (
          status.BackendState !== "Running" ||
          !peers.some(
            (peer) =>
              peer.ExitNodeOption &&
              peer.Online &&
              (peer.DNSName?.replace(/\.$/, "") === selected ||
                peer.TailscaleIPs?.includes(selected)),
          )
        )
          throw new Error("Connect Tailscale and select an online exit node before applying.");
      }
      preflightError = "Could not pause computer operations. Try again.";
      await this.freeze(operation);
      frozen = true;
      try {
        await this.gateway(
          ["node", "/deployment/controller.mjs", "--check-network-apply"],
          120_000,
        );
      } catch {
        throw new Error(
          "Stop computers and wait for computer operations to finish before applying.",
        );
      }
      if (
        networkRevision(
          parseEgressConfig(JSON.parse(await readFile(this.config.configPath, "utf8"))),
        ) !== this.status.revision
      )
        throw new Error("Network settings changed. Reload and try again.");
      await this.phase("restarting");
      restarted = true;
      await this.command(["stop", "api", "worker", "web", "supervisor"], 120_000);
      await this.gateway(["node", "/deployment/controller.mjs", "--check-network-apply"], 120_000);
      await this.phase("verifying");
      await this.recreate(target);
      await this.freeze(operation, true);
      frozen = false;
      await this.phase("succeeded");
    } catch (error) {
      let message =
        error instanceof Error &&
        !restarted &&
        /^(Stop computers|Connect Tailscale|Network settings changed)/.test(error.message)
          ? error.message
          : restarted
            ? "Could not apply network settings."
            : preflightError;
      if (restarted && previous) {
        try {
          await this.command(["stop", "api", "worker", "web", "supervisor"], 120_000);
          await this.replaceConfig(JSON.stringify(previous), uid, gid);
          await this.recreate(previous);
          await this.freeze(operation, true);
          frozen = false;
          await this.replaceConfig(targetBytes, uid, gid);
          message = "Could not apply network settings. The previous route was restored.";
        } catch {
          this.status = { ...this.status, available: false };
          message = "Network apply failed. Recovery requires server access.";
        }
      }
      await this.phase("failed", message);
    } finally {
      if (frozen && !restarted) await this.freeze(operation, true).catch(() => undefined);
    }
  }
}
