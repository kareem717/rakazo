import type { AdapterContext, LiveVoiceProvider } from "@rakazo/adapter-kit";
import type { LiveCallSettings } from "@rakazo/contracts";
import { LiveCallSettingsSchema } from "@rakazo/contracts";
import { readVoiceJson, voiceDeadline } from "./voice-http.js";

const API = "https://api.fish.audio/v1/agent";
export const FISH_LIVE_DEFAULTS = LiveCallSettingsSchema.parse({
  provider: "fish-audio",
  modelId: "openai/gpt-5.6-luna",
  speechModel: "drama-3",
  transcriptionModel: "deepgram:nova-3",
});

/** The voice model may acknowledge and relay, but all answers and work come from the bot. */
export const LIVE_BOT_PROMPT = `You are the live voice interface for the existing Rakazo bot named {{bot_name}}.
For every caller request, question, correction, or follow-up, call ask_bot with the caller's exact words. Never answer from your own knowledge, make decisions, execute work, or invent progress or results. The Rakazo bot has the real conversation, memory, tools, and permissions.
You may briefly acknowledge the caller while the bot works. Use get_bot_result with the returned request_id until it is no longer working. Stay available for interruptions and new requests while work continues. Do not repeatedly announce that you are waiting.
When the result is complete, speak its text faithfully, preserving meaning and any uncertainty. When waiting_input, ask the bot's question. When failed, report the failure without claiming the task succeeded. Never read secret values or ask the caller to say passwords, API keys, or verification codes: those must be entered in Rakazo's secure interface.
A spoken interruption stops speech; it does not cancel a running task. Forward a cancellation request to ask_bot so the real bot handles it. Never claim an action happened unless the bot's result confirms it.`;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The live call provider returned an invalid response.");
  }
  return value as Record<string, unknown>;
}
function resourceId(value: unknown): string {
  if (typeof value !== "string" || !/^[\w-]{1,256}$/.test(value)) {
    throw new Error("The live call provider returned an invalid resource.");
  }
  return value;
}

export class FishLiveVoiceProvider implements LiveVoiceProvider {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  private async request(
    apiKey: string,
    path: string,
    method: string,
    body: unknown,
    context: AdapterContext,
  ): Promise<Record<string, unknown>> {
    const response = await this.fetcher(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: voiceDeadline(context.signal, 20_000),
      redirect: "error",
    });
    if (response.status === 404 && (method === "DELETE" || path.endsWith("/end"))) {
      await response.body?.cancel().catch(() => undefined);
      return {};
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 402) throw new Error("Add Fish Audio API credit to use live calls.");
      if (response.status === 401 || response.status === 403) {
        throw new Error("Fish Audio rejected the live call connection.");
      }
      throw new Error(`Fish Audio could not complete the live call request (${response.status}).`);
    }
    if (response.status === 204) return {};
    return object(await readVoiceJson(response));
  }

  async configure(
    apiKey: string,
    settings: LiveCallSettings,
    context: AdapterContext,
  ): Promise<Record<string, unknown>> {
    const defaults = FISH_LIVE_DEFAULTS;
    let agentId: string | undefined;
    const toolIds: string[] = [];
    try {
      for (const tool of [
        {
          name: "ask_bot",
          description:
            "Send the caller's exact words to the actual Rakazo bot. All work and answers must be delegated here.",
          argument: "text",
        },
        {
          name: "get_bot_result",
          description:
            "Wait for the actual bot's result. If working, call again; never invent an answer.",
          argument: "request_id",
        },
      ]) {
        const result = await this.request(
          apiKey,
          "/tools",
          "POST",
          {
            tool_type: "client",
            name: tool.name,
            description: tool.description,
            arguments: [
              {
                name: tool.argument,
                description:
                  tool.argument === "text"
                    ? "The caller's exact words."
                    : "The request_id returned by ask_bot.",
              },
            ],
            expects_response: true,
            timeout_seconds: 30,
          },
          context,
        );
        toolIds.push(resourceId(result.tool_id));
      }
      const config = {
        prompt: { system_prompt: LIVE_BOT_PROMPT, first_message_mode: "off" },
        llm: { model: settings.modelId || defaults.modelId },
        voice: {
          tts_model: settings.speechModel || defaults.speechModel,
          speaking_language: settings.language,
        },
        asr: { model: settings.transcriptionModel || defaults.transcriptionModel },
        conversation: {
          max_duration_seconds: settings.maxDurationSeconds,
          interruptible: true,
          record_audio: false,
        },
        tools: { enabled: true, tool_ids: toolIds, system_tools: { hang_up_call: true } },
      };
      const result = await this.request(
        apiKey,
        "/agents",
        "POST",
        { name: "Rakazo", config },
        context,
      );
      agentId = resourceId(result.agent_id);
      await this.request(apiKey, `/agents/${agentId}/publish`, "POST", undefined, context);
      return { agentId, toolIds };
    } catch (error) {
      // Remove only resources created for this call when provisioning fails.
      const cleanup = { ...context, signal: AbortSignal.timeout(10_000) };
      if (agentId)
        await this.request(apiKey, `/agents/${agentId}`, "DELETE", undefined, cleanup).catch(
          () => undefined,
        );
      for (const id of toolIds)
        await this.request(apiKey, `/tools/${id}`, "DELETE", undefined, cleanup).catch(
          () => undefined,
        );
      throw error;
    }
  }

  async dispose(apiKey: string, state: Record<string, unknown>, context: AdapterContext) {
    await this.request(
      apiKey,
      `/agents/${resourceId(state.agentId)}`,
      "DELETE",
      undefined,
      context,
    );
    if (Array.isArray(state.toolIds)) {
      for (const id of state.toolIds)
        await this.request(apiKey, `/tools/${resourceId(id)}`, "DELETE", undefined, context);
    }
  }

  async start(
    apiKey: string,
    state: Record<string, unknown>,
    input: { voiceId: string; botName: string; opening?: string; language: string },
    context: AdapterContext,
  ) {
    const result = await this.request(
      apiKey,
      "/sessions",
      "POST",
      {
        agent_id: resourceId(state.agentId),
        dynamic_variables: { bot_name: input.botName },
        overrides: {
          voice_id: input.voiceId,
          language: input.language,
          ...(input.opening ? { first_message: input.opening } : {}),
        },
        record_audio: false,
        tool_events: false,
      },
      context,
    );
    const remoteSessionId = resourceId(result.session_id);
    try {
      const url = new URL(String(result.livekit_url));
      if (
        result.transport !== "livekit" ||
        url.protocol !== "wss:" ||
        url.username ||
        url.password ||
        typeof result.token !== "string" ||
        !result.token ||
        result.token.length > 16384 ||
        typeof result.expires_at !== "string" ||
        !Number.isFinite(Date.parse(result.expires_at)) ||
        typeof result.max_duration_seconds !== "number"
      ) {
        throw new Error("Fish Audio returned an unsupported live call connection.");
      }
      return {
        remoteSessionId,
        connection: {
          session_id: remoteSessionId,
          transport: result.transport,
          livekit_url: url.href,
          token: result.token,
          expires_at: result.expires_at,
          max_duration_seconds: result.max_duration_seconds,
        },
      };
    } catch (error) {
      await this.end(apiKey, remoteSessionId, {
        ...context,
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined);
      throw error;
    }
  }

  async end(apiKey: string, remoteSessionId: string, context: AdapterContext) {
    await this.request(
      apiKey,
      `/sessions/${resourceId(remoteSessionId)}/end`,
      "POST",
      undefined,
      context,
    );
  }
}
