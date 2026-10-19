export type ScreenShortcut = "a" | "c" | "x" | "z" | "y" | "f" | "l" | "Escape" | "Tab";
export type ScreenControlCommand =
  | { request: "shortcut"; key: ScreenShortcut; shift?: boolean }
  | { request: "paste"; text: string }
  | { request: "clipboard" }
  | { request: "status" };

export type ScreenControlEvent =
  | { source: "rakazo.controls"; type: "ready" }
  | { source: "rakazo.controls"; type: "clipboard"; text: string };

export function screenControlEvent(value: unknown): ScreenControlEvent | null {
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  if (event.source !== "rakazo.controls") return null;
  if (event.type === "ready") return { source: "rakazo.controls", type: "ready" };
  if (
    event.type === "clipboard" &&
    typeof event.text === "string" &&
    event.text.length <= 1_048_576
  )
    return { source: "rakazo.controls", type: "clipboard", text: event.text };
  return null;
}

/** Serialize a bounded command for the native WebView; never interpolate clipboard text as code. */
export function screenControlScript(command: ScreenControlCommand): string {
  const json = JSON.stringify(command)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `window.rakazoScreenControls?.run(${json});true;`;
}

/** Runs only inside the sandboxed viewer. Keep this program independent of host globals. */
export const SCREEN_CONTROLS_INSTALLER = `function installScreenControls(rfb) {
  const host = window;
  let clipboard = "";
  let connected = false;
  let copyTimer;
  const active = () => !rfb.viewOnly && (rfb._rfbConnectionState === "connected" || connected);
  const report = (event) => {
    const message2 = { source: "rakazo.controls", ...event };
    if (host.parent !== host) host.parent.postMessage(message2, "*");
    host.ReactNativeWebView?.postMessage(JSON.stringify(message2));
  };
  const ready = () => {
    connected = true;
    if (active()) report({ type: "ready" });
  };
  const disconnected = () => {
    connected = false;
    clipboard = "";
  };
  const receiveClipboard = (event) => {
    const text = event.detail?.text;
    if (!active() || typeof text !== "string" || text.length > 1048576) return;
    clipboard = text;
    report({ type: "clipboard", text });
  };
  const releaseModifiers = () => {
    for (const [symbol, code] of [
      [65507, "ControlLeft"],
      [65508, "ControlRight"],
      [65513, "AltLeft"],
      [65514, "AltRight"],
      [65515, "MetaLeft"],
      [65516, "MetaRight"],
      [65406, "AltLeft"],
      [65027, "AltRight"],
      [65505, "ShiftLeft"],
      [65506, "ShiftRight"]
    ]) rfb.sendKey(symbol, code, false);
  };
  const shortcut = (key, shift = false) => {
    if (!active()) return;
    const special = key === "Escape" ? [65307, "Escape"] : key === "Tab" ? [65289, "Tab"] : null;
    if (!special && !["a", "c", "x", "v", "z", "y", "f", "l"].includes(key)) return;
    releaseModifiers();
    if (!special) rfb.sendKey(65507, "ControlLeft", true);
    if (shift) rfb.sendKey(65505, "ShiftLeft", true);
    rfb.sendKey(special ? Number(special[0]) : key.charCodeAt(0), special ? String(special[1]) : \`Key\${key.toUpperCase()}\`);
    if (shift) rfb.sendKey(65505, "ShiftLeft", false);
    if (!special) rfb.sendKey(65507, "ControlLeft", false);
    if (key === "c" || key === "x") {
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        if (active()) report({ type: "clipboard", text: clipboard });
      }, 250);
    }
    rfb.focus();
  };
  const paste = (text) => {
    if (!active() || !text || text.length > 1048576) return;
    releaseModifiers();
    rfb.clipboardPasteFrom(text);
    shortcut("v");
  };
  const run = (value) => {
    if (!active() || !value || typeof value !== "object") return;
    const command = value;
    if (command.request === "status") report({ type: "ready" });
    if (command.request === "paste" && typeof command.text === "string") paste(command.text);
    if (command.request === "shortcut" && typeof command.key === "string")
      shortcut(command.key, command.shift === true);
    if (command.request === "clipboard") report({ type: "clipboard", text: clipboard });
  };
  const message = (event) => {
    if (event.source !== host.parent || event.data?.source !== "rakazo.controls") return;
    if (event.data.request === "status" && active()) report({ type: "ready" });
    else run(event.data);
  };
  const target = document.createElement("textarea");
  target.tabIndex = -1;
  target.setAttribute("aria-hidden", "true");
  target.style.cssText = "position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0";
  document.body.append(target);
  const editable = (event) => event.target !== target && event.target instanceof Element && Boolean(event.target.closest("input,textarea,[contenteditable=true]"));
  const keydown = (event) => {
    if (!active() || editable(event)) return;
    const key = event.key.toLowerCase();
    const pasteChord = !event.altKey && (event.ctrlKey || event.metaKey) && key === "v";
    if (pasteChord) {
      event.stopImmediatePropagation();
      target.value = "";
      target.focus({ preventScroll: true });
      return;
    }
    if (event.key === "Meta") {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!event.metaKey || event.altKey || event.ctrlKey || !["a", "c", "x", "z", "y", "f", "l"].includes(key)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    shortcut(key, event.shiftKey);
  };
  const keyup = (event) => {
    if (!active() || editable(event)) return;
    if (event.key === "Meta" || !event.altKey && (event.metaKey || event.ctrlKey) && ["a", "c", "x", "v", "z", "y", "f", "l"].includes(event.key.toLowerCase()))
      event.stopImmediatePropagation();
  };
  const onPaste = (event) => {
    if (!active() || event.target !== target) return;
    const text = event.clipboardData?.getData("text/plain");
    event.preventDefault();
    event.stopImmediatePropagation();
    target.value = "";
    if (text) paste(text);
    else rfb.focus();
  };
  host.rakazoScreenControls = { run };
  host.addEventListener("message", message);
  host.addEventListener("keydown", keydown, true);
  host.addEventListener("keyup", keyup, true);
  host.addEventListener("paste", onPaste, true);
  rfb.addEventListener("connect", ready);
  rfb.addEventListener("disconnect", disconnected);
  rfb.addEventListener("clipboard", receiveClipboard);
  if (rfb._rfbConnectionState === "connected") ready();
  return () => {
    clearTimeout(copyTimer);
    host.removeEventListener("message", message);
    host.removeEventListener("keydown", keydown, true);
    host.removeEventListener("keyup", keyup, true);
    host.removeEventListener("paste", onPaste, true);
    rfb.removeEventListener("connect", ready);
    rfb.removeEventListener("disconnect", disconnected);
    rfb.removeEventListener("clipboard", receiveClipboard);
    delete host.rakazoScreenControls;
    target.remove();
  };
}
`;
