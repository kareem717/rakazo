import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { createLiveVoiceProvider, LIVE_VOICE_CATALOG } from "@rakazo/adapters";
import type { Actor, LiveCallResult, LiveCallSettings } from "@rakazo/contracts";
import { LiveCallSettingsSchema, MessageBlock } from "@rakazo/contracts";
import { isSecretAskBlock, speechFromBlocks } from "@rakazo/core";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { withSerializableRetry } from "./serializable-retry.js";
import { resolveVoiceTarget } from "./voice.js";
import type { VoiceDeps } from "./voice-connection.js";
import { loadVoiceCredential, voiceScope as scope, voiceContext } from "./voice-connection.js";

export { endLiveCall, startLiveCallCleanup } from "./live-call-cleanup.js";

function json(value: Record<string, unknown>): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function liveCallSettings(
  prisma: PrismaClient,
  actor: Actor,
): Promise<LiveCallSettings> {
  const row = await prisma.spaceCallPreference.findUnique({
    where: { spaceId_userId: scope(actor) },
  });
  return LiveCallSettingsSchema.parse(row?.settings ?? {});
}

export async function liveCallProviders(prisma: PrismaClient, actor: Actor) {
  const credentials = await prisma.userVoiceCredential.findMany({
    where: { userId: actor.userId },
    select: { provider: true },
  });
  return LIVE_VOICE_CATALOG.map((provider) => ({
    ...provider,
    connected: credentials.some((c) => c.provider === provider.id),
  }));
}

export async function setLiveCallSettings(deps: VoiceDeps, actor: Actor, input: LiveCallSettings) {
  const settings = LiveCallSettingsSchema.parse(input);
  if (settings.provider) {
    if (!LIVE_VOICE_CATALOG.some((provider) => provider.id === settings.provider))
      throw new ORPCError("BAD_REQUEST", { message: "Choose a supported live call provider." });
    if (!(await loadVoiceCredential(deps, actor, settings.provider))) {
      throw new ORPCError("BAD_REQUEST", { message: "Connect the live call provider first." });
    }
  }
  await deps.prisma.spaceCallPreference.upsert({
    where: { spaceId_userId: scope(actor) },
    create: { ...scope(actor), settings },
    update: { settings },
  });
  return settings;
}

async function ownedSession(deps: VoiceDeps, actor: Actor, id: string) {
  const session = await deps.prisma.liveCallSession.findFirst({
    where: { id, ...scope(actor), endedAt: null, expiresAt: { gt: new Date() } },
    include: { bot: { select: { thread: { select: { id: true } }, userId: true, spaceId: true } } },
  });
  if (
    !session?.bot.thread ||
    session.bot.userId !== actor.userId ||
    session.bot.spaceId !== actor.spaceId
  )
    throw new IsolationError();
  return { ...session, threadId: session.bot.thread.id };
}

async function assertCallMayListen(prisma: PrismaClient, actor: Actor, botId: string) {
  const waiting = await prisma.run.findFirst({
    where: { ...scope(actor), botId, status: "waiting_input" },
    select: { id: true },
  });
  if (!waiting) return;
  const message = await prisma.message.findFirst({
    where: { runId: waiting.id, role: "bot" },
    orderBy: { seq: "desc" },
    select: { blocks: true },
  });
  const blocks = MessageBlock.array().safeParse(message?.blocks ?? []);
  if (
    blocks.success &&
    blocks.data.some(
      (block) => block.kind === "ask" && isSecretAskBlock(block) && block.status !== "answered",
    )
  ) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Enter the requested secret in Rakazo's secure interface.",
    });
  }
}

export async function startLiveCall(
  deps: VoiceDeps,
  actor: Actor,
  input: { botId: string; callId: string; opening?: string },
  signal?: AbortSignal,
) {
  const settings = await liveCallSettings(deps.prisma, actor);
  const providerId = settings.provider;
  if (!providerId)
    throw new ORPCError("BAD_REQUEST", { message: "Choose a live call provider first." });
  const bot = await deps.prisma.bot.findFirst({
    where: { id: input.botId, ...scope(actor) },
    select: { id: true, name: true },
  });
  if (!bot) throw new IsolationError();
  await assertCallMayListen(deps.prisma, actor, bot.id);
  const target = await resolveVoiceTarget(deps, actor, { botId: bot.id });
  if (target.cred.provider !== providerId)
    throw new ORPCError("BAD_REQUEST", {
      message: "Choose a voice from the live call provider for this bot.",
    });
  const provider = createLiveVoiceProvider(providerId);
  const session = await withSerializableRetry(() =>
    deps.prisma.$transaction(
      async (tx) => {
        const active = await tx.liveCallSession.findFirst({
          where: { userId: actor.userId, endedAt: null, expiresAt: { gt: new Date() } },
        });
        if (active)
          throw new ORPCError("CONFLICT", { message: "End the current live call first." });
        return tx.liveCallSession.create({
          data: {
            ...scope(actor),
            botId: bot.id,
            callId: input.callId,
            provider: providerId,
            expiresAt: new Date(Date.now() + (settings.maxDurationSeconds + 60) * 1000),
          },
        });
      },
      { isolationLevel: "Serializable" },
    ),
  );
  let resources: Record<string, unknown> = {};
  let remoteSessionId: string | undefined;
  try {
    resources = await provider.configure(target.apiKey, settings, voiceContext(actor, signal));
    const saved = await deps.prisma.liveCallSession.updateMany({
      where: { id: session.id, endedAt: null },
      data: { providerState: json(resources) },
    });
    if (!saved.count) throw new ORPCError("CONFLICT", { message: "The call has ended." });
    const connected = await provider.start(
      target.apiKey,
      resources,
      {
        voiceId: target.voiceId,
        botName: bot.name,
        opening: input.opening,
        language: settings.language,
      },
      voiceContext(actor, signal),
    );
    remoteSessionId = connected.remoteSessionId;
    const updated = await deps.prisma.liveCallSession.updateMany({
      where: { id: session.id, endedAt: null },
      data: { remoteSessionId },
    });
    if (!updated.count) throw new ORPCError("CONFLICT", { message: "The call has ended." });
    return { id: session.id, provider: providerId, connection: connected.connection };
  } catch (error) {
    const cleanup = voiceContext(actor, AbortSignal.timeout(15_000));
    if (remoteSessionId)
      await provider.end(target.apiKey, remoteSessionId, cleanup).catch(() => undefined);
    if (Object.keys(resources).length)
      await provider.dispose(target.apiKey, resources, cleanup).catch(() => undefined);
    await deps.prisma.liveCallSession.update({
      where: { id: session.id },
      data: { endedAt: new Date() },
    });
    throw error;
  }
}

