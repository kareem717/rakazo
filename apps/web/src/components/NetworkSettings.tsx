import { Trans, useLingui } from "@lingui/react/macro";
import type {
  EgressMode,
  NetworkConnection,
  NetworkSettings,
  NetworkSettingsDraft,
} from "@rakazo/contracts";
import { networkConfigFromDraft, networkSettingsDraft } from "@rakazo/contracts";
import {
  Button,
  Field,
  FieldLabel,
  Input,
  Label,
  NativeSelect,
  NativeSelectOption,
  Switch,
} from "@rakazo/ui-web";
import { useEffect, useId, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { NetworkConnectionSettings } from "./NetworkConnectionSettings";

export function NetworkSettingsSection() {
  const [open, setOpen] = useState(false);
  return (
    <details className="mt-5" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-[14px]">
        <Trans>Network</Trans>
      </summary>
      {open ? <NetworkSettingsForm /> : null}
    </details>
  );
}

export function NetworkSettingsForm() {
  const { t } = useLingui();
  const [state, setState] = useState<NetworkSettings | null>(null);
  const [connection, setConnection] = useState<NetworkConnection | null>(null);
  const [draft, setDraft] = useState<NetworkSettingsDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const submitting = useRef(false);
  const id = useId();
  useEffect(() => {
    let cancelled = false;
    setError(null);
    void rpc.network
      .get()
      .then((result) => {
        if (cancelled) return;
        setState(result);
        setDraft(result.available ? networkSettingsDraft(result.saved) : null);
      })
      .catch(() => {
        if (!cancelled) setError(t`Could not load network settings`);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);
  const config = draft ? networkConfigFromDraft(draft) : null;
  const dirty =
    state?.available && config && JSON.stringify(config) !== JSON.stringify(state.saved);
  const disabled = busy || !state?.available || !state.writable;
  const patch = (value: Partial<NetworkSettingsDraft>) =>
    setDraft((previous) => (previous ? { ...previous, ...value } : null));
  async function save() {
    if (submitting.current || !state?.available || !config || disabled) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.network.save({ config, revision: state.revision });
      setState(result);
      if (result.available) setDraft(networkSettingsDraft(result.saved));
    } catch (cause) {
      setError(errorText(cause, t`Could not save network settings`));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  function textField(label: string, key: "target" | "url" | "exitNode", placeholder: string) {
    return (
      <Field>
        <FieldLabel htmlFor={`${id}-${key}`}>{label}</FieldLabel>
        <Input
          id={`${id}-${key}`}
          value={draft?.[key] ?? ""}
          onChange={(event) => patch({ [key]: event.target.value })}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          list={key === "exitNode" ? `${id}-exit-nodes` : undefined}
        />
      </Field>
    );
  }
  return (
    <div data-testid="network-settings" className="mt-4 space-y-4">
      {state?.available && draft ? (
        <>
          <Field>
            <FieldLabel htmlFor={`${id}-mode`}>
              <Trans>Routing</Trans>
            </FieldLabel>
            <NativeSelect
              id={`${id}-mode`}
              value={draft.mode}
              onChange={(event) => patch({ mode: event.target.value as EgressMode })}
              disabled={disabled}
            >
              <NativeSelectOption value="direct">
                <Trans>Direct</Trans>
              </NativeSelectOption>
              <NativeSelectOption value="browser">
                <Trans>Browser only</Trans>
              </NativeSelectOption>
              <NativeSelectOption value="tools">
                <Trans>Browser + tools</Trans>
              </NativeSelectOption>
              <NativeSelectOption value="all">
                <Trans>Everything</Trans>
              </NativeSelectOption>
            </NativeSelect>
          </Field>
          {draft.mode === "all" ||
          ((draft.mode === "browser" || draft.mode === "tools") &&
            draft.transport === "ssh" &&
            draft.tailscale) ? (
            <NetworkConnectionSettings onChange={setConnection} />
          ) : null}
          {draft.mode === "browser" || draft.mode === "tools" ? (
            <>
              <Field>
                <FieldLabel htmlFor={`${id}-transport`}>
                  <Trans>Connection</Trans>
                </FieldLabel>
                <NativeSelect
                  id={`${id}-transport`}
                  value={draft.transport}
                  disabled={disabled}
                  onChange={(event) => patch({ transport: event.target.value as "ssh" | "socks5" })}
                >
                  <NativeSelectOption value="ssh">SSH</NativeSelectOption>
                  <NativeSelectOption value="socks5">SOCKS5</NativeSelectOption>
                </NativeSelect>
              </Field>
              {draft.transport === "ssh" ? (
                <>
                  {textField(t`SSH target`, "target", "proxy@egress.example.test")}
                  <div className="flex items-center gap-3">
                    <Switch
                      id={`${id}-tailscale`}
                      checked={draft.tailscale}
                      disabled={disabled}
                      onCheckedChange={(tailscale) => patch({ tailscale })}
                    />
                    <Label htmlFor={`${id}-tailscale`}>
                      <Trans>Use Tailscale</Trans>
                    </Label>
                  </div>
                </>
              ) : (
                textField(t`SOCKS URL`, "url", "socks5://proxy.example.test:1080")
              )}
            </>
          ) : null}
          {draft.mode === "all" ? (
            <>
              {textField(t`Tailscale exit node`, "exitNode", "exit.example.ts.net")}
              <datalist id={`${id}-exit-nodes`}>
                {connection?.available
                  ? connection.exitNodes.map((node) => (
                      <option key={node.value} value={node.value}>
                        {node.name}
                        {node.online ? "" : ` (${t`Offline`})`}
                      </option>
                    ))
                  : null}
              </datalist>
              <p className="text-[13px] text-muted-foreground">
                <Trans>
                  App and computer traffic uses the exit node. Local traffic stays direct.
                </Trans>
              </p>
            </>
          ) : null}
          {!state.writable ? (
            <p className="text-[13px] text-muted-foreground">
              <Trans>Network settings are managed on the server.</Trans>
            </p>
          ) : (
            <Button onClick={() => void save()} disabled={disabled || !dirty || !config}>
              <Trans>Save</Trans>
            </Button>
          )}
          {state.restartRequired ? (
            <div role="status" className="text-[13px] text-muted-foreground">
              <p className="font-medium">
                <Trans>Restart required</Trans>
              </p>
              <p>
                <Trans>Stop computers and restart the deployment to apply.</Trans>
              </p>
            </div>
          ) : null}
        </>
      ) : state ? (
        <p className="text-[13px] text-muted-foreground">
          <Trans>Network settings are managed on the server.</Trans>
        </p>
      ) : null}
      {error ? (
        <div role="alert" className="text-[13px] text-destructive">
          {error}
          <Button variant="link" disabled={busy} onClick={() => setAttempt((value) => value + 1)}>
            <Trans>Reload</Trans>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
