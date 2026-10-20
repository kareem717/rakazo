import type { LiveCallSettings as Settings } from "@rakazo/contracts";
import { LiveCallSettingsSchema } from "@rakazo/contracts";
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";
import { errorText } from "../lib/user-error";
import { MenuPicker } from "./menu-picker";
import { NativeActionButton } from "./native-action-button";

type Provider = { id: string; name: string; connected: boolean; defaults: Settings };
export function LiveCallSettings({ connectionsKey }: { connectionsKey?: string }) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState(LiveCallSettingsSchema.parse({}));
  const [advanced, setAdvanced] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useFocusEffect(
    useCallback(() => {
      let current = true;
      void Promise.all([
        rpc<Settings>("voice/callSettings"),
        rpc<Provider[]>("voice/callProviders"),
      ])
        .then(([settings, catalog]) => {
          if (current) {
            setSaved(settings);
            setDraft(settings);
            setProviders(catalog);
          }
        })
        .catch((err) => {
          if (current) setError(errorText(err, t("Could not load call settings")));
        });
      return () => {
        current = false;
      };
    }, [connectionsKey]),
  );
  if (!providers.length && !error) return null;
  const dirty = saved !== null && JSON.stringify(saved) !== JSON.stringify(draft);
  async function save() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const settings = await rpc<Settings>("voice/setCallSettings", draft);
      setSaved(settings);
      setDraft(settings);
    } catch (err) {
      setError(errorText(err, t("Could not save call settings")));
    } finally {
      setPending(false);
    }
  }
  return (
    <View style={styles.group}>
      <MenuPicker
        label={t("Calls")}
        choices={[
          { key: "", label: t("Standard") },
          ...providers.map((p) => ({ key: p.id, label: p.name })),
        ]}
        value={draft.provider ?? ""}
        onChange={(key) => {
          if (pending || !saved) return;
          const provider = providers.find((p) => p.id === key);
          if (provider && !provider.connected) {
            setError(t("Connect the live call provider first."));
            return;
          }
          setDraft(provider ? { ...provider.defaults } : { ...draft, provider: null });
        }}
      />
      {draft.provider ? (
        <View style={styles.fields}>
          <NativeActionButton
            label={t("Advanced")}
            prominence="plain"
            onPress={() => setAdvanced(!advanced)}
          />
          {advanced ? (
            <>
              {(
                [
                  ["modelId", t("Conversation model")],
                  ["speechModel", t("Speech model")],
                  ["transcriptionModel", t("Transcription model")],
                  ["language", t("Language")],
                ] as const
              ).map(([key, label]) => (
                <View key={key} style={styles.field}>
                  <Text style={styles.label}>{label}</Text>
                  <TextInput
                    accessibilityLabel={label}
                    style={styles.input}
                    value={draft[key]}
                    editable={!pending}
                    maxLength={200}
                    autoCorrect={false}
                    autoCapitalize="none"
                    onChangeText={(value) => setDraft({ ...draft, [key]: value })}
                  />
                </View>
              ))}
              <View style={styles.field}>
                <Text style={styles.label}>{t("Call limit (minutes)")}</Text>
                <TextInput
                  accessibilityLabel={t("Call limit (minutes)")}
                  style={styles.input}
                  value={String(draft.maxDurationSeconds / 60)}
                  editable={!pending}
                  keyboardType="number-pad"
                  onChangeText={(value) =>
                    setDraft({ ...draft, maxDurationSeconds: Number(value) * 60 })
                  }
                />
              </View>
            </>
          ) : null}
        </View>
      ) : null}
      {dirty ? (
        <View style={styles.fields}>
          <NativeActionButton label={t("Save")} busy={pending} onPress={() => void save()} />
        </View>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}
function createStyles() {
  return StyleSheet.create({
    group: {
      backgroundColor: native.groupedCell,
      borderRadius: 12,
      overflow: "hidden",
    },
    fields: { padding: 16, gap: 14 },
    field: { gap: 6 },
    label: { color: native.secondaryLabel, fontSize: 13 },
    input: {
      color: native.label,
      backgroundColor: native.fill,
      borderRadius: 8,
      padding: 12,
      fontSize: 16,
    },
    error: { color: mobileTokens().destructive, padding: 16, fontSize: 13 },
  });
}
