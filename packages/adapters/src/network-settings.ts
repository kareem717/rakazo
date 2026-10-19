import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EgressConfig, NetworkSettings } from "@rakazo/contracts";
import { parseEgressConfig } from "@rakazo/contracts";
import { activeEgressConfig } from "./egress-config.js";

export class NetworkSettingsError extends Error {
  constructor(
    message: string,
    public readonly conflict = false,
  ) {
    super(message);
  }
}

function revision(config: EgressConfig) {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}
async function savedConfig(path: string): Promise<EgressConfig> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Invalid config file");
  return parseEgressConfig(JSON.parse(await readFile(path, "utf8")));
}

/** Only the deployment-selected file is writable; clients never supply a path. */
export async function readNetworkSettings(
  path = process.env.RAKAZO_NETWORK_CONFIG,
): Promise<NetworkSettings> {
  if (!path) return { available: false };
  try {
    const active = activeEgressConfig(path);
    const saved = await savedConfig(path);
    const writable = await Promise.all([
      access(path, constants.W_OK),
      access(dirname(path), constants.W_OK),
    ]).then(
      () => true,
      () => false,
    );
    return {
      available: true,
      writable,
      active,
      saved,
      revision: revision(saved),
      restartRequired: revision(active) !== revision(saved),
    };
  } catch {
    throw new NetworkSettingsError("Could not read network settings");
  }
}

export async function saveNetworkSettings(
  input: { config: EgressConfig; revision: string },
  path = process.env.RAKAZO_NETWORK_CONFIG,
): Promise<NetworkSettings> {
  if (!path) throw new NetworkSettingsError("Network settings are managed on the server");
  // Validate before creating a lock or temporary file, even for non-RPC callers.
  let config: EgressConfig;
  try {
    config = parseEgressConfig(input.config);
  } catch {
    throw new NetworkSettingsError("Invalid network configuration");
  }
  const status = await readNetworkSettings(path);
  if (!status.available || !status.writable)
    throw new NetworkSettingsError("Network settings are managed on the server");
  const temporary = join(dirname(path), `.network-${randomUUID()}.json`);
  const lockPath = `${path}.lock`;
  const lock = await open(lockPath, "wx", 0o600).catch(() => {
    throw new NetworkSettingsError(
      "Network settings are being updated. Reload and try again.",
      true,
    );
  });
  try {
    if (revision(await savedConfig(path)) !== input.revision)
      throw new NetworkSettingsError("Network settings changed. Reload and try again.", true);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(config, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    return await readNetworkSettings(path);
  } catch (error) {
    if (error instanceof NetworkSettingsError) throw error;
    throw new NetworkSettingsError("Could not save network settings");
  } finally {
    await unlink(temporary).catch(() => undefined);
    await lock.close();
    await unlink(lockPath);
  }
}
