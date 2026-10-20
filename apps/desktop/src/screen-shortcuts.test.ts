import type { Input, WebContents, WebFrameMain } from "electron";
import { beforeEach, expect, it, vi } from "vitest";
import { installScreenShortcuts, screenHandlesShortcut } from "./screen-shortcuts.js";

const origin = "https://app.example.test";
const control = `${origin}/novnc/session/control/9999999999999.fake/vnc.html`;
const chord = { key: "a", meta: true, control: false, alt: false };

it("forwards editing chords only to the connected app's control viewer", () => {
  for (const key of ["a", "c", "x", "v", "z", "y", "f", "l"])
    expect(screenHandlesShortcut({ ...chord, key }, `${origin}/app`, control)).toBe(true);
  for (const frame of [
    undefined,
    `${origin}/app`,
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

const device = vi.hoisted(() => ({ readText: vi.fn(() => "Device text 🌍\nsecond line") }));
vi.mock("electron", () => ({ clipboard: device }));
beforeEach(() => device.readText.mockClear());

function nativePasteFixture(frameUrl = control) {
  const executeJavaScript = vi.fn().mockResolvedValue(true);
  const frame = { url: frameUrl, executeJavaScript } as unknown as WebFrameMain;
  const contents = {
    focusedFrame: frame,
    getURL: () => origin,
    isDestroyed: () => false,
    on: vi.fn(),
    setIgnoreMenuShortcuts: vi.fn(),
    paste: vi.fn(),
  };
  installScreenShortcuts(contents as unknown as WebContents);
  const handler = contents.on.mock.calls[0][1];
  const event = { preventDefault: vi.fn() };
  const input = { ...chord, key: "v", type: "keyDown" } as Input;
  return { contents, frame, executeJavaScript, handler, event, input };
}

it("delivers an explicit native paste directly to the focused control viewer", async () => {
  const f = nativePasteFixture();
  f.handler(f.event, f.input);
  await vi.waitFor(() => expect(f.executeJavaScript).toHaveBeenCalledTimes(2));
  expect(f.event.preventDefault).toHaveBeenCalledOnce();
  expect(device.readText).toHaveBeenCalledOnce();
  expect(f.executeJavaScript.mock.calls[1][0]).toContain('"request":"paste"');
  expect(f.executeJavaScript.mock.calls[1][0]).toContain("Device text 🌍\\nsecond line");
  expect(f.contents.paste).not.toHaveBeenCalled();
});

it("leaves local viewer fields on native paste without reading the clipboard", async () => {
  const f = nativePasteFixture();
  f.executeJavaScript.mockResolvedValue(false);
  f.handler(f.event, f.input);
  await vi.waitFor(() => expect(f.contents.paste).toHaveBeenCalledOnce());
  expect(device.readText).not.toHaveBeenCalled();
});

it("never reads device clipboard on keyup, view-only or unrelated frames", async () => {
  for (const frameUrl of [control, control.replace("/control/", "/view/"), origin]) {
    const f = nativePasteFixture(frameUrl);
    f.handler(f.event, { ...f.input, type: "keyUp" });
    if (frameUrl !== control) f.handler(f.event, f.input);
    expect(f.executeJavaScript).not.toHaveBeenCalled();
  }
  expect(device.readText).not.toHaveBeenCalled();
});

it("drops a paste if focus changes before the viewer is checked", async () => {
  const f = nativePasteFixture();
  f.handler(f.event, f.input);
  f.contents.focusedFrame = { url: origin } as WebFrameMain;
  await Promise.resolve();
  expect(device.readText).not.toHaveBeenCalled();
  expect(f.executeJavaScript).toHaveBeenCalledOnce();
});

it("drops a paste if the focused frame navigates or disconnects", async () => {
  const f = nativePasteFixture();
  f.handler(f.event, f.input);
  Object.defineProperty(f.frame, "url", { value: "https://other.example.test/" });
  await Promise.resolve();
  expect(device.readText).not.toHaveBeenCalled();
  const disconnected = nativePasteFixture();
  disconnected.executeJavaScript.mockRejectedValue(Error("Frame detached"));
  disconnected.handler(disconnected.event, disconnected.input);
  await Promise.resolve();
  expect(device.readText).not.toHaveBeenCalled();
});
