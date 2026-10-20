import { afterEach, expect, it, vi } from "vitest";
import { FishAudioVoiceProvider } from "./fish-audio-voice.js";

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};
const id = "0123456789abcdef0123456789abcdef";
afterEach(() => vi.unstubAllGlobals());

it.each([id, `https://fish.audio/app/text-to-speech/?modelId=${id}`, `https://fish.audio/m/${id}`])(
  "resolves a voice reference outside the bounded catalog: %s",
  async (reference) => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ _id: id, title: "Library voice" })));
    vi.stubGlobal("fetch", fetcher);
    await expect(
      new FishAudioVoiceProvider().searchVoices("fake-api-key", reference, context),
    ).resolves.toEqual([{ id, label: "Library voice", description: undefined }]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe(`https://api.fish.audio/model/${id}`);
  },
);

it("searches the upstream library by title", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ items: [{ _id: id, title: "Narrator" }], has_more: false })),
    );
  vi.stubGlobal("fetch", fetcher);
  expect(
    await new FishAudioVoiceProvider().searchVoices("fake-api-key", "Narrator", context),
  ).toEqual([expect.objectContaining({ id })]);
  expect(new URL(fetcher.mock.calls[0]?.[0]).searchParams.get("title")).toBe("Narrator");
});

it("finds built-in names without requesting the live catalog", async () => {
  const fetcher = vi.fn().mockRejectedValue(new Error("Catalog unavailable"));
  vi.stubGlobal("fetch", fetcher);
  const provider = new FishAudioVoiceProvider();
  for (const label of ["Eddie", "Marty", "Brad", "Eric", "Ling", "Greg", "Tony", "Jim"]) {
    await expect(
      provider.searchVoices("fake-api-key", ` ${label.toUpperCase()} `, context),
    ).resolves.toEqual([expect.objectContaining({ label })]);
  }
  expect(fetcher).not.toHaveBeenCalled();
});

it("keeps built-in names and deduplicates upstream search matches", async () => {
  const voiceId = "08a027bcd6d74cf7bb71df89c9ef07e9";
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const model = { _id: voiceId, title: "Upstream title" };
      return new Response(
        JSON.stringify(String(input).endsWith(`/model/${voiceId}`) ? model : { items: [model] }),
      );
    }),
  );
  const provider = new FishAudioVoiceProvider();
  await expect(provider.searchVoices("fake-api-key", "Eddie", context)).resolves.toEqual([
    { id: voiceId, label: "Eddie" },
  ]);
  await expect(provider.searchVoices("fake-api-key", voiceId, context)).resolves.toEqual([
    { id: voiceId, label: "Eddie", description: undefined },
  ]);
});

it.each([
  `https://fish.audio.evil.test/?modelId=${id}`,
  `https://user@fish.audio/?modelId=${id}`,
  `http://fish.audio/?modelId=${id}`,
  `https://fish.audio/?modelId=../../internal`,
  "https://localhost/private",
])("rejects untrusted voice links without making a request: %s", async (reference) => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(
    new FishAudioVoiceProvider().searchVoices("fake-api-key", reference, context),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([
  { status: 404 },
  { status: 200, body: { _id: id, dmca_taken_down: true } },
  { status: 200, body: { _id: id, state: "failed" } },
])("omits unavailable models: %j", async ({ status, body }) => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(JSON.stringify(body ?? {}), { status })),
  );
  await expect(
    new FishAudioVoiceProvider().searchVoices("fake-api-key", id, context),
  ).resolves.toEqual([]);
});

it.each([{ dmca_taken_down: true }, { state: "failed" }])(
  "omits unavailable built-in voices when resolving a reference: %j",
  async (unavailable) => {
    const voiceId = "08a027bcd6d74cf7bb71df89c9ef07e9";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(
          async () => new Response(JSON.stringify({ _id: voiceId, ...unavailable })),
        ),
    );
    const provider = new FishAudioVoiceProvider();
    await expect(provider.searchVoices("fake-api-key", voiceId, context)).resolves.toEqual([]);
  },
);
