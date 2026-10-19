import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { HindsightNetwork } from "./hindsight-client.js";
import { normalizeHindsightUrl } from "./hindsight-client.js";
import {
  HindsightMemoryProvider,
  prepareHindsightConnection,
} from "./hindsight-memory-provider.js";
import { createMemoryProvider } from "./memory-provider-factory.js";

const context: AdapterContext = {
  operationId: "operation-example",
  traceId: "trace-example",
  spaceId: "space-example",
  userId: "user-example",
  botId: "bot-example",
  signal: new AbortController().signal,
};
const settings = {
  baseUrl: "https://memory.example.test/api",
  botBanks: JSON.stringify({ "bot-example": "profile-one", "other-bot": "profile-two" }),
  allowWrites: "true",
};
const config = {
  baseUrl: settings.baseUrl,
  apiKey: "test-key-example",
  botBanks: JSON.parse(settings.botBanks) as Record<string, string>,
  allowWrites: true,
};
const save = {
  botId: "bot-example",
  scope: "isolated" as const,
  content: "Prefer metric units.",
  source: { kind: "durable" as const },
};
const recall = { botId: "bot-example", scope: "isolated" as const, query: "preferences", limit: 5 };
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

function fixture(
  options: {
    status?: string;
    children?: string[];
    extracted?: number;
    mismatch?: boolean;
    missingOperationStatus?: boolean;
  } = {},
) {
  let document:
    | {
        id: string;
        bank_id: string;
        original_text: string;
        memory_unit_count: number;
        tags: string[];
      }
    | undefined;
  let operationId: string | undefined;
  const admissions: Array<Record<string, unknown>> = [];
  let facts: Array<Record<string, unknown>> = [
    { id: "hermes-fact", text: "Existing profile memory.", document_id: "hermes-session" },
  ];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const bank = url.pathname.split("/")[5]!;
    if (url.pathname.endsWith("/stats")) return json({});
    if (url.pathname.endsWith("/memories/recall")) return json({ results: facts });
    if (url.pathname.includes("/operations/"))
      return operationId
        ? json({
            operation_id: operationId,
            status: options.status ?? "completed",
            child_operations: options.children?.map((status, i) => ({
              operation_id: `child-${i}`,
              status,
            })),
          })
        : options.missingOperationStatus
          ? json({ operation_id: url.pathname.split("/").at(-1), status: "not_found" })
          : json({}, 404);
    if (url.pathname.endsWith("/memories") && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      admissions.push(body);
      operationId = body.operation_id;
      const item = body.items[0];
      document = {
        id: item.document_id,
        bank_id: bank,
        original_text: options.mismatch ? "Different content" : item.content,
        memory_unit_count: options.extracted ?? 1,
        tags: item.tags,
      };
      return json({
        success: true,
        bank_id: bank,
        items_count: 1,
        async: true,
        operation_id: operationId,
      });
    }
    if (url.pathname.includes("/documents/")) {
      if (init?.method === "DELETE") {
        const id = document?.id;
        document = undefined;
        return json({ success: true, document_id: id });
      }
      return document ? json(document) : json({}, 404);
    }
    throw new Error("Unexpected test request");
  });
  const network: HindsightNetwork = {
    fetch,
    resolveHostname: async () => [{ address: "203.0.113.15", family: 4 }],
  };
  return {
    fetch,
    network,
    admissions,
    provider: new HindsightMemoryProvider(config, network),
    document: () => document,
    setFacts: (value: Array<Record<string, unknown>>) => {
      facts = value;
    },
    operation: () => operationId,
  };
}

