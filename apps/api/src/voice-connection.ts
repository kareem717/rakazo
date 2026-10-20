import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { findDefaultVoiceCredential, findVoiceCredential } from "@rakazo/db";

export interface VoiceDeps {
  prisma: PrismaClient;
  secrets: SecretStore;
}
export function voiceScope(actor: Actor) {
  return { spaceId: actor.spaceId, userId: actor.userId };
}

export function voiceContext(actor: Actor, signal?: AbortSignal): AdapterContext {
  return {
    operationId: "voice",
    traceId: "voice",
    spaceId: actor.spaceId,
    userId: actor.userId,
    signal: signal ?? new AbortController().signal,
  };
}

export async function loadVoiceCredential(deps: VoiceDeps, actor: Actor, provider?: string) {
  const cred = provider
    ? await findVoiceCredential(deps.prisma, actor, provider)
    : await findDefaultVoiceCredential(deps.prisma, actor);
  if (!cred) return null;
  const secret = await deps.prisma.secret.findFirst({
    where: { id: cred.secretId, userId: actor.userId, spaceId: null },
  });
  if (!secret) return null;
  return { cred, apiKey: await deps.secrets.load(secret.ciphertext, secret.id) };
}
