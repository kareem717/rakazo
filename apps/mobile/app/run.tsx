import type { RunDetails } from "@rakazo/contracts";
import { humanizeToolName, isActive } from "@rakazo/core";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { glassHeaderOptions } from "../components/glass-title";
import { NativeActionButton } from "../components/native-action-button";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";

export default function RunActivityPage() {
  const { runId } = useLocalSearchParams<{ runId: string }>();
  const router = useRouter();
  const styles = useThemedStyles(createStyles);
  const { t } = useI18n();
  const [details, setDetails] = useState<RunDetails | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const result = await rpc<RunDetails>("runs/get", { runId });
        if (cancelled) return;
        setDetails(result);
        setFailed(false);
        if (isActive(result.run.status)) timer = setTimeout(() => void load(), 3_000);
      } catch {
        if (!cancelled) {
          setFailed(true);
          timer = setTimeout(() => void load(), 5_000);
        }
      }
    }
    setDetails(null);
    if (runId) void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [runId]);
  const run = details?.run;
  const labels: Record<string, string> = {
    queued: t("Waiting in line…"),
    leased: t("Starting…"),
    running: t("Working…"),
    waiting_input: t("Needs an answer"),
    waiting_takeover: t("Needs you"),
    completed: t("Done"),
    failed: t("Failed"),
    cancelled: t("Cancelled"),
  };
  const time = (at: string) => new Date(at).toLocaleTimeString();
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      <Stack.Screen
        options={{
          ...glassHeaderOptions,
          title: details?.routineName ?? run?.botName ?? t("Run activity"),
        }}
      />
      {!details && !failed ? <ActivityIndicator color={native.secondaryLabel} /> : null}
      {failed ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {t("Could not load run")}
        </Text>
      ) : null}
      {run && details ? (
        <>
          <Text style={styles.text}>
            {run.retry
              ? t("Retrying {attempt}/{maxAttempts}…", {
                  attempt: run.retry.attempt,
                  maxAttempts: run.retry.maxAttempts,
                })
              : labels[run.status]}
          </Text>
          {run.retry ? (
            <Text style={styles.muted}>{t("Retry at {time}", { time: time(run.retry.at) })}</Text>
          ) : null}
          {details.error ? (
            <Text selectable style={styles.error}>
              {details.error}
            </Text>
          ) : null}
          <NativeActionButton
            label={t("Open chat")}
            onPress={() => {
              if (run.groupId)
                router.push({
                  pathname: "/group-thread",
                  params: { groupId: run.groupId, name: run.groupName ?? "" },
                });
              else
                router.push({
                  pathname: "/thread",
                  params: {
                    botId: run.botId,
                    name: run.botName,
                    ...(details.messageId ? { messageId: details.messageId } : {}),
                  },
                });
            }}
          />
          <Text style={styles.heading}>{t("Recent activity")}</Text>
          {details.tools.length ? (
            details.tools.map((tool) => (
              <View key={tool.id} style={styles.tool}>
                <Text style={styles.time}>{time(tool.startedAt)}</Text>
                <Text style={styles.text}>{humanizeToolName(tool.name)}</Text>
                <Text style={tool.status === "failed" ? styles.error : styles.muted}>
                  {tool.status === "succeeded"
                    ? t("Done")
                    : tool.status === "failed"
                      ? t("Failed")
                      : tool.status === "running"
                        ? t("Working…")
                        : tool.status === "paused"
                          ? t("Needs input")
                          : t("Interrupted")}
                </Text>
                {tool.error ? (
                  <Text selectable style={styles.error}>
                    {tool.error}
                  </Text>
                ) : null}
              </View>
            ))
          ) : (
            <Text style={styles.muted}>{t("No tool activity recorded")}</Text>
          )}
          {details.attempts.length > 1 ? (
            <>
              <Text style={styles.heading}>
                {t("Attempts")} · {details.attempts.length}
              </Text>
              {details.attempts.map((attempt) => (
                <View key={attempt.number} style={styles.attempt}>
                  <Text style={styles.muted}>
                    {attempt.number} · {time(attempt.startedAt)}
                  </Text>
                  {attempt.error ? (
                    <Text selectable style={styles.error}>
                      {attempt.error}
                    </Text>
                  ) : null}
                </View>
              ))}
            </>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: tokens.background },
    content: { padding: 24, gap: 18 },
    text: { color: tokens.foreground },
    muted: { color: tokens.mutedForeground },
    error: { color: tokens.destructive },
    heading: { color: tokens.foreground, fontWeight: "600" },
    time: { color: tokens.mutedForeground, fontSize: 12 },
    tool: { gap: 4, paddingVertical: 8, borderBottomWidth: 1, borderColor: tokens.border },
    attempt: { gap: 4 },
  });
}
