import type { SecretStore } from "@rakazo/adapter-kit";
import { decodeLoginSecret } from "@rakazo/contracts";
import { redactSecrets } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { effectiveMemoryScope } from "@rakazo/db";
import type { MemoryProviderResolver } from "./memory-provider-factory.js";

/** Only visible text is eligible. Protected cards, attachments, tools and reasoning stay local. */
function visibleText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .flatMap((block) =>
      block?.kind === "text" && typeof block.text === "string" ? [block.text] : [],
    )
    .join("\n")
    .trim();
}

export async function retainRunConversation(
  deps: {
    prisma: PrismaClient;
    memoryProviders: MemoryProviderResolver;
    secretStore: SecretStore;
  },
  runId: string,
): Promise<void> {
  const run = await deps.prisma.run.findUnique({
    where: { id: runId },
    include: {
      bot: { select: { id: true, userId: true, spaceId: true, memoryScope: true } },
      thread: { select: { spaceId: true } },
    },
  });
  if (
    run?.status !== "completed" ||
    !run.sourceMessageId ||
    !["user", "follow_up", "messaging", "call_end"].includes(run.trigger) ||
    run.bot.spaceId !== run.spaceId ||
    run.thread.spaceId !== run.spaceId ||
    run.bot.userId !== run.userId
  )
    return;
  const configured = await deps.memoryProviders.resolve(run.spaceId);
  const since = Date.parse(configured?.conversationRetentionFrom ?? "");
  if (
    !configured?.provider.retainConversation ||
    !Number.isFinite(since) ||
    run.createdAt.getTime() < since
  )
    return;
  const messages = await deps.prisma.message.findMany({
    where: { threadId: run.threadId, OR: [{ runId }, { id: run.sourceMessageId }] },
    orderBy: { seq: "asc" },

    select: {
      id: true,
      runId: true,
      botId: true,
      role: true,
      blocks: true,
      clientNonce: true,
      createdAt: true,
    },
  });
  const source = messages.find((m) => m.id === run.sourceMessageId);
  if (
    source?.role !== "user" ||
    source.createdAt.getTime() < since ||
    source.clientNonce?.startsWith("hermes:")
  )
    return;
  const visible = messages.filter(
    (m) =>
      m.createdAt.getTime() >= since &&
      !m.clientNonce?.startsWith("hermes:") &&
      (m.id === source.id ||
        (m.runId === runId && (m.role === "user" || (m.role === "bot" && m.botId === run.botId)))),
  );
  const credentials = await deps.prisma.botSecret.findMany({
    where: { userId: run.userId, spaceId: run.spaceId, botId: run.botId },
    select: { id: true, ciphertext: true, auth: true },
    take: 100,
  });
  const redactions: string[] = [];
  for (const credential of credentials) {
    const plaintext = await deps.secretStore.load(credential.ciphertext, credential.id);
    const auth = credential.auth as { type?: string } | null;
    const values =
      auth?.type === "login" ? Object.values(decodeLoginSecret(plaintext)) : [plaintext];
    for (const value of values)
      if (value) {
        redactions.push(value, Buffer.from(value).toString("base64"));
        try {
          redactions.push(encodeURIComponent(value));
        } catch {
          /* raw value still redacted */
        }
      }
  }
  const content = visible
    .flatMap((message) => {
      const text = redactSecrets(visibleText(message.blocks), redactions);
      return text
        ? [
            `[${message.createdAt.toISOString()}] ${message.role === "bot" ? "assistant" : message.role}: ${text}\n`,
          ]
        : [];
    })
    .join("");
  if (!content.trim()) return;
  // Redact before partitioning. Bound each source without splitting UTF-8 or dropping messages.
  const bytes = Buffer.from(content);
  let part = 0;
  for (let offset = 0; offset < bytes.length; part++) {
    let end = Math.min(offset + 32 * 1024, bytes.length);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    const result = await configured.provider.retainConversation(
      {
        botId: run.botId,
        runId,
        part,
        createdAt: run.createdAt.toISOString(),
        content: bytes.subarray(offset, end).toString(),
        scope: effectiveMemoryScope(run.bot.memoryScope, configured.defaultScope),
      },
      {
        operationId: `conversation-retain:${runId}:${part}`,
        traceId: `conversation-retain:${runId}`,
        spaceId: run.spaceId,
        userId: run.userId,
        botId: run.botId,
        runId,
        signal: AbortSignal.timeout(150_000),
      },
    );
    if (!result.ok) throw new Error("Automatic conversation retention was not confirmed; retrying");
    offset = end;
  }
}
