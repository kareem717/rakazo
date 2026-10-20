import type { AgentSessionOptions, SessionToken } from "@fishaudio/agent-client";
import { AgentSession } from "@fishaudio/agent-client";
import type { LiveVoiceClientOptions } from "./index.js";

export function fishSessionOptions(options: LiveVoiceClientOptions): AgentSessionOptions {
  const { connection } = options.session;
  if (
    connection.transport !== "livekit" ||
    typeof connection.token !== "string" ||
    typeof connection.livekit_url !== "string" ||
    typeof connection.session_id !== "string"
  ) {
    throw new Error("The live call connection is invalid.");
  }
  return {
    sessionToken: connection as unknown as SessionToken,
    clientToolTimeoutMs: 25_000,
    clientTools: {
      ask_bot: async (params, context) => {
        options.signal.throwIfAborted();
        if (typeof params.text !== "string" || !params.text.trim() || params.text.length > 20000)
          throw new Error("The caller's words are missing.");
        const result = await options.ask(params.text, context.callId);
        return { status: "working", request_id: result.requestId };
      },
      get_bot_result: async (params) => {
        options.signal.throwIfAborted();
        if (typeof params.request_id !== "string" || !params.request_id)
          throw new Error("The bot request is missing.");
        const result = await options.result(params.request_id);
        return { status: result.status, request_id: result.requestId, text: result.text };
      },
    },
    callbacks: {
      onModeChange: options.onMode,
      onUserTranscript: (e) =>
        options.onTranscript({ id: e.segmentId, role: "user", text: e.text, final: e.final }),
      onAgentResponseDelta: (e) =>
        options.onTranscript({ id: e.segmentId, role: "bot", text: e.text, final: false }),
      onAgentResponse: (e) =>
        options.onTranscript({ id: e.segmentId, role: "bot", text: e.text, final: true }),
      onDisconnect: options.onEnd,
      onError: (e) => options.onError(new Error(e.message)),
    },
  };
}

export async function connectFishVoice(options: LiveVoiceClientOptions) {
  options.signal.throwIfAborted();
  const session = await AgentSession.start(fishSessionOptions(options));
  const end = async () => {
    options.signal.removeEventListener("abort", abort);
    await session.end();
  };
  const abort = () => {
    void end().catch(() => undefined);
  };
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) {
    await end();
    options.signal.throwIfAborted();
  }
  return {
    end,
    mute: (muted: boolean) => session.setMicMuted(muted),
    interrupt: () => session.interrupt(),
  };
}
