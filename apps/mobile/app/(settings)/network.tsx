import type {
  EgressMode,
  NetworkConnection,
  NetworkSettings,
  NetworkSettingsDraft,
} from "@rakazo/contracts";
import { networkConfigFromDraft, networkSettingsDraft } from "@rakazo/contracts";
import { Stack } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { glassHeaderOptions } from "../../components/glass-title";
import { MenuPicker } from "../../components/menu-picker";
import { NativeActionButton } from "../../components/native-action-button";
import { NetworkConnectionSettings } from "../../components/network-connection-settings";
import { SettingsGroup, SettingsRow, SettingsSwitch } from "../../components/settings-group";
import { rpc } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import { native, useThemedStyles } from "../../lib/native";
import { errorText } from "../../lib/user-error";

export default function NetworkSettingsScreen() {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const [state, setState] = useState<NetworkSettings | null>(null);
  const [connection, setConnection] = useState<NetworkConnection | null>(null);
  const [draft, setDraft] = useState<NetworkSettingsDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const submitting = useRef(false);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    void rpc<NetworkSettings>("network/get")
      .then((result) => {
        if (cancelled) return;
        setState(result);
        setDraft(result.available ? networkSettingsDraft(result.saved) : null);
      })
      .catch(() => {
        if (!cancelled) setError(t("Could not load network settings"));
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
  const modes = [
    { key: "direct", label: t("Direct") },
    { key: "browser", label: t("Browser only") },
    { key: "tools", label: t("Browser + tools") },
    { key: "all", label: t("Everything") },
  ];
  async function save() {
    if (submitting.current || !state?.available || !config || disabled) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await rpc<NetworkSettings>("network/save", {
        config,
        revision: state.revision,
      });
      setState(result);
      if (result.available) setDraft(networkSettingsDraft(result.saved));
    } catch (cause) {
      setError(errorText(cause, t("Could not save network settings")));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  function field(label: string, key: "target" | "url" | "exitNode", placeholder: string) {
    return (
      <View style={styles.field}>
        <Text style={styles.label}>{label}</Text>
        <TextInput
          accessibilityLabel={label}
          value={draft?.[key] ?? ""}
          onChangeText={(value) => patch({ [key]: value })}
          editable={!disabled}
          placeholder={placeholder}
          placeholderTextColor={native.tertiaryLabel}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
        />
      </View>
    );
  }
  return (
    <ScrollView
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={glassHeaderOptions(t("Network"))} />
      {state?.available && draft ? (
        <>
          {draft.mode === "all" ||
          ((draft.mode === "browser" || draft.mode === "tools") &&
            draft.transport === "ssh" &&
            draft.tailscale) ? (
            <NetworkConnectionSettings onChange={setConnection} />
          ) : null}
          <SettingsGroup>
            {disabled ? (
              <SettingsRow
                title={t("Routing")}
                value={modes.find((mode) => mode.key === draft.mode)?.label}
              />
            ) : (
              <MenuPicker
                label={t("Routing")}
                choices={modes}
                value={draft.mode}
                onChange={(mode) => patch({ mode: mode as EgressMode })}
              />
            )}
            {draft.mode === "browser" || draft.mode === "tools" ? (
              <>
                {disabled ? (
                  <SettingsRow
                    title={t("Connection")}
                    value={draft.transport === "ssh" ? "SSH" : "SOCKS5"}
                  />
                ) : (
                  <MenuPicker
                    label={t("Connection")}
                    choices={[
                      { key: "ssh", label: "SSH" },
                      { key: "socks5", label: "SOCKS5" },
                    ]}
                    value={draft.transport}
                    onChange={(transport) => patch({ transport: transport as "ssh" | "socks5" })}
                  />
                )}
                {draft.transport === "ssh" ? (
                  <>
                    {field(t("SSH target"), "target", "proxy@egress.example.test")}
                    <SettingsSwitch
                      label={t("Use Tailscale")}
                      value={draft.tailscale}
                      disabled={disabled}
                      onChange={(tailscale) => patch({ tailscale })}
                    />
                  </>
                ) : (
                  field(t("SOCKS URL"), "url", "socks5://proxy.example.test:1080")
                )}
              </>
            ) : null}
            {draft.mode === "all" ? (
              <>
                {connection?.available && connection.exitNodes.length && !disabled ? (
                  <MenuPicker
                    label={t("Available exit nodes")}
                    choices={connection.exitNodes.map((node) => ({
                      key: node.value,
                      label: `${node.name}${node.online ? "" : ` (${t("Offline")})`}`,
                    }))}
                    value={draft.exitNode}
                    onChange={(exitNode) => patch({ exitNode })}
                  />
                ) : null}
                {field(t("Tailscale exit node"), "exitNode", "exit.example.ts.net")}
              </>
            ) : null}
          </SettingsGroup>
          {draft.mode === "all" ? (
            <Text style={styles.note}>
              {t("App and computer traffic uses the exit node. Local traffic stays direct.")}
            </Text>
          ) : null}
          {state.writable ? (
            <NativeActionButton
              label={t("Save")}
              disabled={disabled || !dirty || !config}
              onPress={() => void save()}
            />
          ) : (
            <Text style={styles.note}>{t("Network settings are managed on the server.")}</Text>
          )}
          {state.restartRequired ? (
            <View accessibilityRole="summary">
              <Text style={styles.label}>{t("Restart required")}</Text>
              <Text style={styles.note}>
                {t("Stop computers and restart the deployment to apply.")}
              </Text>
            </View>
          ) : null}
        </>
      ) : state ? (
        <Text style={styles.note}>{t("Network settings are managed on the server.")}</Text>
      ) : !error ? (
        <ActivityIndicator />
      ) : null}
      {error ? (
        <>
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
          <NativeActionButton
            label={t("Reload")}
            onPress={() => setAttempt((value) => value + 1)}
            disabled={busy}
          />
        </>
      ) : null}
    </ScrollView>
  );
}
function createStyles() {
  return StyleSheet.create({
    content: { padding: 20, gap: 16, paddingBottom: 40 },
    field: { paddingHorizontal: 16, paddingVertical: 12, gap: 8 },
    label: { fontSize: 16, color: native.label },
    input: { fontSize: 16, color: native.label, paddingVertical: 8 },
    note: { fontSize: 14, color: native.secondaryLabel },
    error: { fontSize: 14, color: mobileTokens().destructive },
  });
}
