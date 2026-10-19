import type { VoiceInfo } from "@rakazo/contracts";

/** Preserve a saved voice even when it is outside a bounded/search catalog. */
export function voiceChoices(voices: readonly VoiceInfo[], selected: string): VoiceInfo[] {
  const unique = [...new Map(voices.map((voice) => [voice.id, voice])).values()];
  return selected && !unique.some((voice) => voice.id === selected)
    ? [{ id: selected, label: selected }, ...unique]
    : unique;
}
