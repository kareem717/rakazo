import { SCREEN_CONTROLS_INSTALLER } from "@rakazo/core/screen-controls";

/** Only the viewer page is instrumented; the remote browser and its profile are untouched. */
export const SCREEN_VIEWER_BRIDGE = `(() => {
  let state = "connecting";
  function report(next) {
    state = next;
    const event = { source: "rakazo.screen", state };
    if (window.parent !== window) window.parent.postMessage(event, "*");
    window.ReactNativeWebView?.postMessage(JSON.stringify(event));
  }
  window.addEventListener("message", event => {
    if (event.source === window.parent && event.data?.source === "rakazo.screen" && event.data?.request === "status") report(state);
  });
  const NativeWebSocket = window.WebSocket;
  window.WebSocket = new Proxy(NativeWebSocket, {
    construct(target, args, newTarget) {
      const socket = Reflect.construct(target, args, newTarget);
      socket.addEventListener("open", () => report("connected"));
      socket.addEventListener("close", () => report("disconnected"));
      socket.addEventListener("error", () => report("disconnected"));
      return socket;
    },
  });
  report("connecting");
})();`;

export function injectScreenViewerBridge(html: string) {
  const input = `<script>window.rakazoAttachScreenControls = ${SCREEN_CONTROLS_INSTALLER};</script>`;
  const stock = /(?:\.\/)?app\/ui\.js/.test(html)
    ? `<script type="module">
      import UI from "./app/ui.js";
      let current, detach;
      function attach() {
        if (!UI.rfb || UI.rfb === current) return;
        detach?.(); current = UI.rfb;
        detach = window.rakazoAttachScreenControls(current);
      }
      const timer = setInterval(attach, 250);
      window.addEventListener("pagehide", () => { clearInterval(timer); detach?.(); });
      attach();
      </script>`
    : "";
  const script = `<script>${SCREEN_VIEWER_BRIDGE}</script>${input}${stock}`;
  return /<head\b[^>]*>/i.test(html)
    ? html.replace(/<head\b[^>]*>/i, (head) => head + script)
    : script + html;
}

export function unavailableScreenHtml() {
  return `<!doctype html><html><head><script>
  const event = { source: "rakazo.screen", state: "disconnected" };
  function report() {
    if (window.parent !== window) window.parent.postMessage(event, "*");
    window.ReactNativeWebView?.postMessage(JSON.stringify(event));
  }
  window.addEventListener("message", message => {
    if (message.source === window.parent && message.data?.source === "rakazo.screen" && message.data?.request === "status") report();
  });
  report();
  </script></head><body>Screen unavailable</body></html>`;
}
