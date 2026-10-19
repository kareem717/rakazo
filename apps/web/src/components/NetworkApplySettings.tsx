import { Trans, useLingui } from "@lingui/react/macro";
import type { NetworkApplyStatus } from "@rakazo/contracts";
import { isNetworkApplying, waitForNetworkApply } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { useEffect, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

export function NetworkApplySettings({
  revision,
  onApplied,
  onBusy,
}: {
  revision: string;
  onApplied: () => void;
  onBusy: (busy: boolean) => void;
}) {
  const { t } = useLingui();
  const [status, setStatus] = useState<NetworkApplyStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const alive = useRef<AbortController | null>(null);
  const callbacks = useRef({ onApplied, onBusy });
  callbacks.current = { onApplied, onBusy };
  async function follow(operation: NetworkApplyStatus, signal: AbortSignal) {
    setBusy(true);
    callbacks.current.onBusy(true);
    try {
      await waitForNetworkApply(() => rpc.network.applyStatus(), operation, signal, setStatus);
      if (!signal.aborted) callbacks.current.onApplied();
    } catch (cause) {
      if (!signal.aborted) setError(errorText(cause, t`Could not apply network settings`));
    } finally {
      if (!signal.aborted) {
        setBusy(false);
        callbacks.current.onBusy(false);
      }
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    alive.current = controller;
    void rpc.network
      .applyStatus()
      .then((next) => {
        if (controller.signal.aborted) return;
        setStatus(next);
        if (isNetworkApplying(next)) void follow(next, controller.signal);
        else if (next.phase === "failed") setError(next.error);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(t`Could not reach the network restart service`);
      });
    return () => {
      controller.abort();
      callbacks.current.onBusy(false);
    };
  }, [attempt]);
  async function apply() {
    if (busy || !status?.available || !alive.current) return;
    setBusy(true);
    setError(null);
    callbacks.current.onBusy(true);
    try {
      const operation = await rpc.network.apply({ revision });
      setStatus(operation);
      await follow(operation, alive.current.signal);
    } catch (cause) {
      setError(errorText(cause, t`Could not apply network settings`));
      setBusy(false);
      callbacks.current.onBusy(false);
    }
  }
  return (
    <div className="space-y-2">
      {status?.available ? (
        <>
          <p>
            {busy ? (
              <Trans>Applying network settings… Reconnecting automatically.</Trans>
            ) : (
              <Trans>Stop computers before applying.</Trans>
            )}
          </p>
          <Button disabled={busy} onClick={() => void apply()}>
            <Trans>Apply and restart</Trans>
          </Button>
        </>
      ) : status ? (
        <p>
          <Trans>Stop computers and restart the deployment to apply.</Trans>
        </p>
      ) : null}
      {error ? (
        <>
          <p role="alert" className="text-destructive">
            {error}
          </p>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              setError(null);
              setAttempt((value) => value + 1);
            }}
          >
            <Trans>Check restart status</Trans>
          </Button>
        </>
      ) : null}
    </div>
  );
}
