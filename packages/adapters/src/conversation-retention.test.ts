import type { SecretStore } from "@rakazo/adapter-kit";
import { encodeLoginSecret } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { retainRunConversation } from "./conversation-retention.js";
import type { MemoryProviderResolver } from "./memory-provider-factory.js";

function fixture() {
  const at = new Date("2026-10-19T12:00:00Z");
  const run = {
    id: "run-1",
    status: "completed",
    trigger: "user",
    sourceMessageId: "user-1",
    userId: "owner",
    spaceId: "space-1",
    botId: "bot-1",
    threadId: "thread-1",
    createdAt: at,
    bot: { id: "bot-1", userId: "owner", spaceId: "space-1", memoryScope: null },
    thread: { spaceId: "space-1" },
  };
  const messages = [
    {
      id: "user-1",
      role: "user",
      runId: null as string | null,
      botId: null as string | null,
      clientNonce: null as string | null,
      createdAt: at,
      blocks: [{ kind: "text", text: "Prefer metric units." }],
    },
    {
      id: "assistant-1",
      role: "bot",
      runId: "run-1",
      botId: "bot-1",
      clientNonce: null,
      createdAt: at,
      blocks: [{ kind: "text", text: "Understood." }],
    },
  ];
  const retain = vi.fn(async () => ({ ok: true as boolean, value: undefined }));
  const configured = {
    conversationRetentionFrom: "2026-10-19T00:00:00Z" as string | undefined,
    provider: { retainConversation: retain },
    defaultScope: "isolated" as const,
  };
  const prisma = {
    run: { findUnique: vi.fn(async () => run) },
    message: { findMany: vi.fn(async () => messages) },
    botSecret: {
      findMany: vi.fn(async () => [] as Array<{ id: string; ciphertext: string; auth: unknown }>),
    },
  };
  const secretStore = { load: vi.fn(async () => "") };
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    memoryProviders: {
      resolve: vi.fn(async () => configured),
    } as unknown as MemoryProviderResolver,
    secretStore: secretStore as unknown as SecretStore,
  };
  return { deps, run, messages, retain, configured, prisma, secretStore };
}

describe("automatic conversation retention", () => {
  it("retains scoped visible dialogue after completion and excludes protected blocks and other bots", async () => {
    const f = fixture();
    f.messages[1]!.blocks.push(
      { kind: "reasoning", text: "hidden-reasoning" },
      { kind: "ask", text: "protected-card" },
      { kind: "tool_result", text: "raw-tool-output" },
    );
    f.messages.push({
      ...f.messages[1]!,
      id: "other",
      botId: "other-bot",
      blocks: [{ kind: "text", text: "other-bot-private" }],
    });
    await retainRunConversation(f.deps, f.run.id);
    const [request, context] = f.retain.mock.calls[0] as unknown as [
      { content: string; scope: string },
      { botId: string; spaceId: string },
    ];
    expect(request.content).toContain("user: Prefer metric units.");
    expect(request.content).toContain("assistant: Understood.");
    for (const hidden of [
      "hidden-reasoning",
      "protected-card",
      "raw-tool-output",
      "other-bot-private",
    ])
      expect(request.content).not.toContain(hidden);
    expect(request.scope).toBe("isolated");
    expect(context).toMatchObject({ botId: "bot-1", spaceId: "space-1" });
    expect(f.prisma.message.findMany.mock.calls[0]).toMatchObject([
      { where: { threadId: "thread-1", OR: [{ runId: "run-1" }, { id: "user-1" }] } },
    ]);
  });

  it.each([
    "disabled",
    "old-run",
    "imported-source",
    "old-source",
    "failed",
    "routine",
    "cross-space",
  ])("skips %s without ingestion", async (kind) => {
    const f = fixture();
    if (kind === "disabled") f.configured.conversationRetentionFrom = undefined;
    if (kind === "old-run") f.run.createdAt = new Date("2026-10-18T00:00:00Z");
    if (kind === "imported-source") f.messages[0]!.clientNonce = "hermes:profile:message";
    if (kind === "old-source") f.messages[0]!.createdAt = new Date("2026-10-18T00:00:00Z");
    if (kind === "failed") f.run.status = "failed";
    if (kind === "routine") f.run.trigger = "routine";
    if (kind === "cross-space") f.run.thread.spaceId = "other-space";
    await retainRunConversation(f.deps, f.run.id);
    expect(f.retain).not.toHaveBeenCalled();
  });

  it("redacts stored passwords and MFA seeds before partitioning long UTF-8 dialogue", async () => {
    const f = fixture();
    const secret = "fake-retention-password";
    const seed = "JBSWY3DPEHPK3PXP";
    f.prisma.botSecret.findMany.mockResolvedValue([
      { id: "credential-1", ciphertext: "encrypted", auth: { type: "login" } },
    ]);
    f.secretStore.load.mockResolvedValue(
      encodeLoginSecret({ username: "fake-user", password: secret, mfaSecret: seed }),
    );
    f.messages[0]!.blocks = [{ kind: "text", text: "😊".repeat(20000) + secret + seed }];
    await retainRunConversation(f.deps, f.run.id);
    expect(f.retain.mock.calls.length).toBeGreaterThan(1);
    const calls = f.retain.mock.calls as unknown as Array<[{ content: string; part: number }]>;
    const combined = calls.map(([r]) => r.content).join("");
    expect(combined).toContain("😊".repeat(20000));
    expect(combined).not.toContain(secret);
    expect(combined).not.toContain(seed);
    expect(combined).not.toContain("�");
    for (const [r] of calls) expect(Buffer.byteLength(r.content)).toBeLessThanOrEqual(32 * 1024);
  });

  it("leaves the completed run untouched and retries an unconfirmed retain", async () => {
    const f = fixture();
    f.retain.mockResolvedValue({ ok: false, value: undefined });
    await expect(retainRunConversation(f.deps, f.run.id)).rejects.toThrow("not confirmed");
    expect(f.run.status).toBe("completed");
  });
});
