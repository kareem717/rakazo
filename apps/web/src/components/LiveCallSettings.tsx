import { Trans, useLingui } from "@lingui/react/macro";
import type { LiveCallSettings as Settings } from "@rakazo/contracts";
import { LiveCallSettingsSchema } from "@rakazo/contracts";
import { Button, Field, FieldLabel, Input, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import { useSpaceRpc } from "../lib/space-rpc";
import { errorText } from "../lib/user-error";

type Provider = { id: string; name: string; connected: boolean; defaults: Settings };

export function LiveCallSettings({
  disabled,
  onBusyChange,
  connectionsKey,
}: {
  connectionsKey?: string;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const rpc = useSpaceRpc();
  const { t } = useLingui();
  const id = useId();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings>(LiveCallSettingsSchema.parse({}));
  const [advanced, setAdvanced] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void Promise.all([rpc.voice.callSettings(), rpc.voice.callProviders()])
      .then(([settings, catalog]) => {
        if (!current) return;
        setSaved(settings);
        setDraft(settings);
        setProviders(catalog);
      })
      .catch((err) => {
        if (current) setError(errorText(err, t`Could not load call settings`));
      });
    return () => {
      current = false;
    };
  }, [rpc, connectionsKey]);
  if (!providers.length && !error) return null;
  const dirty = saved !== null && JSON.stringify(saved) !== JSON.stringify(draft);
  const busy = pending || disabled;
  async function save() {
    setPending(true);
    onBusyChange?.(true);
    setError(null);
    try {
      const settings = await rpc.voice.setCallSettings(draft);
      setSaved(settings);
      setDraft(settings);
    } catch (err) {
      setError(errorText(err, t`Could not save call settings`));
    } finally {
      setPending(false);
      onBusyChange?.(false);
    }
  }
  return (
    <div className="mb-6 space-y-3">
      <Field>
        <FieldLabel htmlFor={`${id}-provider`}>
          <Trans>Calls</Trans>
        </FieldLabel>
        <NativeSelect
          id={`${id}-provider`}
          disabled={busy || !saved}
          value={draft.provider ?? ""}
          onChange={(event) => {
            const provider = providers.find((p) => p.id === event.target.value);
            setDraft(provider ? { ...provider.defaults } : { ...draft, provider: null });
          }}
        >
          <NativeSelectOption value="">
            <Trans>Standard</Trans>
          </NativeSelectOption>
          {providers.map((p) => (
            <NativeSelectOption key={p.id} value={p.id} disabled={!p.connected}>
              {p.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      {draft.provider ? (
        <>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={advanced}
            onClick={() => setAdvanced(!advanced)}
          >
            <Trans>Advanced</Trans>
          </Button>
          {advanced ? (
            <div className="space-y-4">
              {(
                [
                  ["modelId", t`Conversation model`],
                  ["speechModel", t`Speech model`],
                  ["transcriptionModel", t`Transcription model`],
                  ["language", t`Language`],
                ] as const
              ).map(([key, label]) => (
                <Field key={key}>
                  <FieldLabel htmlFor={`${id}-${key}`}>{label}</FieldLabel>
                  <Input
                    id={`${id}-${key}`}
                    value={draft[key]}
                    maxLength={200}
                    disabled={busy}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                  />
                </Field>
              ))}
              <Field>
                <FieldLabel htmlFor={`${id}-duration`}>
                  <Trans>Call limit (minutes)</Trans>
                </FieldLabel>
                <Input
                  id={`${id}-duration`}
                  type="number"
                  min={1}
                  max={60}
                  value={draft.maxDurationSeconds / 60}
                  disabled={busy}
                  onChange={(event) =>
                    setDraft({ ...draft, maxDurationSeconds: Number(event.target.value) * 60 })
                  }
                />
              </Field>
            </div>
          ) : null}
        </>
      ) : null}
      {dirty ? (
        <Button disabled={busy} onClick={() => void save()}>
          <Trans>Save</Trans>
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
