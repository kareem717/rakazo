import { screenControlScript } from "@rakazo/core/screen-controls";
import type { Input, WebContents } from "electron";
import { clipboard as screenClipboard } from "electron";

/** Let the controlled viewer receive editing chords before Electron's Edit menu consumes them. */
export function screenHandlesShortcut(
  input: Pick<Input, "key" | "meta" | "control" | "alt">,
  appUrl: string,
  frameUrl: string | undefined,
) {
  if (
    !input.meta ||
    input.control ||
    input.alt ||
    !["a", "c", "x", "v", "z", "y", "f", "l"].includes(input.key.toLowerCase())
  )
    return false;
  try {
    const app = new URL(appUrl);
    const frame = new URL(frameUrl ?? "");
    return (
      (app.protocol === "https:" || app.protocol === "http:") &&
      frame.origin === app.origin &&
      /^\/novnc\/session\/control\/\d+\.[^/]+\//.test(frame.pathname)
    );
  } catch {
    return false;
  }
}

export function installScreenShortcuts(contents: WebContents) {
  contents.on("before-input-event", (event, input) => {
    const frame = contents.focusedFrame;
    const handled = screenHandlesShortcut(input, contents.getURL(), frame?.url);
    contents.setIgnoreMenuShortcuts(handled);
    if (!handled || !frame || input.key.toLowerCase() !== "v") return;
    event.preventDefault();
    if (input.type !== "keyDown") return;
    // Electron's native Paste menu is suppressed for the viewer. Deliver this
    // explicit user paste directly, without relying on a browser default action.
    void frame
      .executeJavaScript(
        `Boolean(window.rakazoScreenControls && !document.activeElement?.closest('input,textarea,[contenteditable=true]'))`,
      )
      .then(async (remote: unknown) => {
        if (
          contents.isDestroyed() ||
          contents.focusedFrame !== frame ||
          !screenHandlesShortcut(input, contents.getURL(), frame.url)
        )
          return;
        if (remote !== true) {
          contents.paste();
          return;
        }
        const text = await screenClipboard.readText();
        if (
          !text ||
          text.length > 1_048_576 ||
          contents.isDestroyed() ||
          contents.focusedFrame !== frame ||
          !screenHandlesShortcut(input, contents.getURL(), frame.url)
        )
          return;
        return frame.executeJavaScript(screenControlScript({ request: "paste", text }));
      })
      .catch(() => {
        // A viewer closing or navigating during a paste must not target another frame.
      });
  });
}
