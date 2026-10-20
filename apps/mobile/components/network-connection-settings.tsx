import type { NetworkConnection } from "@rakazo/contracts";
import { useEffect, useRef, useState } from "react";
import { Linking, Text, View } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { NativeActionButton } from "./native-action-button";

export function NetworkConnectionSettings({
  onChange,
}: {
  onChange: (value: NetworkConnection) => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
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
      const value = await rpc<NetworkConnection>(
        connect ? "network/connect" : "network/connection",
      );
      if (!alive.current) return;
      setConnection(value);
      onChange(value);
      setError(null);
    } catch {
      if (alive.current) setError(t("Could not connect to the network gateway"));
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
  async function authorize(url: string) {
    try {
      await Linking.openURL(url);
    } catch {
      setError(t("Could not open Tailscale"));
    }
  }
  return (
    <View style={{ gap: 8 }}>
      {connection?.available ? (
        <>
          <Text style={{ color: native.secondaryLabel, fontSize: 14 }}>
            {connection.state === "connected"
              ? `${t("Tailscale connected")} · ${connection.tailnet ?? ""}`
              : connection.state === "needs-approval"
                ? t("Approve this device in Tailscale.")
                : connection.authUrl
                  ? t("Finish connecting in Tailscale.")
                  : t("Tailscale is not connected.")}
          </Text>
          {connection.authUrl ? (
            <NativeActionButton
              label={t("Continue in Tailscale")}
              onPress={() => void authorize(connection.authUrl!)}
            />
          ) : connection.state !== "connected" && connection.state !== "needs-approval" ? (
            <NativeActionButton
              label={t("Connect Tailscale")}
              disabled={busy}
              onPress={() => void load(true)}
            />
          ) : null}
          <NativeActionButton
            label={t("Refresh connection")}
            prominence="quiet"
            disabled={busy}
            onPress={() => void load()}
          />
        </>
      ) : connection ? (
        <Text style={{ color: native.secondaryLabel }}>
          {t("Tailscale connection is managed on the server.")}
        </Text>
      ) : null}
      {error ? (
        <>
          <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
            {error}
          </Text>
          <NativeActionButton
            label={t("Retry connection")}
            disabled={busy}
            onPress={() => void load()}
          />
        </>
      ) : null}
    </View>
  );
}
