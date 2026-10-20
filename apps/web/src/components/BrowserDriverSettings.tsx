import { Trans, useLingui } from "@lingui/react/macro";
import type { BrowserDriver } from "@rakazo/contracts";
import { Field, FieldLabel, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

export function BrowserDriverSettings() {
  const { t } = useLingui();
  const [driver, setDriver] = useState<BrowserDriver | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    rpc.deployment.get().then(
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

  async function choose(browserDriver: BrowserDriver) {
    setPending(true);
    setError(null);
    try {
      const settings = await rpc.deployment.update({ browserDriver });
      setDriver(settings.browserDriver);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <Field className="mt-4" data-testid="browser-driver-settings">
      <FieldLabel htmlFor="browser-driver">
        <Trans>Browser driver</Trans>
      </FieldLabel>
      <NativeSelect
        id="browser-driver"
        aria-label={t`Browser driver`}
        value={driver ?? "cdp"}
        disabled={driver === null || pending}
        onChange={(event) => void choose(event.target.value as BrowserDriver)}
      >
        <NativeSelectOption value="cdp">
          <Trans>Standard</Trans>
        </NativeSelectOption>
        <NativeSelectOption value="patchright">Patchright</NativeSelectOption>
      </NativeSelect>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </Field>
  );
}
