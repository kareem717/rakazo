// @vitest-environment jsdom
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import {
  SCREEN_CONTROLS_INSTALLER,
  screenControlEvent,
  screenControlScript,
} from "./screen-controls.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const detach of cleanup.splice(0)) detach();
});

function viewer(viewOnly = false) {
  const rfb = Object.assign(new EventTarget(), {
    viewOnly,
    _rfbConnectionState: "connected",
    sendKey: vi.fn(),
    clipboardPasteFrom: vi.fn(),
    focus: vi.fn(),
  });
  const detach = runInNewContext(`(${SCREEN_CONTROLS_INSTALLER})(rfb)`, {
    window,
    document,
    Element,
    rfb,
    setTimeout,
    clearTimeout,
  });
  cleanup.push(detach);
  return rfb;
}

it("maps Command editing shortcuts to balanced Linux Ctrl chords before noVNC sees them", () => {
  const rfb = viewer();
  const downstream = vi.fn();
  window.addEventListener("keydown", downstream);
  cleanup.push(() => window.removeEventListener("keydown", downstream));
  for (const [key, shift] of [
    ["a", false],
    ["x", false],
    ["c", false],
    ["z", true],
  ] as const) {
    rfb.sendKey.mockClear();
    const event = new KeyboardEvent("keydown", {
      key,
      metaKey: true,
      shiftKey: shift,
      cancelable: true,
    });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(rfb.sendKey).toHaveBeenCalledWith(0xffe3, "ControlLeft", true);
    expect(rfb.sendKey).toHaveBeenCalledWith(key.charCodeAt(0), `Key${key.toUpperCase()}`);
    expect(rfb.sendKey).toHaveBeenLastCalledWith(0xffe3, "ControlLeft", false);
    if (shift) expect(rfb.sendKey).toHaveBeenCalledWith(0xffe1, "ShiftLeft", false);
  }
  expect(downstream).not.toHaveBeenCalled();
});

it("uses the native paste event without reading the device clipboard in the sandbox", () => {
  const rfb = viewer();
  const event = new KeyboardEvent("keydown", { key: "v", metaKey: true, cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  const target = document.activeElement!;
  expect(target.tagName).toBe("TEXTAREA");
  const paste = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", {
    value: { getData: () => "Hello 🌍\nsecond line" },
  });
  target.dispatchEvent(paste);
  expect(rfb.clipboardPasteFrom).toHaveBeenCalledWith("Hello 🌍\nsecond line");
  expect(rfb.sendKey).toHaveBeenCalledWith(0x76, "KeyV");
  expect((target as HTMLTextAreaElement).value).toBe("");
});

it("preserves editing in viewer inputs and rejects commands from other frames", () => {
  const rfb = viewer();
  const input = document.createElement("input");
  document.body.append(input);
  cleanup.push(() => input.remove());
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", metaKey: true, bubbles: true }));
  window.dispatchEvent(
    new MessageEvent("message", {
      source: {} as Window,
      data: { source: "rakazo.controls", request: "paste", text: "unexpected" },
    }),
  );
  expect(rfb.sendKey).not.toHaveBeenCalled();
  expect(rfb.clipboardPasteFrom).not.toHaveBeenCalled();
});

it("blocks all control and clipboard forwarding in view-only or disconnected sessions", () => {
  const rfb = viewer(true);
  const messages = vi.spyOn(window, "postMessage");
  const command = { source: "rakazo.controls", request: "paste", text: "blocked" };
  window.dispatchEvent(new MessageEvent("message", { source: window, data: command }));
  rfb.dispatchEvent(new CustomEvent("clipboard", { detail: { text: "private" } }));
  expect(rfb.clipboardPasteFrom).not.toHaveBeenCalled();
  expect(messages).not.toHaveBeenCalled();
  rfb.viewOnly = false;
  rfb._rfbConnectionState = "disconnected";
  rfb.dispatchEvent(new Event("disconnect"));
  window.dispatchEvent(new MessageEvent("message", { source: window, data: command }));
  expect(rfb.clipboardPasteFrom).not.toHaveBeenCalled();
  messages.mockRestore();
});

it("bounds clipboard messages and serializes native commands without script injection", () => {
  expect(screenControlEvent({ source: "other", type: "clipboard", text: "ignored" })).toBeNull();
  expect(
    screenControlEvent({
      source: "rakazo.controls",
      type: "clipboard",
      text: "x".repeat(1_048_577),
    }),
  ).toBeNull();
  const run = vi.fn();
  const text = '</script><script>alert("test")</script>\u2028';
  const script = screenControlScript({ request: "paste", text });
  expect(script).not.toContain("</script>");
  runInNewContext(script, { window: { rakazoScreenControls: { run } } });
  expect(run).toHaveBeenCalledWith({ request: "paste", text });
});
