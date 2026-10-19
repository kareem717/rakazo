import type { Input, WebContents } from "electron";

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
  contents.on("before-input-event", (_event, input) => {
    contents.setIgnoreMenuShortcuts(
      screenHandlesShortcut(input, contents.getURL(), contents.focusedFrame?.url),
    );
  });
}
