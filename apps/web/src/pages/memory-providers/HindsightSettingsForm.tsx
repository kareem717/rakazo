import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import { Button, Field, FieldLabel, Input, Toggle } from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import { useSpaceRpc } from "../../lib/space-rpc";
import type { MemoryProviderSettingsFormProps } from "./registry";

export function HindsightSettingsForm({ busy, onConnect }: MemoryProviderSettingsFormProps) {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const id = useId();
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [bots, setBots] = useState<Bot[]>([]);
  const [botBanks, setBotBanks] = useState<Record<string, string>>({});
  const [sharedBankId, setSharedBankId] = useState("");
  const [allowWrites, setAllowWrites] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void rpc.bots
      .list()
      .then((value) => {
        if (!cancelled) setBots(value);
      })
      .catch(() => {
        if (!cancelled) setError(t`Could not load bots`);
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, t]);

  const mapped = Object.fromEntries(
    Object.entries(botBanks)
      .map(([bot, bank]) => [bot, bank.trim()])
      .filter(([, bank]) => bank),
  );

  async function connect() {
    if (
      await onConnect({
        settings: {
          baseUrl: baseUrl.trim(),
          botBanks: JSON.stringify(mapped),
          allowWrites: String(allowWrites),
          ...(sharedBankId.trim() ? { sharedBankId: sharedBankId.trim() } : {}),
        },
        credentials: { apiKey: apiKey.trim() },
      })
    )
      setApiKey("");
  }

  return (
    <>
      <Field>
        <FieldLabel htmlFor={`${id}-url`}>
          <Trans>API URL</Trans>
        </FieldLabel>
        <Input
          id={`${id}-url`}
          value={baseUrl}
          disabled={busy}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="https://memory.example.com/api"
          autoComplete="off"
        />
      </Field>
      <Field className="mt-4">
        <FieldLabel htmlFor={`${id}-key`}>
          <Trans>API key</Trans>
        </FieldLabel>
        <Input
          id={`${id}-key`}
          value={apiKey}
          disabled={busy}
          onChange={(event) => setApiKey(event.target.value)}
          type="password"
          autoComplete="new-password"
        />
      </Field>
      {error ? <p className="mt-4 text-sm text-destructive">{error}</p> : null}
      {bots.map((bot) => (
        <Field className="mt-4" key={bot.id}>
          <FieldLabel htmlFor={`${id}-${bot.id}`}>{t`Bank for ${bot.name}`}</FieldLabel>
          <Input
            id={`${id}-${bot.id}`}
            value={botBanks[bot.id] ?? ""}
            disabled={busy}
            onChange={(event) =>
              setBotBanks((previous) => ({ ...previous, [bot.id]: event.target.value }))
            }
            placeholder="profile-bank"
            autoComplete="off"
          />
        </Field>
      ))}
      <details className="mt-4 text-sm text-muted-foreground">
        <summary>
          <Trans>Shared memory</Trans>
        </summary>
        <Field className="mt-3">
          <FieldLabel htmlFor={`${id}-shared`}>
            <Trans>Shared bank</Trans>
          </FieldLabel>
          <Input
            id={`${id}-shared`}
            value={sharedBankId}
            disabled={busy}
            onChange={(event) => setSharedBankId(event.target.value)}
            autoComplete="off"
          />
        </Field>
      </details>
      <div className="mt-4 flex gap-2">
        <Toggle
          variant="outline"
          pressed={!allowWrites}
          disabled={busy}
          onPressedChange={() => setAllowWrites(false)}
        >
          <Trans>Recall only</Trans>
        </Toggle>
        <Toggle
          variant="outline"
          pressed={allowWrites}
          disabled={busy}
          onPressedChange={() => setAllowWrites(true)}
        >
          <Trans>Recall and write</Trans>
        </Toggle>
      </div>
      <Button
        type="button"
        variant="secondary"
        className="mt-5 rounded-full"
        size="sm"
        disabled={
          busy || !baseUrl.trim() || apiKey.trim().length < 8 || !Object.keys(mapped).length
        }
        onClick={() => void connect()}
      >
        {busy ? <Trans>Connecting…</Trans> : <Trans>Connect</Trans>}
      </Button>
    </>
  );
}
