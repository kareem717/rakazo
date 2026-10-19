// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _v,
    size: _s,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
}));

import { AskCard } from "./AskCard";

it("submits an email-only MFA login and clears protected inputs even on failure", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onAnswer = vi.fn().mockRejectedValue(new Error("fake-password-must-not-leak"));
  try {
    await act(async () =>
      root.render(
        <AskCard
          block={{
            kind: "ask",
            text: "Sign in",
            input: "secret",
            purpose: "password",
            status: "pending",
            credential: {
              name: "portal-work",
              origin: "https://portal.example.test",
              auth: { type: "login" },
            },
          }}
          canAnswer
          onAnswer={onAnswer}
        />,
      ),
    );
    async function type(label: string, value: string) {
      const field = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
      expect(field).not.toBeNull();
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          field,
          value,
        );
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    await type("Email (optional)", "fake-user@example.test");
    await type("MFA secret (optional)", "JBSWY3DPEHPK3PXP");
    await type("Password", "fake-password-must-not-leak");
    await act(async () =>
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(onAnswer).toHaveBeenCalledWith("fake-password-must-not-leak", undefined, {
      email: "fake-user@example.test",
      mfaSecret: "JBSWY3DPEHPK3PXP",
    });
    for (const input of container.querySelectorAll("input")) expect(input.value).toBe("");
    expect(container.textContent).not.toContain("fake-password-must-not-leak");
    expect(container.innerHTML).not.toContain("JBSWY3DPEHPK3PXP");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
