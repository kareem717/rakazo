// @vitest-environment jsdom

import { LiveCallSettingsSchema } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LiveCallSettings } from "./LiveCallSettings";

const voice = vi.hoisted(() => ({
  callSettings: vi.fn(),
  callProviders: vi.fn(),
  setCallSettings: vi.fn(),
}));
const rpc = { voice };
vi.mock("../lib/space-rpc", () => ({ useSpaceRpc: () => rpc }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
  Field: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  FieldLabel: ({ htmlFor, children, ...props }: ComponentProps<"label">) => (
    <label htmlFor={htmlFor} {...props}>
      {children}
    </label>
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
}));
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
const defaults = LiveCallSettingsSchema.parse({
  provider: "fish-audio",
  modelId: "example/model",
  speechModel: "example-speech",
  transcriptionModel: "example-asr",
});
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  voice.callSettings.mockResolvedValue(LiveCallSettingsSchema.parse({}));
  voice.callProviders.mockResolvedValue([
    { id: "fish-audio", name: "Fish Agents", connected: true, defaults },
  ]);
  voice.setCallSettings.mockImplementation(async (s) => s);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});
async function render() {
  await act(async () => {
    root.render(<LiveCallSettings />);
  });
}
async function choose(value: string) {
  await act(async () => {
    const select = container.querySelector("select")!;
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
function button(text: string) {
  const b = [...container.querySelectorAll("button")].find((b) => b.textContent === text);
  if (!b) throw new Error(`Missing ${text}`);
  return b;
}
it("keeps live calls optional and saves the provider's editable defaults", async () => {
  await render();
  expect(container.querySelector("select")?.value).toBe("");
  expect(container.querySelectorAll("input")).toHaveLength(0);
  await choose("fish-audio");
  expect(voice.setCallSettings).not.toHaveBeenCalled();
  await act(async () => button("Advanced").click());
  expect([...container.querySelectorAll("input")].map((i) => i.value)).toEqual([
    "example/model",
    "example-speech",
    "example-asr",
    "en",
    "30",
  ]);
  await act(async () => button("Save").click());
  expect(voice.setCallSettings).toHaveBeenCalledWith(defaults);
  await choose("");
  await act(async () => button("Save").click());
  expect(voice.setCallSettings).toHaveBeenLastCalledWith({ ...defaults, provider: null });
});
it("requires the provider connection before enabling its live calls", async () => {
  voice.callProviders.mockResolvedValue([
    { id: "fish-audio", name: "Fish Agents", connected: false, defaults },
  ]);
  await render();
  expect(container.querySelector<HTMLOptionElement>('option[value="fish-audio"]')?.disabled).toBe(
    true,
  );
});
it("keeps failed settings unsaved and presents the server error", async () => {
  await render();
  await choose("fish-audio");
  voice.setCallSettings.mockRejectedValueOnce(new Error("Connection unavailable"));
  await act(async () => button("Save").click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Connection unavailable");
  expect(button("Save").disabled).toBe(false);
});
