import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("live call settings are optional and keep advanced choices after reload", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 960 });
  let settings = {
    provider: null as string | null,
    modelId: "",
    speechModel: "",
    transcriptionModel: "",
    language: "en",
    maxDurationSeconds: 1800,
  };
  const defaults = {
    ...settings,
    provider: "fish-audio",
    modelId: "openai/gpt-5.6-luna",
    speechModel: "drama-3",
    transcriptionModel: "deepgram:nova-3",
  };
  await page.route("**/rpc/voice/callSettings", (route) =>
    route.fulfill({ json: { json: settings } }),
  );
  await page.route("**/rpc/voice/callProviders", (route) =>
    route.fulfill({
      json: { json: [{ id: "fish-audio", name: "Fish Agents", connected: true, defaults }] },
    }),
  );
  await page.route("**/rpc/voice/setCallSettings", async (route) => {
    settings = route.request().postDataJSON().json;
    await route.fulfill({ json: { json: settings } });
  });
  await signup(page, `live-settings-${Date.now()}@rakazo.test`, "password12", "Voice tester");
  await completeOnboarding(page);
  await openUserSettings(page, "voice");
  await expect(
    page.getByRole("button", { name: "Fish Audio Speak + transcribe", exact: true }),
  ).toBeVisible();
  const calls = page.getByRole("combobox", { name: "Calls", exact: true });
  await expect(calls).toHaveValue("");
  await calls.selectOption("fish-audio");
  await page.getByRole("button", { name: "Advanced", exact: true }).click();
  await page.getByRole("spinbutton", { name: "Call limit (minutes)", exact: true }).fill("10");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "live-call-settings");
  await page.reload();
  await openUserSettings(page, "voice");
  await expect(calls).toHaveValue("fish-audio");
  await page.getByRole("button", { name: "Advanced", exact: true }).click();
  await expect(
    page.getByRole("spinbutton", { name: "Call limit (minutes)", exact: true }),
  ).toHaveValue("10");
  await calls.selectOption("");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(calls).toHaveValue("");
});
