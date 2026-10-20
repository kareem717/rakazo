import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EgressConfig } from "@rakazo/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { readNetworkSettings, saveNetworkSettings } from "./network-settings.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "network-settings-"));
  directories.push(dir);
  const path = join(dir, "network.json");
  await writeFile(path, JSON.stringify({ version: 1, mode: "direct" }));
  const state = await readNetworkSettings(path);
  if (!state.available) throw Error("Expected config");
  return { path, state, dir };
}
it("stages a validated config without changing active process routing", async () => {
  const { path, state, dir } = await fixture();
  const saved = await saveNetworkSettings(
    {
      revision: state.revision,
      config: {
        version: 1,
        mode: "browser",
        transport: { type: "socks5", url: "socks5://proxy.example.test:1080" },
      },
    },
    path,
  );
  expect(saved).toMatchObject({
    available: true,
    active: { mode: "direct" },
    saved: { mode: "browser" },
    restartRequired: true,
  });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(await readdir(dir)).toEqual(["network.json"]);
  if (!saved.available) throw Error("Expected config");
  expect(
    await saveNetworkSettings(
      { revision: saved.revision, config: { version: 1, mode: "direct" } },
      path,
    ),
  ).toMatchObject({ restartRequired: false });
});
it("rejects stale admin edits and malformed transport configuration without overwriting", async () => {
  const { path, state } = await fixture();
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      mode: "all",
      transport: { type: "tailscale-exit-node", exitNode: "exit.example.ts.net" },
    }),
  );
  const previous = await readFile(path, "utf8");
  await expect(
    saveNetworkSettings({ revision: state.revision, config: { version: 1, mode: "direct" } }, path),
  ).rejects.toThrow("changed");
  await expect(
    saveNetworkSettings(
      {
        revision: state.revision,
        config: {
          version: 1,
          mode: "all",
          transport: { type: "socks5", url: "socks5://proxy.example.test" },
        } as unknown as EgressConfig,
      },
      path,
    ),
  ).rejects.toThrow("Invalid");
  expect(await readFile(path, "utf8")).toBe(previous);
});
it("refuses symlink configs and held locks", async () => {
  const { path, state, dir } = await fixture();
  const alias = join(dir, "alias.json");
  await symlink(path, alias);
  await expect(readNetworkSettings(alias)).rejects.toThrow("Could not read");
  await writeFile(path + ".lock", "");
  await expect(
    saveNetworkSettings({ revision: state.revision, config: { version: 1, mode: "direct" } }, path),
  ).rejects.toThrow("being updated");
});

it("reports a pending edit against the gateway snapshot on a new API process", async () => {
  const { path, dir } = await fixture();
  const active = join(dir, "active.json");
  await writeFile(
    active,
    JSON.stringify({
      version: 1,
      mode: "tools",
      transport: { type: "socks5", url: "socks5://proxy.example.test:1080" },
    }),
  );
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      mode: "all",
      transport: { type: "tailscale-exit-node", exitNode: "exit.example.ts.net" },
    }),
  );
  vi.stubEnv("RAKAZO_NETWORK_ACTIVE_CONFIG", active);
  expect(await readNetworkSettings(path)).toMatchObject({
    active: { mode: "tools" },
    saved: { mode: "all" },
    restartRequired: true,
  });
});
