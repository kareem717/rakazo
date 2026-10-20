import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ScreenFrame } from "../../src/components/computer/ScreenFrame";
import "../../src/styles.css";

function Fixture() {
  const [url, setUrl] = useState("/novnc/session/view/1.expired/vnc.html");
  const [control, setControl] = useState(false);
  return (
    <main className="flex h-screen flex-col bg-background p-4 text-foreground">
      <button
        type="button"
        onClick={() => {
          setControl(!control);
          setUrl(
            control
              ? "/novnc/session/control/1.released/vnc.html"
              : `/novnc/session/control/${Date.now() + 3_600_000}.fixture/vnc.html`,
          );
        }}
      >
        {control ? "Release control" : "Take control"}
      </button>
      <ScreenFrame
        title="Recovery fixture"
        className="h-full w-full border-0"
        src={url}
        sandbox="allow-scripts"
        onReconnect={async () => {
          const response = await fetch("/screen-recovery-url");
          if (!response.ok) throw Error("offline");
          const { url: next } = await response.json();
          setUrl(next);
          return next;
        }}
      />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
