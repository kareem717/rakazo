import { Alert } from "react-native";
import type { t as translate } from "./i18n";

export function confirmDeleteSection(
  section: { id: string; name: string },
  t: typeof translate,
  onDelete: () => void,
) {
  Alert.alert(
    t("Delete {name}?", { name: section.name }),
    t("Its chats are kept. Subsections move up one level."),
    [
      { text: t("Cancel"), style: "cancel" },
      { text: t("Delete"), style: "destructive", onPress: onDelete },
    ],
  );
}
