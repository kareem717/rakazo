import type { AdapterContext } from "@rakazo/adapter-kit";
import { assertLiveVoiceConformance } from "@rakazo/adapter-kit/testing";
import { describe, expect, it, vi } from "vitest";
import { FISH_LIVE_DEFAULTS, FishLiveVoiceProvider, LIVE_BOT_PROMPT } from "./fish-live-voice.js";

const context: AdapterContext = {
  operationId: "test",
  traceId: "test",
  userId: "user-1",
  spaceId: "space-1",
  signal: new AbortController().signal,
};
function harness() {
  let tool = 0;
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const path = String(input).replace("https://api.fish.audio/v1/agent", "");
    if (init?.method === "DELETE" || path.endsWith("/end"))
      return new Response(null, { status: 204 });
    if (path === "/tools") return Response.json({ tool_id: `tool-${++tool}` });
    if (path === "/agents") return Response.json({ agent_id: "agent-1" });
    if (path.endsWith("/publish")) return Response.json({ version_number: 1 });
    if (path === "/sessions")
      return Response.json({
        session_id: "session-1",
        expires_at: "2030-01-01T00:00:00Z",
        max_duration_seconds: 1800,
        transport: "livekit",
        livekit_url: "wss://voice.example.test",
        token: "fake-single-use-token",
      });
    throw new Error("Unexpected request");
  });
  return { fetcher, provider: new FishLiveVoiceProvider(fetcher) };
}

describe("Fish live call provider", () => {
  it("conforms to the shared live voice lifecycle offline", async () => {
    const { provider } = harness();
    await assertLiveVoiceConformance(provider, FISH_LIVE_DEFAULTS, context);
  });
  it("provisions a private voice interface, preserves the exact bot voice, and closes its resources", async () => {
    const { provider, fetcher } = harness();
    const settings = {
      ...FISH_LIVE_DEFAULTS,
      modelId: "google/gemini-3.5-flash-lite",
      speechModel: "s2.1-pro",
      maxDurationSeconds: 600,
    };
    const resources = await provider.configure("fake-api-key", settings, context);
    const session = await provider.start(
      "fake-api-key",
      resources,
      { voiceId: "exact-bot-voice", botName: "Example bot", language: "en" },
      context,
    );
    expect(session.remoteSessionId).toBe("session-1");
    expect(JSON.stringify(session.connection)).not.toContain("fake-api-key");
    const bodies = fetcher.mock.calls.map(([url, init]) => ({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    }));
    const agent = bodies.find((c) => c.url.endsWith("/agents"))!.body;
    expect(agent.config).toMatchObject({
      llm: { model: settings.modelId },
      voice: { tts_model: settings.speechModel },
      conversation: { record_audio: false, max_duration_seconds: 600 },
      tools: { tool_ids: ["tool-1", "tool-2"] },
    });
    expect(agent.config.prompt.system_prompt).toBe(LIVE_BOT_PROMPT);
    expect(bodies.find((c) => c.url.endsWith("/sessions"))!.body).toMatchObject({
      record_audio: false,
      overrides: { voice_id: "exact-bot-voice" },
      dynamic_variables: { bot_name: "Example bot" },
    });
    await provider.end("fake-api-key", session.remoteSessionId, context);
    await provider.dispose("fake-api-key", resources, context);
    expect(
      fetcher.mock.calls
        .slice(-4)
        .map(([url]) => String(url).replace("https://api.fish.audio/v1/agent", "")),
    ).toEqual(["/sessions/session-1/end", "/agents/agent-1", "/tools/tool-1", "/tools/tool-2"]);
  });
  it("cleans up a partial provisioning failure without exposing the upstream body", async () => {
    const { provider, fetcher } = harness();
    fetcher.mockImplementationOnce(async () => Response.json({ tool_id: "tool-1" }));
    fetcher.mockImplementationOnce(async () =>
      Response.json({ message: "fake-api-key private account detail" }, { status: 402 }),
    );
    await expect(provider.configure("fake-api-key", FISH_LIVE_DEFAULTS, context)).rejects.toThrow(
      "Add Fish Audio API credit",
    );
    expect(fetcher.mock.calls.at(-1)).toMatchObject([
      expect.stringContaining("/tools/tool-1"),
      { method: "DELETE" },
    ]);
  });
  it("ends a session when the returned transport is unsafe or unsupported", async () => {
    const { provider, fetcher } = harness();
    fetcher.mockImplementationOnce(async () =>
      Response.json({
        session_id: "session-1",
        transport: "livekit",
        livekit_url: "http://example.test",
        token: "fake",
      }),
    );
    await expect(
      provider.start(
        "fake-api-key",
        { agentId: "agent-1" },
        { voiceId: "voice", botName: "Bot", language: "en" },
        context,
      ),
    ).rejects.toThrow("unsupported");
    expect(fetcher.mock.calls.at(-1)?.[0]).toBe(
      "https://api.fish.audio/v1/agent/sessions/session-1/end",
    );
  });
  it("allows cleanup to be retried after a resource was already removed", async () => {
    const provider = new FishLiveVoiceProvider(
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    await expect(provider.end("fake-api-key", "session-1", context)).resolves.toBeUndefined();
    await expect(
      provider.dispose("fake-api-key", { agentId: "agent-1", toolIds: ["tool-1"] }, context),
    ).resolves.toBeUndefined();
  });
  it("does not accept a provider resource path as an identifier", async () => {
    const { provider, fetcher } = harness();
    await expect(
      provider.start(
        "fake-api-key",
        { agentId: "../other" },
        { voiceId: "voice", botName: "Bot", language: "en" },
        context,
      ),
    ).rejects.toThrow("invalid resource");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
