import type { BotSection } from "@rakazo/contracts";
import { sectionDestinations } from "@rakazo/core";
import { useState } from "react";
import { Modal, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { confirmDeleteSection } from "../lib/confirm-delete-section";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";
import { errorText } from "../lib/user-error";
import { MenuPicker } from "./menu-picker";
import { NativeActionButton } from "./native-action-button";

export function SectionEditor({
  section,
  sections,
  onSave,
  onRemove,
  onClose,
}: {
  section?: BotSection;
  sections: BotSection[];
  onSave: (input: { sectionId?: string; name: string; parentId: string | null }) => Promise<void>;
  onRemove: () => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const [name, setName] = useState(section?.name ?? "");
  const [parentId, setParentId] = useState(section?.parentId ?? "");
  const [creating, setCreating] = useState(!section);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choices = [
    { key: "", label: t("None") },
    ...sectionDestinations(sections, creating ? undefined : section?.id).map((item) => ({
      key: item.id,
      label: item.path,
    })),
  ];
  return (
    <Modal
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={() => {
        if (!saving) onClose();
      }}
    >
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.sheet}>
        <View style={styles.header}>
          <NativeActionButton
            label={t("Cancel")}
            fill={false}
            disabled={saving}
            onPress={onClose}
          />
          <NativeActionButton
            label={creating ? t("Create") : t("Save")}
            fill={false}
            disabled={saving || !name.trim()}
            onPress={() => {
              if (saving || !name.trim()) return;
              setSaving(true);
              setError(null);
              void onSave({
                ...(creating ? {} : { sectionId: section?.id }),
                name: name.trim(),
                parentId: parentId || null,
              })
                .then(onClose)
                .catch((err) => {
                  setError(errorText(err, t("Could not update section")));
                  setSaving(false);
                });
            }}
          />
        </View>
        <Text style={styles.title}>{creating ? t("New section") : t("Edit section")}</Text>
        <TextInput
          accessibilityLabel={t("Name")}
          placeholder={t("Name")}
          placeholderTextColor={native.secondaryLabel}
          value={name}
          maxLength={60}
          editable={!saving}
          onChangeText={setName}
          style={styles.input}
        />
        <View pointerEvents={saving ? "none" : "auto"}>
          <MenuPicker
            label={t("Parent section")}
            choices={choices}
            value={parentId}
            onChange={setParentId}
          />
        </View>
        {section && !creating ? (
          <NativeActionButton
            label={t("New subsection")}
            prominence="secondary"
            disabled={saving}
            onPress={() => {
              setCreating(true);
              setName("");
              setParentId(section.id);
              setError(null);
            }}
          />
        ) : null}
        {section && !creating ? (
          <NativeActionButton
            label={t("Delete section")}
            prominence="secondary"
            disabled={saving}
            onPress={() => {
              confirmDeleteSection(section, t, () => {
                setSaving(true);
                setError(null);
                void onRemove()
                  .then(onClose)
                  .catch((err) => {
                    setError(errorText(err, t("Could not delete section")));
                    setSaving(false);
                  });
              });
            }}
          />
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}
      </ScrollView>
    </Modal>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    sheet: { flexGrow: 1, backgroundColor: tokens.background, padding: 20, gap: 16 },
    header: { flexDirection: "row", justifyContent: "space-between" },
    title: { color: native.label, fontSize: 22, fontWeight: "600" },
    input: {
      color: native.label,
      backgroundColor: native.fill,
      borderRadius: 10,
      padding: 14,
      fontSize: 17,
    },
    error: { color: tokens.destructive, fontSize: 14 },
  });
}
