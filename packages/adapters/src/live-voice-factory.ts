import type { LiveVoiceProvider } from "@rakazo/adapter-kit";
import { FISH_LIVE_DEFAULTS, FishLiveVoiceProvider } from "./fish-live-voice.js";

export const LIVE_VOICE_CATALOG = [
  { id: "fish-audio", name: "Fish Agents", defaults: FISH_LIVE_DEFAULTS },
] as const;

export function createLiveVoiceProvider(provider: string): LiveVoiceProvider {
  if (provider === "fish-audio") return new FishLiveVoiceProvider();
  throw new Error("That live call provider is not supported.");
}
