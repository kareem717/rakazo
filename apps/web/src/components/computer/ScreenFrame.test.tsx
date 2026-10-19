// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
import { ScreenFrame } from "./ScreenFrame";

it("recovers the current iframe only, including StrictMode's effect replay", async () => {
  vi.useFakeTimers();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const reconnect = vi.fn(async () => "https://screen.example/vnc.html");
  try {
    await act(async () =>
      root.render(
        <StrictMode>
          <ScreenFrame
            title="Fixture screen"
            src="https://screen.example/vnc.html"
            onReconnect={reconnect}
          />
        </StrictMode>,
      ),
    );
    const frame = host.querySelector("iframe")!;
    const data = { source: "rakazo.screen", state: "disconnected" };
    window.dispatchEvent(new MessageEvent("message", { source: window, data }));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(reconnect).not.toHaveBeenCalled();
    window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, data }));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(reconnect).toHaveBeenCalledOnce();
    expect(host.querySelector("iframe")).not.toBe(frame);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
  }
});