export async function liveCallTurn(
  deps: VoiceDeps,
  actor: Actor,
  input: { sessionId: string; turnId: string; text: string },
  dispatch: (input: { botId: string; text: string; clientNonce: string }) => Promise<unknown>,
) {
  const session = await ownedSession(deps, actor, input.sessionId);
  await assertCallMayListen(deps.prisma, actor, session.botId);
  const clientNonce = `call:${session.callId}:${createHash("sha256").update(input.turnId).digest("hex")}`;
  await dispatch({ botId: session.botId, text: input.text, clientNonce });
  const message = await deps.prisma.message.findUnique({
    where: { threadId_clientNonce: { threadId: session.threadId, clientNonce } },
    select: { id: true },
  });
  if (!message) throw new ORPCError("INTERNAL_SERVER_ERROR");
  return { requestId: message.id };
}

/** Wait on authoritative thread events; the browser only forwards the tool intent. */
export async function liveCallResult(
  deps: VoiceDeps & { events: ThreadEvents },
  actor: Actor,
  input: { sessionId: string; requestId: string },
  signal?: AbortSignal,
): Promise<LiveCallResult> {
  const session = await ownedSession(deps, actor, input.sessionId);
  const request = await deps.prisma.message.findFirst({
    where: {
      id: input.requestId,
      threadId: session.threadId,
      role: "user",
      clientNonce: { startsWith: `call:${session.callId}:` },
    },
    select: { runId: true, seq: true },
  });
  if (!request) throw new IsolationError();
  const read = async (): Promise<LiveCallResult> => {
    const run = request.runId
      ? await deps.prisma.run.findFirst({
          where: { id: request.runId, ...scope(actor), botId: session.botId },
          select: { status: true },
        })
      : null;
    const base = { requestId: input.requestId, text: "" };
    if (!run || run.status === "failed" || run.status === "cancelled")
      return { ...base, status: "failed" };
    if (["queued", "leased", "running", "waiting_takeover"].includes(run.status))
      return { ...base, status: "working" };
    const messages = await deps.prisma.message.findMany({
      where: {
        threadId: session.threadId,
        runId: request.runId,
        role: "bot",
        seq: { gt: request.seq },
      },
      orderBy: { seq: "asc" },
      select: { blocks: true },
      take: 50,
    });
    const parsed = messages.flatMap((m) => {
      const p = MessageBlock.array().safeParse(m.blocks);
      return p.success ? p.data : [];
    });
    const text =
      run.status === "waiting_input" &&
      parsed.some((b) => b.kind === "ask" && isSecretAskBlock(b) && b.status !== "answered")
        ? "Enter the requested secret in Rakazo's secure interface."
        : speechFromBlocks(parsed.filter((block) => !isSecretAskBlock(block))).slice(0, 12000);
    return { ...base, status: run.status === "waiting_input" ? "waiting_input" : "complete", text };
  };
  const timeout = AbortSignal.timeout(20_000);
  const stop = new AbortController();
  const combined = AbortSignal.any([timeout, stop.signal, ...(signal ? [signal] : [])]);
  const head = await deps.prisma.event.findFirst({
    where: { threadId: session.threadId },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  const events = deps.events.follow(session.threadId, head?.seq ?? 0, combined);
  try {
    let result = await read();
    while (result.status === "working" && !combined.aborted) {
      const next = await events.next();
      if (next.done || combined.aborted) break;
      // Revalidate ownership/lifetime before delivering a result after a long wait.
      await ownedSession(deps, actor, input.sessionId);
      result = await read();
    }
    signal?.throwIfAborted();
    return result;
  } finally {
    stop.abort();
    void events
      .return(undefined)
      .catch(() => getLogger().warn("Live call result subscription did not close"));
  }
}
