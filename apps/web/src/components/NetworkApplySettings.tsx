import { Trans, useLingui } from "@lingui/react/macro";
import type { NetworkApplyStatus } from "@rakazo/contracts";
import { isNetworkApplying, waitForNetworkApply } from "@rakazo/core";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
} from "@rakazo/ui-web";
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
  const [preview, setPreview] = useState<{ computers: { id: string; name: string }[] } | null>(
    null,
  );
  const [preparing, setPreparing] = useState(false);
  const alive = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const callbacks = useRef({ onApplied, onBusy });
  callbacks.current = { onApplied, onBusy };
  async function follow(operation: NetworkApplyStatus, signal: AbortSignal) {
    inFlight.current = true;
    setBusy(true);
    callbacks.current.onBusy(true);
    try {
      await waitForNetworkApply(() => rpc.network.applyStatus(), operation, signal, setStatus);
      if (!signal.aborted) callbacks.current.onApplied();
    } catch (cause) {
      if (!signal.aborted) setError(errorText(cause, t`Could not apply network settings`));
    } finally {
      if (!signal.aborted) {
        inFlight.current = false;
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
  async function confirm() {
    if (inFlight.current || preparing) return;
    setPreparing(true);
    setError(null);
    try {
      setPreview(await rpc.network.applyPreview());
    } catch (cause) {
      setError(errorText(cause, t`Could not prepare network restart`));
    } finally {
      setPreparing(false);
    }
  }
  async function apply() {
    if (inFlight.current || !status?.available || !alive.current) return;
    inFlight.current = true;
    setPreview(null);
    setBusy(true);
    setError(null);
    callbacks.current.onBusy(true);
    try {
      const operation = await rpc.network.apply({ revision, stopComputers: true });
      setStatus(operation);
      await follow(operation, alive.current.signal);
    } catch (cause) {
      setError(errorText(cause, t`Could not apply network settings`));
      inFlight.current = false;
      setBusy(false);
      callbacks.current.onBusy(false);
    }
  }
  return (
    <div className="space-y-2">
      {status?.available ? (
        <>
          {busy ? (
            <p>
              {status.phase === "draining" ? (
                <Trans>Saving and stopping computers…</Trans>
              ) : (
                <Trans>Applying network settings… Reconnecting automatically.</Trans>
              )}
            </p>
          ) : null}
          <Button disabled={busy || preparing} onClick={() => void confirm()}>
            <Trans>Apply and restart</Trans>
          </Button>
        </>
      ) : status ? (
        <p>
          <Trans>Stop computers and restart the deployment to apply.</Trans>
        </p>
      ) : null}
      <AlertDialog
        open={preview !== null}
        onOpenChange={(open) => {
          if (!open) setPreview(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Apply network settings?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>
                Save open files first. The app will wait for active work, save and stop computers,
                then restart.
              </Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {preview?.computers.length ? (
            <ul className="max-h-40 overflow-auto text-sm text-muted-foreground">
              {preview.computers.map((computer) => (
                <li key={computer.id}>{computer.name}</li>
              ))}
            </ul>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => void apply()}>
              <Trans>Apply and restart</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
