import type { LiveCallSettings } from "@rakazo/contracts";
import type { AdapterContext } from "./types.js";

/** Server boundary: credentials and provider provisioning never enter client call logic. */
export interface LiveVoiceProvider {
  configure(
    apiKey: string,
    settings: LiveCallSettings,
    context: AdapterContext,
  ): Promise<Record<string, unknown>>;
  dispose(apiKey: string, state: Record<string, unknown>, context: AdapterContext): Promise<void>;
  start(
    apiKey: string,
    state: Record<string, unknown>,
    input: { voiceId: string; botName: string; opening?: string; language: string },
    context: AdapterContext,
  ): Promise<{ remoteSessionId: string; connection: Record<string, unknown> }>;
  end(apiKey: string, remoteSessionId: string, context: AdapterContext): Promise<void>;
}
