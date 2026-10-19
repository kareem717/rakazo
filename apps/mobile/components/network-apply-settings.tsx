import type { NetworkApplyStatus } from "@rakazo/contracts";
import { isNetworkApplying, waitForNetworkApply } from "@rakazo/core";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { errorText } from "../lib/user-error";
import { NativeActionButton } from "./native-action-button";

export function NetworkApplySettings({
  revision,
  onApplied,
  onBusy,
}: {
  revision: string;
  onApplied: () => void;
  onBusy: (busy: boolean) => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [status, setStatus] = useState<NetworkApplyStatus | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [attempt, setAttempt] = useState(0);
  const alive = useRef<AbortController | null>(null);
  const callbacks = useRef({ onApplied, onBusy });
  callbacks.current = { onApplied, onBusy };
  const read = () => rpc<NetworkApplyStatus>("network/applyStatus");
  async function follow(operation: NetworkApplyStatus, signal: AbortSignal) {
    setBusy(true);
    callbacks.current.onBusy(true);
    try {
      await waitForNetworkApply(read, operation, signal, setStatus);
      if (!signal.aborted) callbacks.current.onApplied();
    } catch (cause) {
      if (!signal.aborted) setError(errorText(cause, t("Could not apply network settings")));
    } finally {
      if (!signal.aborted) {
        setBusy(false);
        callbacks.current.onBusy(false);
      }
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    alive.current = controller;
    void read()
      .then((next) => {
        if (controller.signal.aborted) return;
        setStatus(next);
        if (isNetworkApplying(next)) void follow(next, controller.signal);
        else if (next.phase === "failed") setError(next.error);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(t("Could not reach the network restart service"));
      });
    return () => {
      controller.abort();
      callbacks.current.onBusy(false);
    };
  }, [attempt]);
  async function apply() {
    if (busy || !status?.available || !alive.current) return;
    setBusy(true);
    setError(null);
    callbacks.current.onBusy(true);
    try {
      const operation = await rpc<NetworkApplyStatus>("network/apply", { revision });
      setStatus(operation);
      await follow(operation, alive.current.signal);
    } catch (cause) {
      setError(errorText(cause, t("Could not apply network settings")));
      setBusy(false);
      callbacks.current.onBusy(false);
    }
  }
  return (
    <View style={{ gap: 8 }}>
      {status?.available ? (
        <>
          <Text style={{ color: native.secondaryLabel }}>
            {busy
              ? t("Applying network settings… Reconnecting automatically.")
              : t("Stop computers before applying.")}
          </Text>
          <NativeActionButton
            label={t("Apply and restart")}
            busy={busy}
            onPress={() => void apply()}
          />
        </>
      ) : status ? (
        <Text style={{ color: native.secondaryLabel }}>
          {t("Stop computers and restart the deployment to apply.")}
        </Text>
      ) : null}
      {error ? (
        <>
          <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
            {error}
          </Text>
          <NativeActionButton
            label={t("Check restart status")}
            disabled={busy}
            onPress={() => {
              setError(null);
              setAttempt((value) => value + 1);
            }}
          />
        </>
      ) : null}
    </View>
  );
}
