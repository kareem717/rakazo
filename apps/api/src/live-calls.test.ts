import * as adapters from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { LiveCallSettingsSchema } from "@rakazo/contracts";
import type { ThreadEvents } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  endLiveCall,
  liveCallResult,
  liveCallTurn,
  setLiveCallSettings,
  startLiveCall,
} from "./live-calls.js";
import type { VoiceDeps } from "./voice.js";
import * as voice from "./voice.js";
import * as voiceConnections from "./voice-connection.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@example.test",
  isDeploymentOwner: false,
};
const settings = LiveCallSettingsSchema.parse({ provider: "fish-audio" });
function harness() {
  const session = {
    id: "session-1",
    spaceId: actor.spaceId,
    userId: actor.userId,
    botId: "bot-1",
    callId: "call-1",
    provider: "fish-audio",
    endedAt: null,
    expiresAt: new Date(Date.now() + 60000),
    remoteSessionId: "remote-1",
    providerState: { agentId: "agent-1" },
    bot: { userId: actor.userId, spaceId: actor.spaceId, thread: { id: "thread-1" } },
  };
  const provider = {
    configure: vi.fn(async () => ({ agentId: "agent-1", toolIds: ["tool-1", "tool-2"] })),
    start: vi.fn(async () => ({
      remoteSessionId: "remote-1",
      connection: { token: "fake-session-token" },
    })),
    end: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  };
  const prisma = {
    spaceCallPreference: { findUnique: vi.fn(async () => ({ settings })), upsert: vi.fn() },
    bot: { findFirst: vi.fn(async () => ({ id: "bot-1", name: "Example bot" })) },
    liveCallSession: {
      findFirst: vi.fn(async () => session),
      create: vi.fn(async () => session),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    message: {
      findFirst: vi.fn(async () => ({ blocks: [], runId: "run-1", seq: 4 })),
      findUnique: vi.fn(async () => ({ id: "request-1" })),
      findMany: vi.fn(async () => [
        { blocks: [{ kind: "text", text: "The actual bot's answer." }] },
      ]),
    },
    run: { findFirst: vi.fn(async () => ({ status: "completed" })) },
    event: { findFirst: vi.fn(async () => ({ seq: 8 })) },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };
  const deps = { prisma, secrets: {} } as unknown as VoiceDeps;
  vi.spyOn(adapters, "createLiveVoiceProvider").mockReturnValue(provider);
  vi.spyOn(voiceConnections, "loadVoiceCredential").mockResolvedValue({
    apiKey: "fake-api-key",
    cred: { provider: "fish-audio" },
  } as never);
  vi.spyOn(voice, "resolveVoiceTarget").mockResolvedValue({
    apiKey: "fake-api-key",
    voiceId: "exact-voice",
    cred: { provider: "fish-audio" },
  } as never);
  return { deps, prisma, provider, session };
}
afterEach(() => vi.restoreAllMocks());

describe("live calls", () => {
  it("keeps call selection independent from the speech and transcription defaults", async () => {
    const { deps, prisma, provider } = harness();
    const saved = await setLiveCallSettings(deps, actor, settings);
    expect(saved.provider).toBe("fish-audio");
    expect(prisma.spaceCallPreference.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
        update: { settings: saved },
      }),
    );
    await setLiveCallSettings(deps, actor, { ...settings, provider: null });
    expect(provider.configure).not.toHaveBeenCalled();
  });
  it("requires the selected connection and refuses to borrow a different bot voice", async () => {
    const { deps, provider } = harness();
    vi.mocked(voiceConnections.loadVoiceCredential).mockResolvedValueOnce(null);
    await expect(setLiveCallSettings(deps, actor, settings)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    vi.mocked(voice.resolveVoiceTarget).mockResolvedValueOnce({
      cred: { provider: "elevenlabs" },
    } as never);
    await expect(
      startLiveCall(deps, actor, { botId: "bot-1", callId: "call-1" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(provider.configure).not.toHaveBeenCalled();
  });
  it("uses the owned bot's exact voice and returns only its short-lived connection", async () => {
    const { deps, prisma, provider } = harness();
    prisma.liveCallSession.findFirst.mockResolvedValueOnce(null as never);
    const result = await startLiveCall(deps, actor, { botId: "bot-1", callId: "call-1" });
    expect(result).toEqual({
      id: "session-1",
      provider: "fish-audio",
      connection: { token: "fake-session-token" },
    });
    expect(JSON.stringify(result)).not.toContain("fake-api-key");
    expect(prisma.bot.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "bot-1", spaceId: actor.spaceId, userId: actor.userId },
      }),
    );
    expect(provider.start).toHaveBeenCalledWith(
      "fake-api-key",
      expect.anything(),
      expect.objectContaining({ voiceId: "exact-voice", botName: "Example bot" }),
      expect.anything(),
    );
  });
  it("blocks concurrent calls before any billable connection is created", async () => {
    const { deps, provider } = harness();
    await expect(
      startLiveCall(deps, actor, { botId: "bot-1", callId: "call-2" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(provider.configure).not.toHaveBeenCalled();
    expect(provider.start).not.toHaveBeenCalled();
  });
  it("cleans up if the caller hangs up during provisioning", async () => {
    const { deps, prisma, provider } = harness();
    prisma.liveCallSession.findFirst.mockResolvedValueOnce(null as never);
    prisma.liveCallSession.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      startLiveCall(deps, actor, { botId: "bot-1", callId: "call-1" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(provider.dispose).toHaveBeenCalledOnce();
    expect(provider.start).not.toHaveBeenCalled();
  });
  it("ends the remote session and removes its resources under the caller's scope", async () => {
    const { deps, prisma, provider } = harness();
    await endLiveCall(deps, actor, "call-1");
    expect(prisma.liveCallSession.findFirst).toHaveBeenCalledWith({
      where: { spaceId: actor.spaceId, userId: actor.userId, callId: "call-1" },
    });
    expect(provider.end).toHaveBeenCalledWith("fake-api-key", "remote-1", expect.anything());
    expect(provider.dispose).toHaveBeenCalledWith(
      "fake-api-key",
      { agentId: "agent-1" },
      expect.anything(),
    );
    expect(prisma.liveCallSession.update).toHaveBeenLastCalledWith({
      where: { id: "session-1" },
      data: { remoteSessionId: null, providerState: {} },
    });
  });
  it("forwards a tool request to the actual bot using a stable call nonce", async () => {
    const { deps, prisma } = harness();
    const dispatch = vi.fn(async () => undefined);
    await expect(
      liveCallTurn(
        deps,
        actor,
        { sessionId: "session-1", turnId: "tool-call-1", text: "Check the task" },
        dispatch,
      ),
    ).resolves.toEqual({ requestId: "request-1" });
    expect(dispatch).toHaveBeenCalledWith({
      botId: "bot-1",
      text: "Check the task",
      clientNonce: expect.stringMatching(/^call:call-1:[a-f0-9]{64}$/),
    });
    expect(prisma.message.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          threadId_clientNonce: {
            threadId: "thread-1",
            clientNonce: expect.stringMatching(/^call:call-1:[a-f0-9]{64}$/),
          },
        },
      }),
    );
  });
  it("rejects an expired or foreign session before it can dispatch work", async () => {
    const { deps, prisma } = harness();
    prisma.liveCallSession.findFirst.mockResolvedValueOnce(null as never);
    const dispatch = vi.fn();
    await expect(
      liveCallTurn(deps, actor, { sessionId: "foreign", turnId: "turn-1", text: "work" }, dispatch),
    ).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
    expect(prisma.liveCallSession.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "foreign",
          userId: actor.userId,
          spaceId: actor.spaceId,
          endedAt: null,
          expiresAt: { gt: expect.any(Date) },
        }),
      }),
    );
  });
  it("reads an answer from the actual bot's run, with a request restricted to this call", async () => {
    const { deps, prisma } = harness();
    const events = { follow: vi.fn(async function* () {}) } as unknown as ThreadEvents;
    await expect(
      liveCallResult({ ...deps, events }, actor, {
        sessionId: "session-1",
        requestId: "request-1",
      }),
    ).resolves.toEqual({
      status: "complete",
      requestId: "request-1",
      text: "The actual bot's answer.",
    });
    expect(prisma.message.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "request-1",
          threadId: "thread-1",
          role: "user",
          clientNonce: { startsWith: "call:call-1:" },
        },
      }),
    );
    expect(prisma.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "run-1", userId: actor.userId, spaceId: actor.spaceId, botId: "bot-1" },
      }),
    );
  });
  it("does not turn a failed bot run into a successful spoken result", async () => {
    const { deps, prisma } = harness();
    prisma.run.findFirst.mockResolvedValueOnce({ status: "failed" });
    const events = { follow: vi.fn(async function* () {}) } as unknown as ThreadEvents;
    await expect(
      liveCallResult({ ...deps, events }, actor, {
        sessionId: "session-1",
        requestId: "request-1",
      }),
    ).resolves.toMatchObject({ status: "failed", text: "" });
    expect(prisma.message.findMany).not.toHaveBeenCalled();
  });
});

