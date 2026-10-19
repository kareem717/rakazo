import { Trans, useLingui } from "@lingui/react/macro";
import type { NetworkConnection } from "@rakazo/contracts";
import { Button, buttonVariants } from "@rakazo/ui-web";
import { useEffect, useRef, useState } from "react";
import { rpc } from "../lib/rpc";

export function NetworkConnectionSettings({
  onChange,
}: {
  onChange: (value: NetworkConnection) => void;
}) {
  const { t } = useLingui();
  const [connection, setConnection] = useState<NetworkConnection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(false);
  const pending = useRef(false);
  async function load(connect = false) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      const value = await (connect ? rpc.network.connect() : rpc.network.connection());
      if (!alive.current) return;
      setConnection(value);
      onChange(value);
      setError(null);
    } catch {
      if (alive.current) setError(t`Could not connect to the network gateway`);
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, []);
  const waiting =
    connection?.available && connection.state !== "connected" && connection.state !== "stopped";
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [Boolean(waiting)]);
  return (
    <div className="space-y-2 text-[13px] text-muted-foreground" data-testid="network-connection">
      {connection?.available ? (
        <>
          <p>
            {connection.state === "connected" ? (
              <Trans>Tailscale connected · {connection.tailnet}</Trans>
            ) : connection.state === "needs-approval" ? (
              <Trans>Approve this device in Tailscale.</Trans>
            ) : connection.authUrl ? (
              <Trans>Finish connecting in Tailscale.</Trans>
            ) : (
              <Trans>Tailscale is not connected.</Trans>
            )}
          </p>
          <div className="flex flex-wrap gap-2">
            {connection.authUrl ? (
              <a
                className={buttonVariants()}
                href={connection.authUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Trans>Continue in Tailscale</Trans>
              </a>
            ) : connection.state !== "connected" && connection.state !== "needs-approval" ? (
              <Button disabled={busy} onClick={() => void load(true)}>
                <Trans>Connect Tailscale</Trans>
              </Button>
            ) : null}
            <Button variant="outline" disabled={busy} onClick={() => void load()}>
              <Trans>Refresh connection</Trans>
            </Button>
          </div>
        </>
      ) : connection ? (
        <p>
          <Trans>Tailscale connection is managed on the server.</Trans>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
      {error ? (
        <Button variant="outline" disabled={busy} onClick={() => void load()}>
          <Trans>Retry connection</Trans>
        </Button>
      ) : null}
    </div>
  );
}
