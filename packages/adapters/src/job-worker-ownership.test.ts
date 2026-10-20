import { EventEmitter } from "node:events";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { JobWorkerOwnership } from "./job-worker-ownership.js";

function fixture() {
  const query = vi.fn(async (sql: string, args?: unknown[]) => {
    if (sql.startsWith("select id from")) return { rows: [{ id: "live" }, { id: "dead" }] };
    if (sql.includes("pg_try_advisory_xact_lock")) {
      return { rows: [{ acquired: args?.[1] === "dead" }] };
    }
    return { rows: [] };
  });
  const clients: Array<EventEmitter & { query: typeof query; release: ReturnType<typeof vi.fn> }> =
    [];
  const pool = {
    connect: vi.fn(async () => {
      const client = Object.assign(new EventEmitter(), { query, release: vi.fn() });
      clients.push(client);
      return client;
    }),
  };
  const lost = vi.fn();
  const owner = new JobWorkerOwnership(pool as unknown as Pool, lost);
  return { owner, query, clients, lost };
}

describe("job worker ownership", () => {
  it("recovers only registered owners whose database session lock has gone away", async () => {
    const { owner, query } = fixture();
    try {
      await owner.start();
      expect(query.mock.calls.filter(([sql]) => sql.includes("force_unlock_workers"))).toEqual([
        ["select graphile_worker.force_unlock_workers($1::text[])", [["dead"]]],
      ]);
      expect(query).toHaveBeenCalledWith(
        "delete from graphile_worker.rakazo_worker_owners where id = $1",
        ["dead"],
      );
      expect(query).not.toHaveBeenCalledWith(
        "delete from graphile_worker.rakazo_worker_owners where id = $1",
        ["live"],
      );
    } finally {
      await owner.stop();
    }
  });

  it("registers once before effects and refuses work after losing its ownership connection", async () => {
    const { owner, query, clients, lost } = fixture();
    try {
      await owner.claim("current");
      await owner.claim("current");
      expect(query.mock.calls.filter(([sql]) => sql.startsWith("insert into"))).toHaveLength(1);
      const registration = clients.at(-1)!;
      registration.emit("error", new Error("connection lost"));
      await expect(owner.claim("current")).rejects.toThrow("ownership connection was lost");
      expect(lost).toHaveBeenCalledTimes(1);
      await expect(owner.claim("another-pool")).rejects.toThrow("owner changed");
    } finally {
      await owner.stop();
    }
    expect(clients.at(-1)!.release).toHaveBeenCalledWith(true);
    // Losing a session must leave its registration for another worker to recover.
    expect(query).not.toHaveBeenCalledWith(
      "delete from graphile_worker.rakazo_worker_owners where id = $1",
      ["current"],
    );
  });

  it("rolls back and retains the dead owner when unlocking jobs fails", async () => {
    const { owner, query } = fixture();
    const base = query.getMockImplementation()!;
    query.mockImplementation(async (sql, args) => {
      if (sql.includes("force_unlock_workers")) throw new Error("database unavailable");
      return base(sql, args);
    });
    await expect(owner.start()).rejects.toThrow("database unavailable");
    expect(query).toHaveBeenCalledWith("rollback");
    expect(query).not.toHaveBeenCalledWith(
      "delete from graphile_worker.rakazo_worker_owners where id = $1",
      ["dead"],
    );
    await owner.stop();
  });

  it("keeps its recovery marker after stopping and releases the lock once", async () => {
    const { owner, clients, query } = fixture();
    await owner.claim("current");
    await Promise.all([owner.stop(), owner.stop()]);
    expect(query).not.toHaveBeenCalledWith(
      "delete from graphile_worker.rakazo_worker_owners where id = $1",
      ["current"],
    );
    expect(clients.at(-1)!.release).toHaveBeenCalledExactlyOnceWith(true);
  });
});
