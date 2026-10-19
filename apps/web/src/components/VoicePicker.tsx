import { Trans, useLingui } from "@lingui/react/macro";
import type { VoiceInfo } from "@rakazo/contracts";
import { voiceChoices } from "@rakazo/core";
import { Input, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import { useSpaceRpc } from "../lib/space-rpc";
import { errorText } from "../lib/user-error";

export function VoicePicker({
  provider,
  value,
  onChange,
  disabled,
  allowDefault = false,
}: {
  provider?: string;
  value: string;
  onChange: (voiceId: string) => void;
  disabled?: boolean;
  allowDefault?: boolean;
}) {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const id = useId();
  const [query, setQuery] = useState("");
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    const timeout = setTimeout(
      () => {
        void rpc.voice
          .voices({ provider, query: query.trim() || undefined })
          .then(async (listed) => {
            if (!query && value && !listed.some((voice) => voice.id === value)) {
              const saved = await rpc.voice.voices({ provider, query: value }).catch(() => []);
              listed = [...listed, ...saved.filter((voice) => voice.id === value)];
            }
            if (current) setVoices(listed);
          })
          .catch((err: unknown) => {
            if (current) {
              setVoices([]);
              setError(errorText(err, t`Could not load voices`));
            }
          })
          .finally(() => {
            if (current) setLoading(false);
          });
      },
      query ? 300 : 0,
    );
    return () => {
      current = false;
      clearTimeout(timeout);
    };
  }, [provider, query, rpc, value]);
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-[14px] text-muted-foreground">
        <Trans>Voice</Trans>
      </label>
      <Input
        aria-label={t`Search voices`}
        placeholder={t`Search voices or paste a voice link`}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
      />
      <NativeSelect
        id={id}
        className="w-full"
        value={value}
        disabled={disabled || loading}
        onChange={(event) => onChange(event.target.value)}
      >
        {allowDefault ? <NativeSelectOption value="">{t`Space default`}</NativeSelectOption> : null}
        {!allowDefault && !value ? (
          <NativeSelectOption value="">{t`Select a voice`}</NativeSelectOption>
        ) : null}
        {voiceChoices(voices, value).map((voice) => (
          <NativeSelectOption key={voice.id} value={voice.id}>
            {voice.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {!loading && !error && query && !voices.length ? (
        <p className="text-sm text-muted-foreground">
          <Trans>No voices found</Trans>
        </p>
      ) : null}
    </div>
  );
}
