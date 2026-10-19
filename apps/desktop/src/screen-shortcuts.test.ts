import { expect, it } from "vitest";
import { screenHandlesShortcut } from "./screen-shortcuts.js";

const origin = "https://app.example.test";
const control = `${origin}/novnc/session/control/9999999999999.fake/vnc.html`;
const chord = { key: "a", meta: true, control: false, alt: false };

it("forwards editing chords only to the connected app's control viewer", () => {
  for (const key of ["a", "c", "x", "v", "z", "y", "f", "l"])
    expect(screenHandlesShortcut({ ...chord, key }, origin + "/app", control)).toBe(true);
  for (const frame of [
    undefined,
    origin + "/app",
    control.replace("/control/", "/view/"),
    control.replace("app.example.test", "other.example.test"),
  ])
    expect(screenHandlesShortcut(chord, origin, frame)).toBe(false);
});

it("preserves app shortcuts, regular typing and other modifier combinations", () => {
  for (const key of ["q", "w", "h", "aDifferentKey"])
    expect(screenHandlesShortcut({ ...chord, key }, origin, control)).toBe(false);
  expect(screenHandlesShortcut({ ...chord, meta: false }, origin, control)).toBe(false);
  expect(screenHandlesShortcut({ ...chord, alt: true }, origin, control)).toBe(false);
});
