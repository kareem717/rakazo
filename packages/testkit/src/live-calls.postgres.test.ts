import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as adapters from "@rakazo/adapters";
import type { LiveCallConnection, LiveCallResult } from "@rakazo/contracts";
import { LiveCallSettingsSchema } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppHandles } from "../../../apps/api/src/app.js";
import { discardBotIntroFromCreate } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";
const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const suite = hasDb ? describe : describe.skip;

suite("live call bot handoff with PostgreSQL", () => {
  let handles: AppHandles;
  const provider = {
    configure: vi.fn(async () => ({ agentId: "fake-agent", toolIds: ["fake-tool"] })),
    start: vi.fn(async () => ({
      remoteSessionId: "fake-remote-session",
      connection: { token: "fake-call-token" },
    })),
    end: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  };
  beforeAll(async () => {
    const original = adapters.createVoiceProvider;
    vi.spyOn(adapters, "createVoiceProvider").mockImplementation((id) =>
      id === "fish-audio" ? new adapters.ScriptedVoiceProvider() : original(id),
    );
    vi.spyOn(adapters, "createLiveVoiceProvider").mockReturnValue(provider);
    const { createApp } = await import("../../../apps/api/src/app.js");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir: mkdtempSync(path.join(tmpdir(), "rakazo-live-calls-")),
      agentRuntime: "scripted",
      sandboxProvider: "fake",
      phoneCallsEnabled: true,
      authUrl: "http://127.0.0.1:5173",
      webOrigin: "http://127.0.0.1:5173",
    });
  });
  afterAll(async () => {
    await handles?.stop();
    vi.restoreAllMocks();
  });

  it("runs the actual bot, deduplicates provider retries, and isolates settings and results", async () => {
    const stamp = Date.now();
    const owner = await signup(`live-owner-${stamp}@rakazo.test`);
    const other = await signup(`live-other-${stamp}@rakazo.test`);
    const bot = await rpc<{ id: string }>(owner, "bots/create", {
      name: "Live test bot",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    await rpc(owner, "voice/connect", { provider: "fish-audio", apiKey: "fake-fish-key-for-test" });
    await rpc(owner, "bots/update", {
      botId: bot.id,
      voiceProvider: "fish-audio",
      voiceId: "exact-test-voice",
    });
    await rpc(owner, "voice/connect", { provider: "scripted", apiKey: "fake-standard-voice-key" });
    const before = await rpc(owner, "voice/status", {});
    await rpc(
      owner,
      "voice/setCallSettings",
      LiveCallSettingsSchema.parse({ provider: "fish-audio", maxDurationSeconds: 60 }),
    );
    expect(await rpc(owner, "voice/status", {})).toEqual(before);
    expect(await rpc(other, "voice/callSettings", {})).toMatchObject({ provider: null });
    const session = await rpc<LiveCallConnection>(owner, "voice/startLiveCall", {
      botId: bot.id,
      callId: `test-call-${stamp}`,
    });
    expect(JSON.stringify(session)).not.toContain("fake-fish-key-for-test");
    expect(provider.start).toHaveBeenCalledWith(
      "fake-fish-key-for-test",
      expect.anything(),
      expect.objectContaining({ voiceId: "exact-test-voice" }),
      expect.anything(),
    );
    const turn = {
      sessionId: session.id,
      turnId: "provider:opaque/tool-id",
      text: "Hello from a live call",
    };
    const first = await rpc<{ requestId: string }>(owner, "voice/liveTurn", turn);
    expect(await rpc(owner, "voice/liveTurn", turn)).toEqual(first);
    const userMessage = await handles.prisma.message.findUniqueOrThrow({
      where: { id: first.requestId },
    });
    expect(userMessage.runId).toBeTruthy();
    expect(
      await handles.prisma.message.count({
        where: { threadId: userMessage.threadId, clientNonce: userMessage.clientNonce },
      }),
    ).toBe(1);
    await handles.awaitIdle?.();
    const result = await rpc<LiveCallResult>(owner, "voice/liveResult", {
      sessionId: session.id,
      requestId: first.requestId,
    });
    expect(result.status).toBe("complete");
    expect(result.text.length).toBeGreaterThan(0);
    const run = await handles.prisma.run.findUniqueOrThrow({ where: { id: userMessage.runId! } });
    expect(run).toMatchObject({ botId: bot.id, trigger: "user", status: "completed" });
    const denied = await raw(other, "voice/liveResult", {
      sessionId: session.id,
      requestId: first.requestId,
    });
    // IsolationError remains opaque at the RPC boundary, as with thread reads.
    expect(denied.status).toBe(500);
    const deniedWork = await raw(other, "voice/liveTurn", {
      ...turn,
      turnId: "foreign",
      text: "Do work",
    });
    expect(deniedWork.status).toBe(500);
    expect(
      await handles.prisma.message.count({
        where: { threadId: userMessage.threadId, role: "user" },
      }),
    ).toBe(1);
    await rpc(owner, "voice/endLiveCall", { callId: `test-call-${stamp}` });
    expect(provider.end).toHaveBeenCalledWith(
      "fake-fish-key-for-test",
      "fake-remote-session",
      expect.anything(),
    );
    expect(provider.dispose).toHaveBeenCalled();
    const ended = await handles.prisma.liveCallSession.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(ended.endedAt).not.toBeNull();
    expect(ended.providerState).toEqual({});
  });
  async function signup(email: string) {
    const response = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({ email, name: "Live test user", password: "test-password-123" }),
    });
    expect(response.status).toBeLessThan(400);
    return sessionCookieHeader(response);
  }
  async function raw(cookie: string, proc: string, body: unknown) {
    return handles.app.request(`/rpc/${proc}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({ json: body }),
    });
  }
  async function rpc<T>(cookie: string, proc: string, body: unknown): Promise<T> {
    const response = await raw(cookie, proc, body);
    const parsed = (await response.json()) as { json: T };
    expect(response.status, `${proc}: ${JSON.stringify(parsed)}`).toBe(200);
    return discardBotIntroFromCreate(handles, cookie, proc, parsed.json);
  }
});
