import { createScreenRecovery, screenConnectionState } from "@rakazo/core";
import type { ComponentProps } from "react";
import { useEffect, useRef, useState } from "react";

export function ScreenFrame({
  onReconnect,
  ...props
}: ComponentProps<"iframe"> & { onReconnect: () => Promise<unknown> }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const reconnect = useRef(onReconnect);
  reconnect.current = onReconnect;
  const [revision, setRevision] = useState(0);
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
    <iframe
      {...props}
      key={revision}
      ref={frame}
      onLoad={(event) => {
        frame.current?.contentWindow?.postMessage(
          { source: "rakazo.screen", request: "status" },
          "*",
        );
        props.onLoad?.(event);
      }}
      onError={(event) => {
        recovery.current?.state("disconnected");
        props.onError?.(event);
      }}
    />
  );
}
