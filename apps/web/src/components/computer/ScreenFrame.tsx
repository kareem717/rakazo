import type { ScreenControlCommand } from "@rakazo/core";
import { createScreenRecovery, screenConnectionState, screenControlEvent } from "@rakazo/core";
import type { ComponentProps } from "react";
import { useEffect, useRef, useState } from "react";
import { ScreenClipboard } from "./ScreenClipboard";

export function ScreenFrame({
  onReconnect,
  interactive = false,
  ...props
}: ComponentProps<"iframe"> & { onReconnect: () => Promise<unknown>; interactive?: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const reconnect = useRef(onReconnect);
  reconnect.current = onReconnect;
  const [revision, setRevision] = useState(0);
  const [controlsReady, setControlsReady] = useState(false);
  const [clipboard, setClipboard] = useState("");
  const [sync, setSync] = useState(false);
  const copyUntil = useRef(0);
  const permission = useRef({ interactive, sync });
  permission.current = { interactive, sync };
  useEffect(() => {
    setControlsReady(false);
    setClipboard("");
    setSync(false);
    copyUntil.current = 0;
  }, [interactive, props.src]);
  const command = (value: ScreenControlCommand) => {
    if (!permission.current.interactive) return;
    if (value.request === "shortcut" && (value.key === "c" || value.key === "x"))
      copyUntil.current = Date.now() + 5_000;
    frame.current?.contentWindow?.postMessage({ source: "rakazo.controls", ...value }, "*");
  };
  const recovery = useRef<ReturnType<typeof createScreenRecovery> | null>(null);
  const url = useRef(props.src);
  url.current = props.src;
  useEffect(() => {
    let active = true;
    const controller = createScreenRecovery(async () => {
      const result = await reconnect.current();
      if (!result) throw new Error("Screen unavailable");
      if (active) setRevision((value) => value + 1);
    });
    recovery.current = controller;
    if (url.current) controller.url(url.current);
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const state = screenConnectionState(event.data);
      if (state) controller.state(state);
      if (!permission.current.interactive) return;
      const controls = screenControlEvent(event.data);
      if (controls?.type === "ready") setControlsReady(true);
      if (controls?.type === "clipboard") {
        setClipboard(controls.text);
        if (permission.current.sync || copyUntil.current > Date.now())
          void navigator.clipboard?.writeText(controls.text).catch(() => setSync(false));
      }
    };
    const online = () => controller.state("disconnected");
    window.addEventListener("message", receive);
    window.addEventListener("online", online);
    return () => {
      active = false;
      window.removeEventListener("message", receive);
      window.removeEventListener("online", online);
      controller.dispose();
    };
  }, []);
  useEffect(() => {
    if (props.src) recovery.current?.url(props.src);
  }, [props.src]);
  return (
    <div className="relative h-full w-full">
      <iframe
        {...props}
        key={revision}
        ref={frame}
        onLoad={(event) => {
          frame.current?.contentWindow?.postMessage(
            { source: "rakazo.screen", request: "status" },
            "*",
          );
          frame.current?.contentWindow?.postMessage(
            { source: "rakazo.controls", request: "status" },
            "*",
          );
          props.onLoad?.(event);
        }}
        onError={(event) => {
          recovery.current?.state("disconnected");
          props.onError?.(event);
        }}
      />
      {interactive && controlsReady ? (
        <ScreenClipboard text={clipboard} sync={sync} onSync={setSync} onCommand={command} />
      ) : null}
    </div>
  );
}
