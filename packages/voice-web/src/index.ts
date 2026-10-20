import type { LiveCallConnection, LiveCallResult } from "@rakazo/contracts";

export interface LiveVoiceClient {
  end(): Promise<void>;
  mute(muted: boolean): Promise<void>;
  interrupt(): void;
}
export interface LiveVoiceClientOptions {
  session: LiveCallConnection;
  signal: AbortSignal;
  ask(text: string, turnId: string): Promise<{ requestId: string }>;
  result(requestId: string): Promise<LiveCallResult>;
  onMode(mode: "listening" | "thinking" | "speaking"): void;
  onTranscript(segment: { id: string; role: "user" | "bot"; text: string; final: boolean }): void;
  onEnd(): void;
  onError(error: Error): void;
}

export async function connectLiveVoice(options: LiveVoiceClientOptions): Promise<LiveVoiceClient> {
  if (options.session.provider !== "fish-audio")
    throw new Error("That live call provider is not supported.");
  // Speech SDKs are loaded only for a call that explicitly selected this provider.
  const { connectFishVoice } = await import("./fish.js");
  return connectFishVoice(options);
}
