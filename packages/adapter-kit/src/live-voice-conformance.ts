import assert from "node:assert/strict";
import type { LiveCallSettings } from "@rakazo/contracts";
import type { LiveVoiceProvider } from "./live-voice.js";
import type { AdapterContext } from "./types.js";

/** Offline provider suites supply a fake network and reuse the same lifecycle contract. */
export async function assertLiveVoiceConformance(
  provider: LiveVoiceProvider,
  settings: LiveCallSettings,
  context: AdapterContext,
) {
  const key = "fake-conformance-api-key";
  const resources = await provider.configure(key, settings, context);
  let remote: string | undefined;
  try {
    const session = await provider.start(
      key,
      resources,
      { voiceId: "test-voice", botName: "Test bot", language: "en" },
      context,
    );
    remote = session.remoteSessionId;
    assert(session.remoteSessionId.length > 0);
    assert(session.connection && typeof session.connection === "object");
    assert(
      !JSON.stringify(session.connection).includes(key),
      "A provider key must never become a client credential",
    );
  } finally {
    if (remote) await provider.end(key, remote, context);
    await provider.dispose(key, resources, context);
  }
}
