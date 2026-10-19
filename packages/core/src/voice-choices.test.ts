import { expect, it } from "vitest";
import { voiceChoices } from "./voice-choices.js";

it("keeps the actual saved voice when a partial catalog omits it", () => {
  expect(voiceChoices([{ id: "other", label: "Other" }], "saved")).toEqual([
    { id: "saved", label: "saved" },
    { id: "other", label: "Other" },
  ]);
});
it("uses the resolved name and deduplicates provider results", () => {
  expect(
    voiceChoices(
      [
        { id: "saved", label: "Saved" },
        { id: "saved", label: "Saved" },
      ],
      "saved",
    ),
  ).toEqual([{ id: "saved", label: "Saved" }]);
});
