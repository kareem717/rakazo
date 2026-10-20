// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { VoicePicker } from "./VoicePicker";

const voices = vi.hoisted(() => vi.fn());
vi.mock("../lib/space-rpc", () => {
  const client = { voice: { voices } };
  return { useSpaceRpc: () => client };
});
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
}));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  voices.mockReset();
});

it("resolves pasted links without replacing the saved voice until selected", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  voices.mockImplementation(async ({ query }) =>
    query ? [{ id: "found", label: "Found voice" }] : [{ id: "other", label: "Other" }],
  );
  const container = document.createElement("div");
  const root = createRoot(container);
  const change = vi.fn();
  try {
    await act(async () =>
      root.render(<VoicePicker provider="provider" value="saved" onChange={change} />),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(container.querySelector("select")?.value).toBe("saved");
    const input = container.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "https://example.test/voice",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(voices).toHaveBeenLastCalledWith({
      provider: "provider",
      query: "https://example.test/voice",
    });
    expect(container.textContent).toContain("Found voice");
    expect(container.querySelector("select")?.value).toBe("saved");
    expect(change).not.toHaveBeenCalled();
    await act(async () => {
      container.querySelector("select")!.value = "found";
      container.querySelector("select")!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(change).toHaveBeenCalledWith("found");
  } finally {
    await act(async () => root.unmount());
  }
});

it("ignores results from the previous provider and keeps saved choices on errors", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let finish!: (value: unknown) => void;
  voices.mockImplementation(({ provider }) =>
    provider === "old"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.reject(new Error("Unavailable")),
  );
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(<VoicePicker provider="old" value="saved" onChange={() => undefined} />),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () =>
      root.render(<VoicePicker provider="new" value="saved" onChange={() => undefined} />),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      finish([{ id: "stale", label: "Old provider" }]);
    });
    expect(container.textContent).not.toContain("Old provider");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Unavailable");
    expect(container.querySelector("select")?.value).toBe("saved");
  } finally {
    await act(async () => root.unmount());
  }
});
