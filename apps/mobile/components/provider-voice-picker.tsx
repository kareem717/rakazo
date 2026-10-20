import type { VoiceInfo } from "@rakazo/contracts";
import { voiceChoices } from "@rakazo/core";
import { useEffect, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { errorText } from "../lib/user-error";
import { MenuPicker } from "./menu-picker";

export function ProviderVoicePicker({
  provider,
  value,
  onChange,
  disabled = false,
  allowDefault = false,
}: {
  provider?: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  allowDefault?: boolean;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [query, setQuery] = useState("");
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    const timeout = setTimeout(
      () => {
        void rpc<VoiceInfo[]>("voice/voices", { provider, query: query.trim() || undefined })
          .then(async (listed) => {
            if (!current) return;
            setVoices(listed);
            setLoading(false);
            if (!query && value && !listed.some((voice) => voice.id === value)) {
              const saved = await rpc<VoiceInfo[]>("voice/voices", {
                provider,
                query: value,
              }).catch(() => []);
              listed = [...listed, ...saved.filter((voice) => voice.id === value)];
            }
            if (current) setVoices(listed);
          })
          .catch((err: unknown) => {
            if (current) {
              setVoices([]);
              setError(errorText(err, t("Could not load voices")));
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
  }, [provider, query, value]);
  const choices = [
    ...(allowDefault ? [{ key: "", label: t("Space default") }] : []),
    ...voiceChoices(voices, value).map((voice) => ({ key: voice.id, label: voice.label })),
  ];
  return (
    <View style={{ marginTop: 16 }}>
      <TextInput
        accessibilityLabel={t("Search voices")}
        placeholder={t("Search voices or paste a voice link")}
        value={query}
        onChangeText={setQuery}
        editable={!disabled}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={2048}
        placeholderTextColor={native.tertiaryLabel}
        style={{
          backgroundColor: native.fill,
          color: tokens.foreground,
          padding: 12,
          borderRadius: 11,
        }}
      />
      <View
        pointerEvents={disabled || loading ? "none" : "auto"}
        accessibilityState={{ disabled: disabled || loading }}
      >
        <MenuPicker
          label={t("Voice")}
          choices={allowDefault ? choices : [{ key: "", label: t("Select a voice") }, ...choices]}
          value={value}
          onChange={(key) => {
            if (!disabled && !loading && (key || allowDefault)) onChange(key);
          }}
        />
      </View>
      {error ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
          {error}
        </Text>
      ) : null}
      {!loading && !error && query && !voices.length ? (
        <Text style={{ color: tokens.mutedForeground }}>{t("No voices found")}</Text>
      ) : null}
    </View>
  );
}
