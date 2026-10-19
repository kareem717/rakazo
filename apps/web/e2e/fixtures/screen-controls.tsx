import { I18nProvider } from "@lingui/react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ScreenFrame } from "../../src/components/computer/ScreenFrame";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import "../../src/styles.css";

function Fixture() {
  const [control, setControl] = useState(true);
  const mode = control ? "control" : "view";
  return (
    <I18nProvider i18n={i18n}>
      <main className="flex h-screen flex-col bg-background text-foreground">
        <button type="button" onClick={() => setControl(!control)}>
          {control ? "Release control" : "Take control"}
        </button>
        <ScreenFrame
          title="Controlled screen"
          interactive={control}
          src={`/novnc/session/${mode}/${Date.now() + 3_600_000}.fixture/vnc.html?view_only=${!control}`}
          sandbox="allow-scripts allow-pointer-lock"
          className="h-full w-full border-0"
          onReconnect={async () => true}
        />
      </main>
    </I18nProvider>
  );
}
await bootstrapI18n();
createRoot(document.getElementById("root")!).render(<Fixture />);
