import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import {
  injectScreenViewerBridge,
  SCREEN_VIEWER_BRIDGE,
  unavailableScreenHtml,
} from "./screen-viewer-bridge.js";

it("reports transport loss without forwarding capabilities or provider credentials", () => {
  const parent = { postMessage: vi.fn() };
  const native = { postMessage: vi.fn() };
  const listeners: Record<string, (event: unknown) => void> = {};
  const window = {
    parent,
    ReactNativeWebView: native,
    WebSocket: EventTarget,
    addEventListener: (name: string, listener: (event: unknown) => void) => {
      listeners[name] = listener;
    },
  };
  runInNewContext(SCREEN_VIEWER_BRIDGE, { window, URL });
  const socket = new window.WebSocket();
  socket.dispatchEvent(new Event("open"));
  socket.dispatchEvent(new Event("close"));
  expect(parent.postMessage.mock.calls.map(([event]) => event.state)).toEqual([
    "connecting",
    "connected",
    "disconnected",
  ]);
  expect(native.postMessage).toHaveBeenLastCalledWith(
    JSON.stringify({ source: "rakazo.screen", state: "disconnected" }),
  );
  const count = parent.postMessage.mock.calls.length;
  listeners.message!({ source: {}, data: { source: "rakazo.screen", request: "status" } });
  expect(parent.postMessage).toHaveBeenCalledTimes(count);
  listeners.message!({ source: parent, data: { source: "rakazo.screen", request: "status" } });
  expect(parent.postMessage).toHaveBeenCalledTimes(count + 1);
});

it("installs the bridge before viewer scripts and reports an unavailable document", () => {
  const html = injectScreenViewerBridge(
    '<html><HEAD lang="en"><script src="viewer.js"></script></HEAD></html>',
  );
  expect(html.indexOf(SCREEN_VIEWER_BRIDGE)).toBeLessThan(html.indexOf('src="viewer.js"'));
  expect(injectScreenViewerBridge("<html>fixture</html>")).toContain(SCREEN_VIEWER_BRIDGE);
  const parent = { postMessage: vi.fn() };
  const script = unavailableScreenHtml().match(/<script>([\s\S]*?)<\/script>/)![1]!;
  runInNewContext(script, { window: { parent, addEventListener: vi.fn() } });
  expect(parent.postMessage).toHaveBeenCalledWith(
    { source: "rakazo.screen", state: "disconnected" },
    "*",
  );
});
