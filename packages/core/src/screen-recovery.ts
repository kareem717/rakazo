export type ScreenConnectionState = "connecting" | "connected" | "disconnected";

export function screenConnectionState(value: unknown): ScreenConnectionState | null {
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  if (event.source !== "rakazo.screen") return null;
  return event.state === "connecting" ||
    event.state === "connected" ||
    event.state === "disconnected"
    ? event.state
    : null;
}

/** Viewer recovery only: callers renew authorization, never boot or take control. */
export function createScreenRecovery(reconnect: () => Promise<void>) {
  let disposed = false;
  let pending = false;
  let connected = false;
  let connectedAt = 0;
  let attempts = 0;
  const lastState: { value: ScreenConnectionState } = { value: "connecting" };
  let retry: ReturnType<typeof setTimeout> | undefined;
  let renewal: ReturnType<typeof setTimeout> | undefined;

  function schedule(delay: number) {
    if (disposed || pending || retry !== undefined) return;
    retry = setTimeout(() => {
      retry = undefined;
      void recover();
    }, delay);
  }

  function backoff() {
    return Math.min(1_000 * 2 ** Math.min(attempts++, 5), 30_000);
  }

  function reportedFailure() {
    return lastState.value === "disconnected";
  }

  async function recover() {
    if (disposed || pending) return;
    pending = true;
    connected = false;
    lastState.value = "connecting";
    let failed = false;
    try {
      await reconnect();
    } catch {
      failed = true;
    } finally {
      pending = false;
      if (!connected) schedule(failed || reportedFailure() ? backoff() : 30_000);
    }
  }

  return {
    state(state: ScreenConnectionState) {
      if (disposed) return;
      if (state === "disconnected" && lastState.value === state && retry !== undefined) return;
      lastState.value = state;
      if (state === "connected") {
        if (!connected) connectedAt = Date.now();
        connected = true;
        clearTimeout(retry);
        retry = undefined;
      } else if (state === "connecting") {
        if (!connected) schedule(30_000);
      } else {
        if (connected && Date.now() - connectedAt >= 30_000) attempts = 0;
        connected = false;
        clearTimeout(retry);
        retry = undefined;
        schedule(backoff());
      }
    },
    /** Renew the actual displayed seal before expiry, including cached viewer URLs. */
    url(url: string) {
      clearTimeout(renewal);
      const expires = url.match(/\/novnc\/session\/(?:view|control)\/(\d+)\./)?.[1];
      if (!expires || disposed || !Number.isSafeInteger(Number(expires))) return;
      renewal = setTimeout(
        () => {
          this.state("disconnected");
        },
        Math.max(0, Number(expires) - Date.now() - 5 * 60_000),
      );
    },
    dispose() {
      disposed = true;
      clearTimeout(retry);
      clearTimeout(renewal);
    },
  };
}
