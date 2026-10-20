import { timingSafeEqual } from "node:crypto";
import type { NetworkDrainDependencies } from "@rakazo/adapters";
import { drainNetworkComputers, networkApplyStatus, releaseNetworkDrain } from "@rakazo/adapters";
import type { Hono } from "hono";
import { requestBodyLimit } from "./request-body-limit.js";

/** Called only by the owner-authorized restart controller, never by a client. */
export function mountNetworkDrain(app: Hono, deps: NetworkDrainDependencies, secret: string) {
  const running = new Map<string, Promise<void>>();
  app.post("/api/internal/network-drain", requestBodyLimit(1024), async (c) => {
    c.header("cache-control", "no-store");
    const supplied = Buffer.from(c.req.header("authorization") ?? "");
    const expected = Buffer.from(`Bearer ${secret}`);
    if (!secret || supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      return c.body(null, 403);
    const input = await c.req.json().catch(() => null);
    if (
      !/^[a-f0-9-]{36}$/.test(input?.operationId ?? "") ||
      !["begin", "release"].includes(input?.action)
    )
      return c.body(null, 400);
    const status = await networkApplyStatus();
    if (
      status.operationId !== input.operationId ||
      (input.action === "begin" && status.phase !== "draining")
    )
      return c.body(null, 409);
    try {
      if (input.action === "release") {
        await running.get(input.operationId)?.catch(() => undefined);
        await releaseNetworkDrain(deps.prisma, input.operationId);
      } else {
        let work = running.get(input.operationId);
        if (!work) {
          work = drainNetworkComputers(deps, input.operationId, AbortSignal.timeout(10 * 60_000));
          running.set(input.operationId, work);
        }
        try {
          await work;
        } finally {
          if (running.get(input.operationId) === work) running.delete(input.operationId);
        }
      }
      return c.json({ ok: true });
    } catch {
      return c.json(
        {
          error:
            "Could not drain computers. Wait for active work or maintenance to finish and try again.",
        },
        409,
      );
    }
  });
}
