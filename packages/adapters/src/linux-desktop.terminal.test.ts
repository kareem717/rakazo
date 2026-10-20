import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { ComputerScreenUnavailableError } from "./computer-screens.js";
import { LinuxDesktop } from "./linux-desktop.js";

const context: AdapterContext = {
  operationId: "test",
  traceId: "test",
  spaceId: "workspace-1",
  userId: "user-1",
  botId: "bot-1",
  screenLeaseId: "run-1:2",
  signal: new AbortController().signal,
};
const computer: ComputerRef = {
  id: "sandbox-1",
  providerRef: "sandbox-1",
  kind: "boat",
  botId: "bot-1",
};

function fixture(rejectControl = false) {
  let published = false;
  const run = vi.fn(async (_computer: ComputerRef, command: string) => {
    if (command.includes("RAKAZO_DESKTOP=")) {
      return { code: 0, stdout: "RAKAZO_DESKTOP=0:view-token\n" };
    }
    if (command.includes("MAX_FRAME =")) {
      return { code: published ? 0 : 75, stdout: "" };
    }
    if (rejectControl) return { code: 75, stdout: "" };
    published = true;
    return { code: 0, stdout: "" };
  });
  const screenUrl = vi.fn(async () => "https://screen.example/vnc.html");
  const desktop = new LinuxDesktop({
    environment: async () => ({
      homeDir: "/home/user",
      workspaceDir: "/home/user/work",
      browserProfilesDir: "/home/user/work/.browser-profiles",
      displayStart: 20,
    }),
    run,
    screenUrl,
  });
  return { desktop, run, screenUrl };
}

describe("LinuxDesktop.connectTerminal", () => {
  it("opens a shell before an interactive screen has published the control token", async () => {
    const { desktop, run } = fixture();
    const session = await desktop.connectTerminal(
      computer,
      { controlToken: "control-lease" },
      context,
    );
    expect(new URL(session.url).searchParams.get("path")).toMatch(
      /^websockify\?token=[0-9a-f-]{36}$/,
    );
    expect(run.mock.calls[1]?.[1]).toContain("control-lease");
    expect(run.mock.calls[1]?.[1]).toContain("run-1:2");
  });

  it("does not open a shell or publish a URL when the control fence rejects it", async () => {
    const { desktop, run, screenUrl } = fixture(true);
    await expect(
      desktop.connectTerminal(computer, { controlToken: "control-lease" }, context),
    ).rejects.toBeInstanceOf(ComputerScreenUnavailableError);
    expect(run).toHaveBeenCalledTimes(2);
    expect(screenUrl).not.toHaveBeenCalled();
  });
});
