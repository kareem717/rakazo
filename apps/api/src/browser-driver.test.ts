import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

function fixture(isDeploymentOwner = true) {
  const settings = { id: "default", browserDriver: "cdp" };
  const upsert = vi.fn(async ({ update }: { update: Record<string, unknown> }) => {
    Object.assign(settings, update);
    return settings;
  });
  const prisma = {
    deploymentSettings: { findUnique: vi.fn(async () => settings), upsert },
  } as unknown as PrismaClient;
  const handler = new RPCHandler(
    createRouter({ prisma, env: { sandboxProvider: "boat" } } as RouterDeps),
  );
  const actor: Actor = {
    userId: "user-1",
    spaceId: "space-1",
    email: "owner@example.test",
    isDeploymentOwner,
  };
  async function call(procedure: string, input?: unknown) {
    const { response } = await handler.handle(
      new Request(`http://localhost/rpc/deployment/${procedure}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input ?? null }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return { status: response.status, body: await response.json() };
  }
  return { upsert, call };
}

describe("deployment browser driver", () => {
  it("persists the owner's choice and preserves it when unrelated settings change", async () => {
    const { call, upsert } = fixture();
    expect(await call("get")).toMatchObject({
      status: 200,
      body: { json: { browserDriver: "cdp" } },
    });
    expect(await call("update", { browserDriver: "patchright" })).toMatchObject({
      status: 200,
      body: { json: { browserDriver: "patchright" } },
    });
    expect(upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({ update: { browserDriver: "patchright" } }),
    );
    expect(await call("update", { signupsEnabled: false })).toMatchObject({
      status: 200,
      body: { json: { browserDriver: "patchright" } },
    });
    expect(await call("update", { browserDriver: "cdp" })).toMatchObject({
      status: 200,
      body: { json: { browserDriver: "cdp" } },
    });
  });

  it("forbids a member from reading or changing the deployment choice", async () => {
    const { call, upsert } = fixture(false);
    expect(await call("get")).toMatchObject({ status: 403 });
    expect(await call("update", { browserDriver: "patchright" })).toMatchObject({ status: 403 });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("rejects arbitrary executables and unknown driver identifiers", async () => {
    const { call, upsert } = fixture();
    for (const browserDriver of ["/tmp/custom-driver", "unknown", "", null]) {
      expect(await call("update", { browserDriver })).toMatchObject({ status: 400 });
    }
    expect(upsert).not.toHaveBeenCalled();
  });
});