describe("Hindsight memory provider", () => {
  it("is available through the shared provider factory", () => {
    expect(
      createMemoryProvider("hindsight", settings, { apiKey: config.apiKey }).describe().id,
    ).toBe("hindsight");
  });

  it("recalls the matching Hermes bank without filtering out existing memories", async () => {
    const f = fixture();
    const result = await f.provider.recall(recall, context);
    expect(result).toMatchObject({
      ok: true,
      value: [
        { memory: "Existing profile memory.", entity: "profile-one", id: "memory:hermes-fact" },
      ],
    });
    expect(String(f.fetch.mock.calls[0]?.[0])).toBe(
      `${settings.baseUrl}/v1/default/banks/profile-one/memories/recall`,
    );
    const body = JSON.parse(String(f.fetch.mock.calls[0]?.[1]?.body));
    expect(body.types).toEqual(["observation", "world", "experience"]);
    expect(body.tags).toBeUndefined();
    await f.provider.recall({ ...recall, botId: "other-bot" }, { ...context, botId: "other-bot" });
    expect(String(f.fetch.mock.calls[1]?.[0])).toContain("/profile-two/");
  });

  it("does not send requests for an unmapped bot or silently pool banks", async () => {
    const f = fixture();
    expect(await f.provider.recall({ ...recall, botId: "missing" }, context)).toMatchObject({
      ok: false,
    });
    expect(await f.provider.recall({ ...recall, scope: "shared" }, context)).toMatchObject({
      ok: false,
    });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("reads only the bot and explicitly configured shared bank", async () => {
    const f = fixture();
    const provider = new HindsightMemoryProvider(
      { ...config, sharedBankId: "shared-bank" },
      f.network,
    );
    expect(await provider.recall({ ...recall, scope: "shared" }, context)).toMatchObject({
      ok: true,
    });
    expect(f.fetch.mock.calls.map(([url]) => String(url).split("/").at(-3))).toEqual([
      "profile-one",
      "shared-bank",
    ]);
  });

  it("requires completed ingestion and exact source/extraction readback before reporting saved", async () => {
    const f = fixture();
    expect(await f.provider.save(save, context)).toEqual({ ok: true, value: undefined });
    expect(f.admissions).toHaveLength(1);
    expect(f.admissions[0]).toMatchObject({
      async: true,
      items: [{ content: save.content, metadata: { source: "rakazo" } }],
    });
    expect(f.operation()).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/,
    );
    expect(f.document()?.id).toMatch(/^rakazo-[a-f0-9]{32}-[a-f0-9]{32}$/);
    // Repeated saves, including a later run, read back the source rather than append duplicates.
    expect(await f.provider.save(save, { ...context, runId: "later-run" })).toMatchObject({
      ok: true,
    });
    expect(f.admissions).toHaveLength(1);
  });

  it("handles an absent operation reported as 200/not_found before admission", async () => {
    const f = fixture({ missingOperationStatus: true });
    expect(await f.provider.save(save, context)).toMatchObject({ ok: true });
    expect(f.admissions).toHaveLength(1);
  });

  it("writes shared facts only to the explicitly configured shared bank", async () => {
    const f = fixture();
    expect(await f.provider.save({ ...save, scope: "shared" }, context)).toMatchObject({
      ok: false,
    });
    expect(f.fetch).not.toHaveBeenCalled();
    const provider = new HindsightMemoryProvider(
      { ...config, sharedBankId: "shared-bank" },
      f.network,
    );
    expect(await provider.save({ ...save, scope: "shared" }, context)).toMatchObject({ ok: true });
    expect(f.document()?.bank_id).toBe("shared-bank");
    expect(
      await provider.forget({ id: f.document()!.id, entity: "shared-bank" }, context),
    ).toMatchObject({ ok: true });
  });

  it("does not turn a deletion acknowledgement into success while the document remains", async () => {
    const f = fixture();
    await f.provider.save(save, context);
    const id = f.document()!.id;
    const original = f.network.fetch!;
    f.network.fetch = vi.fn(async (url, init) =>
      init?.method === "DELETE" ? json({ success: true, document_id: id }) : original(url, init),
    );
    expect(
      await new HindsightMemoryProvider(config, f.network).forget(
        { id, entity: "profile-one" },
        context,
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining("absence was not verified") });
  });

  it.each([
    { extracted: 0 },
    { mismatch: true },
    { status: "failed" },
    { children: ["failed"] },
    { status: "not_found" },
  ])("refuses incomplete or unverifiable saves: %j", async (options) => {
    const f = fixture(options);
    expect(await f.provider.save(save, context)).toMatchObject({ ok: false });
    expect(f.admissions).toHaveLength(1);
  });

  it("does not report a parent completed while a child is pending", async () => {
    const abort = new AbortController();
    const f = fixture({ children: ["pending"] });
    const promise = f.provider.save(save, { ...context, signal: abort.signal });
    await vi.waitFor(() => expect(f.admissions).toHaveLength(1));
    abort.abort();
    expect(await promise).toMatchObject({
      ok: false,
      error: expect.stringContaining("Operation:"),
    });
  });

  it("never treats a lost acknowledgement as a saved fact and does not retry writes", async () => {
    const f = fixture();
    const original = f.network.fetch!;
    f.network.fetch = vi.fn(async (url, init) => {
      if (init?.method === "POST" && String(url).endsWith("/memories"))
        throw new Error(config.apiKey);
      return original(url, init);
    });
    const result = await new HindsightMemoryProvider(config, f.network).save(save, context);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("Operation:") });
    expect(JSON.stringify(result)).not.toContain(config.apiKey);
    expect(
      vi
        .mocked(f.network.fetch)
        .mock.calls.filter(
          ([url, init]) => init?.method === "POST" && String(url).endsWith("/memories"),
        ),
    ).toHaveLength(1);
  });

  it("keeps recall-only connections and conversation compaction from writing or purging banks", async () => {
    const f = fixture();
    const provider = new HindsightMemoryProvider({ ...config, allowWrites: false }, f.network);
    expect(await provider.save(save, context)).toMatchObject({ ok: false });
    expect(await provider.forget({ id: "hermes-fact" }, context)).toMatchObject({ ok: false });
    expect(
      await provider.save({ ...save, source: { kind: "history", generation: 1 } }, context),
    ).toMatchObject({ ok: true });
    expect(
      await provider.purgeHistory({ botId: save.botId, generations: [1] }, context),
    ).toMatchObject({ ok: true });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("preserves Hermes records and rejects cross-bank deletion before any request", async () => {
    const f = fixture();
    expect(
      await f.provider.forget({ id: "memory:hermes-fact", entity: "profile-one" }, context),
    ).toMatchObject({ ok: false });
    expect(
      await f.provider.forget({ id: "hermes-session", entity: "profile-one" }, context),
    ).toMatchObject({ ok: false });
    expect(
      await f.provider.forget({ id: "rakazo-example", entity: "profile-two" }, context),
    ).toMatchObject({ ok: false });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("forgets only a verified owned document and confirms its absence", async () => {
    const f = fixture();
    await f.provider.save(save, context);
    const id = f.document()!.id;
    f.setFacts([{ id: "fact-example", text: save.content, document_id: id }]);
    expect(await f.provider.recall(recall, context)).toMatchObject({ ok: true, value: [{ id }] });
    expect(
      await f.provider.forget({ id, entity: "profile-one", reason: "Correction" }, context),
    ).toEqual({ ok: true, value: { id, expired: true, reason: "Correction" } });
    expect(f.fetch.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
    expect(
      await f.provider.forget(
        { id, entity: "profile-one" },
        { ...context, userId: "another-user" },
      ),
    ).toMatchObject({ ok: false });
  });

  it("does not convert malformed recall payloads or upstream errors into empty successful results", async () => {
    const f = fixture();
    f.network.fetch = vi.fn(async () => json({}));
    expect(
      await new HindsightMemoryProvider(config, f.network).recall(recall, context),
    ).toMatchObject({ ok: false });
    f.network.fetch = vi.fn(async () => json({ detail: `private-text ${config.apiKey}` }, 401));
    const result = await new HindsightMemoryProvider(config, f.network).recall(recall, context);
    expect(result).toEqual({ ok: false, error: "Hindsight returned HTTP 401." });
  });

  it("honors cancellation before network access", async () => {
    const f = fixture();
    const abort = new AbortController();
    abort.abort();
    expect(await f.provider.recall(recall, { ...context, signal: abort.signal })).toMatchObject({
      ok: false,
    });
    expect(f.fetch).not.toHaveBeenCalled();
  });
});

describe("Hindsight connection setup", () => {
  it("probes mapped banks read-only and separates credentials from persisted settings", async () => {
    const f = fixture();
    const result = await prepareHindsightConnection(settings, { apiKey: config.apiKey }, f.network);
    expect(result.settings).toEqual(settings);
    expect(result.credentials).toEqual({ apiKey: config.apiKey });
    expect(f.fetch.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
      [`${settings.baseUrl}/v1/default/banks/profile-one/stats`, "GET"],
      [`${settings.baseUrl}/v1/default/banks/profile-two/stats`, "GET"],
    ]);
  });

  it("gates private endpoints before sending credentials", async () => {
    const f = fixture();
    await expect(
      prepareHindsightConnection(
        { ...settings, baseUrl: "https://127.0.0.1" },
        { apiKey: config.apiKey },
        f.network,
        { allowPrivateEndpoint: false },
      ),
    ).rejects.toMatchObject({ code: "DEPLOYMENT_OWNER_REQUIRED" });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each([
    "ftp://memory.example.test",
    "http://memory.example.test",
    "https://user:pass@memory.example.test",
    "https://169.254.169.254",
    "https://memory.example.test?token=fake",
    "https://memory.example.test#secret",
  ])("rejects unsafe endpoints %s", (url) => {
    expect(() => normalizeHindsightUrl(url)).toThrow();
  });

  it("rechecks DNS on credentialed requests and blocks metadata rebinding", async () => {
    const f = fixture();
    f.network.resolveHostname = vi
      .fn()
      .mockResolvedValueOnce([{ address: "203.0.113.15", family: 4 }])
      .mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    await expect(
      prepareHindsightConnection(settings, { apiKey: config.apiKey }, f.network),
    ).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("refuses redirects instead of forwarding authorization", async () => {
    const f = fixture();
    f.network.fetch = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: "https://another.example.test" } }),
    );
    await expect(
      prepareHindsightConnection(settings, { apiKey: config.apiKey }, f.network),
    ).rejects.toThrow();
    expect(f.network.fetch).toHaveBeenCalledTimes(1);
  });
});
