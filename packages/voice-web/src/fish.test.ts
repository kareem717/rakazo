import type { LiveCallConnection } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectFishVoice, fishSessionOptions } from "./fish.js";
import type { LiveVoiceClientOptions } from "./index.js";

const sdk = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("@fishaudio/agent-client", () => ({ AgentSession: sdk }));
function options(): LiveVoiceClientOptions {
  return {
    session: {
      id: "local-session",
      provider: "fish-audio",
      connection: {
        transport: "livekit",
        token: "fake-call-token",
        livekit_url: "wss://voice.example.test",
        session_id: "remote-session",
      },
    } as LiveCallConnection,
    signal: new AbortController().signal,
    ask: vi.fn(async () => ({ requestId: "bot-request" })),
    result: vi.fn(async () => ({
      requestId: "bot-request",
      status: "complete" as const,
      text: "The bot completed the task.",
    })),
    onMode: vi.fn(),
    onTranscript: vi.fn(),
    onEnd: vi.fn(),
    onError: vi.fn(),
  };
}
afterEach(() => vi.resetAllMocks());
describe("browser live voice boundary", () => {
  it("hands a caller's request and actual bot result across the provider-neutral boundary", async () => {
    const input = options();
    const config = fishSessionOptions(input);
    const asked = await config.clientTools!.ask_bot!(
      { text: "Check the task" },
      { callId: "tool-1", toolName: "ask_bot" },
    );
    expect(input.ask).toHaveBeenCalledWith("Check the task", "tool-1");
    expect(asked).toEqual({ status: "working", request_id: "bot-request" });
    expect(
      await config.clientTools!.get_bot_result!(
        { request_id: "bot-request" },
        { callId: "tool-2", toolName: "get_bot_result" },
      ),
    ).toEqual({
      status: "complete" as const,
      request_id: "bot-request",
      text: "The bot completed the task.",
    });
    expect(input.result).toHaveBeenCalledWith("bot-request");
  });
  it("rejects malformed tool parameters without sending work to the bot", async () => {
    const input = options();
    const config = fishSessionOptions(input);
    await expect(
      config.clientTools!.ask_bot!(
        { text: { nested: "bad" } },
        { callId: "tool-1", toolName: "ask_bot" },
      ),
    ).rejects.toThrow();
    await expect(
      config.clientTools!.get_bot_result!({}, { callId: "tool-2", toolName: "get_bot_result" }),
    ).rejects.toThrow();
    expect(input.ask).not.toHaveBeenCalled();
    expect(input.result).not.toHaveBeenCalled();
  });
  it("maps streamed transcript segments and completion into shared events", () => {
    const input = options();
    const config = fishSessionOptions(input);
    config.callbacks!.onUserTranscript!({ segmentId: "user-1", text: "Hello", final: true });
    config.callbacks!.onAgentResponse!({ segmentId: "bot-1", text: "Hi" });
    expect(input.onTranscript).toHaveBeenNthCalledWith(1, {
      id: "user-1",
      role: "user",
      text: "Hello",
      final: true,
    });
    expect(input.onTranscript).toHaveBeenNthCalledWith(2, {
      id: "bot-1",
      role: "bot",
      text: "Hi",
      final: true,
    });
  });
  it("closes a transport that finishes connecting after the caller has hung up", async () => {
    const controller = new AbortController();
    const input = { ...options(), signal: controller.signal };
    let resolve!: (value: unknown) => void;
    sdk.start.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const end = vi.fn(async () => undefined);
    const connecting = connectFishVoice(input);
    controller.abort();
    resolve({ end });
    await expect(connecting).rejects.toThrow();
    expect(end).toHaveBeenCalledOnce();
  });
  it("stops an established transport immediately on call cancellation", async () => {
    const controller = new AbortController();
    const end = vi.fn(async () => undefined);
    sdk.start.mockResolvedValue({ end, setMicMuted: vi.fn(), interrupt: vi.fn() });
    await connectFishVoice({ ...options(), signal: controller.signal });
    controller.abort();
    await Promise.resolve();
    expect(end).toHaveBeenCalledOnce();
  });
});