it("keeps live listening off while a bot is waiting for a secret", async () => {
  const { deps, prisma, provider } = harness();
  prisma.run.findFirst.mockResolvedValueOnce({ id: "run-1" } as never);
  prisma.message.findFirst.mockResolvedValueOnce({
    blocks: [{ kind: "ask", text: "Enter the code", input: "secret", status: "pending" }],
  } as never);
  await expect(
    startLiveCall(deps, actor, { botId: "bot-1", callId: "call-1" }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(provider.configure).not.toHaveBeenCalled();
});
it("does not disclose a secret-bearing ask as a voice tool result", async () => {
  const { deps, prisma } = harness();
  prisma.run.findFirst.mockResolvedValueOnce({ status: "waiting_input" });
  prisma.message.findMany.mockResolvedValueOnce([
    {
      blocks: [
        {
          kind: "ask",
          text: "Enter the code",
          input: "secret",
          answer: "fake-private-value",
          status: "pending",
        },
      ],
    },
  ] as never);
  const events = { follow: vi.fn(async function* () {}) } as unknown as ThreadEvents;
  const result = await liveCallResult({ ...deps, events }, actor, {
    sessionId: "session-1",
    requestId: "request-1",
  });
  expect(result.status).toBe("waiting_input");
  expect(result.text).toContain("secure interface");
  expect(JSON.stringify(result)).not.toContain("fake-private-value");
});
it("keeps a completed answer readable after a secret was entered securely", async () => {
  const { deps, prisma } = harness();
  prisma.message.findMany.mockResolvedValueOnce([
    {
      blocks: [
        {
          kind: "ask",
          text: "Enter the code",
          input: "secret",
          answer: "fake-private-value",
          status: "answered",
        },
        { kind: "text", text: "The task is complete." },
      ],
    },
  ] as never);
  const events = { follow: vi.fn(async function* () {}) } as unknown as ThreadEvents;
  await expect(
    liveCallResult({ ...deps, events }, actor, { sessionId: "session-1", requestId: "request-1" }),
  ).resolves.toEqual({ status: "complete", requestId: "request-1", text: "The task is complete." });
});
it("rejects a result belonging to another call before reading its run", async () => {
  const { deps, prisma } = harness();
  prisma.message.findFirst.mockResolvedValueOnce(null as never);
  const events = { follow: vi.fn(async function* () {}) } as unknown as ThreadEvents;
  await expect(
    liveCallResult({ ...deps, events }, actor, {
      sessionId: "session-1",
      requestId: "other-request",
    }),
  ).rejects.toThrow();
  expect(prisma.run.findFirst).not.toHaveBeenCalled();
});
