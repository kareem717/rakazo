// @vitest-environment jsdom
import type { NetworkSettings } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn() }));
vi.mock("../lib/rpc", () => ({ rpc: { network: calls } }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { NetworkSettingsForm } from "./NetworkSettings";

const initial: NetworkSettings = {
  available: true,
  writable: true,
  active: {
    version: 1,
    mode: "tools",
    transport: { type: "ssh", target: "proxy@egress.example.test", tailscale: true },
  },
  saved: {
    version: 1,
    mode: "tools",
    transport: { type: "ssh", target: "proxy@egress.example.test", tailscale: true },
  },
  revision: "0".repeat(64),
  restartRequired: false,
};
afterEach(() => vi.clearAllMocks());
async function render(state: NetworkSettings = initial) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  calls.get.mockResolvedValue(state);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<NetworkSettingsForm />);
  });
  return {
    container,
    close: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}
function select(container: HTMLElement, label: string, value: string) {
  const field = Array.from(container.querySelectorAll("label")).find(
    (node) => node.textContent === label,
  );
  const control = container.querySelector<HTMLSelectElement>(`[id="${field?.htmlFor}"]`)!;
  control.value = value;
  control.dispatchEvent(new Event("change", { bubbles: true }));
}
it("saves the chosen scope and reports a pending restart", async () => {
  calls.save.mockResolvedValue({
    ...initial,
    saved: { version: 1, mode: "direct" },
    restartRequired: true,
    revision: "1".repeat(64),
  });
  const { container, close } = await render();
  try {
    expect(container.querySelector("input")?.value).toBe("proxy@egress.example.test");
    await act(async () => select(container, "Routing", "direct"));
    expect(container.querySelectorAll("input")).toHaveLength(0);
    await act(async () =>
      Array.from(container.querySelectorAll("button"))
        .find((node) => node.textContent === "Save")!
        .click(),
    );
    expect(calls.save).toHaveBeenCalledWith({
      config: { version: 1, mode: "direct" },
      revision: "0".repeat(64),
    });
    expect(container.textContent).toContain("Restart required");
    expect(container.textContent).toContain("Stop computers and restart the deployment to apply.");
  } finally {
    await close();
  }
});
it("shows only the fields required by the selected transport", async () => {
  const { container, close } = await render();
  try {
    await act(async () => select(container, "Connection", "socks5"));
    expect(container.textContent).toContain("SOCKS URL");
    expect(container.textContent).not.toContain("SSH target");
    expect(container.textContent).not.toContain("Use Tailscale");
    await act(async () => select(container, "Routing", "all"));
    expect(container.textContent).toContain("Tailscale exit node");
    expect(container.querySelector("button")?.disabled).toBe(true);
  } finally {
    await close();
  }
});
it("keeps server-managed deployments read only", async () => {
  const { container, close } = await render({ ...initial, writable: false });
  try {
    expect(container.textContent).toContain("Network settings are managed on the server.");
    expect(container.querySelector<HTMLSelectElement>("select")?.disabled).toBe(true);
    expect(
      Array.from(container.querySelectorAll("button")).some((node) => node.textContent === "Save"),
    ).toBe(false);
  } finally {
    await close();
  }
});
