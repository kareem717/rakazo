import { ORPCError } from "@orpc/server";
import { createLiveVoiceProvider } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import type { VoiceDeps } from "./voice-connection.js";
import { loadVoiceCredential, voiceScope as scope, voiceContext } from "./voice-connection.js";

function state(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function endLiveCall(
  deps: VoiceDeps,
  actor: Actor,
  callId: string,
  signal?: AbortSignal,
) {
  const session = await deps.prisma.liveCallSession.findFirst({
    where: { ...scope(actor), callId },
  });
  if (!session) return { ok: true as const };
  await deps.prisma.liveCallSession.update({
    where: { id: session.id },
    data: { endedAt: session.endedAt ?? new Date() },
  });
  const resources = state(session.providerState);
  if (!session.remoteSessionId && !Object.keys(resources).length) return { ok: true as const };
  const loaded = await loadVoiceCredential(deps, actor, session.provider);
  if (!loaded)
    throw new ORPCError("BAD_REQUEST", {
      message: "Reconnect the live call provider to end this session.",
    });
  const provider = createLiveVoiceProvider(session.provider);
  const context = voiceContext(
    actor,
    AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
  );
  if (session.remoteSessionId) await provider.end(loaded.apiKey, session.remoteSessionId, context);
  if (Object.keys(resources).length) await provider.dispose(loaded.apiKey, resources, context);
  await deps.prisma.liveCallSession.update({
    where: { id: session.id },
    data: { remoteSessionId: null, providerState: {} },
  });
  return { ok: true as const };
}

/** Reclaim provider resources after a disconnected client outlives the provider's call limit. */
export function startLiveCallCleanup(deps: VoiceDeps) {
  const stop = new AbortController();
  let running = false;
  const timer = setInterval(() => {
    if (running || stop.signal.aborted) return;
    running = true;
    void deps.prisma.liveCallSession
      .findMany({
        where: { expiresAt: { lte: new Date() }, NOT: { providerState: { equals: {} } } },
        select: { spaceId: true, userId: true, callId: true },
        take: 10,
      })
      .then(async (sessions) => {
        for (const session of sessions) {
          if (stop.signal.aborted) break;
          await endLiveCall(
            deps,
            { ...session, email: "", isDeploymentOwner: false },
            session.callId,
            stop.signal,
          );
        }
      })
      .catch(() => {
        if (!stop.signal.aborted) getLogger().warn("Expired live call cleanup will retry");
      })
      .finally(() => {
        running = false;
      });
  }, 60_000);
  timer.unref();
  return () => {
    clearInterval(timer);
    stop.abort();
  };
}

/** A global connection cannot be removed or rotated while its old key still owns live resources. */
export async function closeLiveCallsForProvider(deps: VoiceDeps, actor: Actor, provider: string) {
  const sessions = await deps.prisma.liveCallSession.findMany({
    where: {
      userId: actor.userId,
      provider,
      OR: [{ endedAt: null }, { NOT: { providerState: { equals: {} } } }],
    },
    select: { callId: true, spaceId: true },
  });
  for (const session of sessions)
    await endLiveCall(deps, { ...actor, spaceId: session.spaceId }, session.callId);
}
