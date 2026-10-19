import type { BrowserDriver } from "@rakazo/contracts";
import { useEffect, useState } from "react";
import { Text } from "react-native";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { errorText } from "../lib/user-error";
import { MenuPicker } from "./menu-picker";

export function BrowserDriverSettings() {
  const { t } = useI18n();
  const [driver, setDriver] = useState<BrowserDriver | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    rpc<{ browserDriver: BrowserDriver }>("deployment/get").then(
      (settings) => {
        if (!cancelled) setDriver(settings.browserDriver);
      },
      (cause: unknown) => {
        if (!cancelled) setError(errorText(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);
  async function choose(value: string) {
    if (pending || (value !== "cdp" && value !== "patchright")) return;
    setPending(true);
    setError(null);
    try {
      const settings = await rpc<{ browserDriver: BrowserDriver }>("deployment/update", {
        browserDriver: value,
      });
      setDriver(settings.browserDriver);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      {driver ? (
        <MenuPicker
          label={t("Browser driver")}
          value={driver}
          choices={[
            { key: "cdp", label: t("Standard") },
            { key: "patchright", label: "Patchright" },
          ]}
          onChange={(value) => void choose(value)}
        />
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={{ color: mobileTokens().destructive }}>
          {error}
        </Text>
      ) : null}
    </>
  );
}
