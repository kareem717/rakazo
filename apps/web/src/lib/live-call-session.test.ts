import type { ProductEvent } from "@rakazo/contracts";
import type * as Core from "@rakazo/core";
import { runThreadSubscription } from "@rakazo/core";
import type { LiveVoiceClientOptions } from "@rakazo/voice-web";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { endCall, getSnapshot, startCall, toggleMute } from "./call-session.js";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  end: vi.fn(async () => undefined),
  mute: vi.fn(async () => undefined),
  settings: vi.fn(async () => ({ provider: "fish-audio" })),
  start: vi.fn(async (_input: { botId: string; callId: string }, _options?: unknown) => ({
    id: "session-1",
    provider: "fish-audio",
    connection: { token: "fake" },
  })),
  close: vi.fn(async () => ({ ok: true })),
  turn: vi.fn(async () => ({ requestId: "request-1" })),
  result: vi.fn(async () => ({ status: "complete", requestId: "request-1", text: "Done" })),
  closeThread: vi.fn(async () => ({ ok: true })),
  listen: vi.fn(),
  speak: vi.fn(),
  space: "space-1",
  bind: vi.fn(),
}));
vi.mock("@rakazo/voice-web", () => ({ connectLiveVoice: mocks.connect }));
vi.mock("@rakazo/core", async (original) => ({
  ...(await original<typeof Core>()),
  runThreadSubscription: vi.fn(async () => undefined),
}));
vi.mock("./call-pickup.js", () => ({ pickUp: vi.fn(async () => undefined) }));
vi.mock("./dictation.js", () => ({
  dictation: { listen: mocks.listen, stop: vi.fn(), subscribe: () => () => undefined },
}));
vi.mock("./tts.js", () => ({
  speaker: {
    speak: mocks.speak,
    stop: vi.fn(),
    isSpeaking: () => false,
    subscribe: () => () => undefined,
  },
}));
vi.mock("./rpc.js", () => {
  const rpc = {
    voice: {
      callSettings: mocks.settings,
      startLiveCall: mocks.start,
      endLiveCall: mocks.close,
      liveTurn: mocks.turn,
      liveResult: mocks.result,
    },
    threads: { endCall: mocks.closeThread },
  };
  return {
    rpc,
    createSpaceRpc: (space: string) => {
      mocks.bind(space);
      return rpc;
    },
    selectedSpaceId: () => mocks.space,
  };
});
let options: LiveVoiceClientOptions;
beforeEach(() => {
  endCall();
  vi.clearAllMocks();
  mocks.space = "space-1";
  mocks.start.mockResolvedValue({
    id: "session-1",
    provider: "fish-audio",
    connection: { token: "fake" },
  });
  mocks.connect.mockImplementation(async (value) => {
    options = value;
    return { end: mocks.end, mute: mocks.mute, interrupt: vi.fn() };
  });
});
afterEach(() => endCall());
async function start() {
  startCall({ botId: "bot-1", botName: "Example bot" });
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
it("connects the selected live provider and uses the existing bot's authenticated tool routes", async () => {
  await start();
  expect(mocks.bind).toHaveBeenCalledWith("space-1");
  expect(mocks.start).toHaveBeenCalledWith(
    expect.objectContaining({ botId: "bot-1", callId: expect.any(String) }),
    expect.anything(),
  );
  expect(mocks.listen).not.toHaveBeenCalled();
  expect(mocks.speak).not.toHaveBeenCalled();
  await options.ask("Check the task", "tool-1");
  await options.result("request-1");
  expect(mocks.turn).toHaveBeenCalledWith({
    sessionId: "session-1",
    turnId: "tool-1",
    text: "Check the task",
  });
  expect(mocks.result).toHaveBeenCalledWith(
    { sessionId: "session-1", requestId: "request-1" },
    expect.anything(),
  );
  options.onTranscript({ id: "user-1", role: "user", text: "Check the task", final: true });
  options.onTranscript({ id: "bot-1", role: "bot", text: "Done", final: true });
  expect(getSnapshot()?.exchanges).toEqual([
    { role: "user", text: "Check the task" },
    { role: "bot", text: "Done" },
  ]);
  toggleMute();
  expect(mocks.mute).toHaveBeenCalledWith(true);
  endCall();
  await Promise.resolve();
  expect(mocks.close).toHaveBeenCalledWith({ callId: mocks.start.mock.calls[0]![0].callId });
});
it("does not connect a late session after the caller hangs up", async () => {
  let resolve!: (value: unknown) => void;
  mocks.start.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }) as never,
  );
  await start();
  endCall();
  resolve({ id: "session-1", provider: "fish-audio", connection: { token: "fake" } });
  for (let i = 0; i < 6; i++) await Promise.resolve();
  expect(mocks.connect).not.toHaveBeenCalled();
  expect(getSnapshot()).toBeNull();
  expect(mocks.close).toHaveBeenCalledOnce();
});
it("releases the live provider after the bot has already closed its thread call", async () => {
  await start();
  const callId = mocks.start.mock.calls[0]![0].callId;
  const feed = vi.mocked(runThreadSubscription).mock.calls[0]?.[0];
  feed?.onEvent?.({ type: "thread.call.ended", payload: { callId } } as ProductEvent, {
    threadId: "thread-1",
    cursor: 1,
  });
  options.onEnd();
  await Promise.resolve();
  expect(mocks.close).toHaveBeenCalledWith({ callId });
  expect(mocks.closeThread).not.toHaveBeenCalled();
});
it("closes the paid session if the transport fails instead of silently switching providers", async () => {
  mocks.connect.mockRejectedValueOnce(new Error("Transport unavailable"));
  await start();
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(getSnapshot()).toMatchObject({ muted: true, caption: "Transport unavailable" });
  expect(mocks.listen).not.toHaveBeenCalled();
});
