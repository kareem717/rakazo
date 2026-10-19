import { MenuView } from "@expo/ui/community/menu";
import type { ScreenControlCommand } from "@rakazo/core";
import * as Clipboard from "expo-clipboard";
import { Alert, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";
import { NativeSymbol } from "./native-symbol";

export function ComputerClipboardMenu({
  sync,
  onSync,
  onCommand,
}: {
  sync: boolean;
  onSync: (enabled: boolean) => void;
  onCommand: (command: ScreenControlCommand) => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const appearance = useResolvedAppearance();
  const failed = () => Alert.alert(t("Could not access clipboard"));
  return (
    <MenuView
      title={t("Clipboard")}
      colorScheme={appearance}
      actions={[
        { id: "copy", title: t("Copy") },
        { id: "paste", title: t("Paste") },
        { id: "a", title: t("Select all") },
        { id: "x", title: t("Cut") },
        { id: "z", title: t("Undo") },
        { id: "y", title: t("Redo") },
        { id: "sync", title: t("Sync clipboard"), state: sync ? "on" : "off" },
      ]}
      onPressAction={(event) => {
        const action = event.nativeEvent.event;
        if (action === "copy") onCommand({ request: "shortcut", key: "c" });
        else if (action === "paste")
          void Clipboard.getStringAsync().then(
            (value) => onCommand({ request: "paste", text: value }),
            failed,
          );
        else if (action === "sync") onSync(!sync);
        else if (action === "a" || action === "x" || action === "z" || action === "y")
          onCommand({ request: "shortcut", key: action });
      }}
    >
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel={t("Clipboard")}
        style={{ padding: 10 }}
      >
        <NativeSymbol
          ios="doc.on.clipboard"
          android="clipboard-outline"
          size={18}
          color={tokens.foreground}
        />
      </View>
    </MenuView>
  );
}
