import { getLogger } from "@rakazo/logging";
import type { Pool, PoolClient } from "pg";

// Session locks prove ownership even for jobs that legitimately run for hours. An age limit
// alone cannot distinguish a dead worker from a slow tool, and can repeat external effects.
const OWNERSHIP_NAMESPACE = 1_380_019_076;
const RECOVERY_INTERVAL_MS = 30_000;

export class JobWorkerOwnership {
  private starting?: Promise<void>;
  private claiming?: Promise<void>;
  private recovering?: Promise<void>;
  private client?: PoolClient;
  private owner?: string;
  private lost = false;
  private timer?: ReturnType<typeof setInterval>;
  private stopping?: Promise<void>;

  constructor(
    private readonly pool: Pool,
    private readonly onLost: () => void,
  ) {}

  get unavailable(): boolean {
    return this.lost;
  }

  start(): Promise<void> {
    this.starting ??= this.initialize();
    return this.starting;
  }

  private async initialize(): Promise<void> {
    // This registry belongs to the Graphile adapter, alongside Graphile's own schema. It
    // contains only pool IDs, never job payloads, and doesn't change the product schema.
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock($1::bigint)", [OWNERSHIP_NAMESPACE]);
      await client.query(
        "create table if not exists graphile_worker.rakazo_worker_owners (id text primary key)",
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    await this.recover();
    this.timer = setInterval(() => {
      void this.recover().catch((error) =>
        getLogger().error("job ownership recovery failed", error),
      );
    }, RECOVERY_INTERVAL_MS);
    this.timer.unref();
  }

  async claim(owner: string | null): Promise<void> {
    if (!owner) throw new Error("Background job has no worker owner");
    await this.start();
    if (this.owner && this.owner !== owner) throw new Error("Background job owner changed");
    this.owner = owner;
    this.claiming ??= this.register(owner);
    await this.claiming;
    if (this.lost) throw new Error("Background job ownership connection was lost");
  }

  private async register(owner: string): Promise<void> {
    const client = await this.pool.connect();
    this.client = client;
    client.on("error", this.connectionLost);
    try {
      await client.query("select pg_advisory_lock($1::integer, hashtext($2))", [
        OWNERSHIP_NAMESPACE,
        owner,
      ]);
      await client.query(
        "insert into graphile_worker.rakazo_worker_owners (id) values ($1) on conflict do nothing",
        [owner],
      );
    } catch (error) {
      this.connectionLost();
      throw error;
    }
  }

  private readonly connectionLost = () => {
    if (this.lost) return;
    this.lost = true;
    this.onLost();
  };

  recover(): Promise<void> {
    if (this.recovering) return this.recovering;
    const recovering = this.recoverOnce();
    this.recovering = recovering;
    void recovering
      .finally(() => {
        if (this.recovering === recovering) this.recovering = undefined;
      })
      .catch(() => undefined);
    return recovering;
  }

  private async recoverOnce(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("set local statement_timeout = '5s'");
      const owners = await client.query<{ id: string }>(
        "select id from graphile_worker.rakazo_worker_owners for update skip locked",
      );
      let recovered = 0;
      for (const { id } of owners.rows) {
        const lock = await client.query<{ acquired: boolean }>(
          "select pg_try_advisory_xact_lock($1::integer, hashtext($2)) as acquired",
          [OWNERSHIP_NAMESPACE, id],
        );
        if (!lock.rows[0]?.acquired) continue;
        await client.query("select graphile_worker.force_unlock_workers($1::text[])", [[id]]);
        await client.query("delete from graphile_worker.rakazo_worker_owners where id = $1", [id]);
        recovered += 1;
      }
      await client.query("commit");
      if (recovered)
        getLogger().info("recovered stopped job workers", { "worker.count": recovered });
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  stop(): Promise<void> {
    this.stopping ??= this.close();
    return this.stopping;
  }

  private async close(): Promise<void> {
    if (this.starting) await this.starting.catch(() => undefined);
    clearInterval(this.timer);
    await this.recovering?.catch(() => undefined);
    await this.claiming?.catch(() => undefined);
    const client = this.client;
    if (!client) return;
    this.client = undefined;
    client.removeListener("error", this.connectionLost);
    // Keep the registry row until recovery has released any jobs left by failed
    // shutdown cleanup. Destroying the session releases its advisory lock.
    client.release(true);
  }
}
