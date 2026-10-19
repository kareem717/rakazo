import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, createNamedBot, rpc, signup } from "./helpers";

// Fake values only: this spec proves the UI and API never echo a saved credential.
const SENTINEL = "fake-bot-credential-values-never-leak";
const REPLACEMENT = "fake-bot-credential-value-two";
const CREDENTIAL_NAME = "example_api";

test("bot credentials list, add, replace and remove without leaking values", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `bot-credentials-${stamp}@rakazo.test`, "password12", "Bot Credentials");
  await completeOnboarding(page);
  const botName = `Credentials ${stamp}`;
  const botId = await createNamedBot(page, botName);

  await page.locator("main").getByRole("button", { name: botName, exact: true }).click();
  const settings = page.getByTestId("bot-settings");
  await expect(settings).toBeVisible();
  // The Advanced <details> mounts the Credentials section on first open, not on render.
  await settings.getByTestId("bot-settings-advanced").evaluate((element) => {
    (element as HTMLDetailsElement).open = true;
  });
  const credentials = settings.getByTestId("bot-credentials");
  await expect(credentials).toBeVisible();
  await expect(credentials.getByTestId("bot-credentials-empty")).toBeVisible();

  // Add: a password field holds the value, which is cleared once the save starts.
  await credentials.getByTestId("credential-add").click();
  const addForm = credentials.getByTestId("credential-add-form");
  await addForm.getByTestId("credential-name").fill(CREDENTIAL_NAME);
  await addForm.getByTestId("credential-origin").fill("https://api.example.test");
  const valueInput = addForm.getByTestId("credential-value");
  await expect(valueInput).toHaveAttribute("type", "password");
  await expect(valueInput).toHaveAttribute("autocomplete", "new-password");
  await valueInput.fill(SENTINEL);
  await captureScreenshot(page, testInfo, "bot-credentials-add");
  await addForm.getByTestId("credential-add-save").click();

  const row = credentials.getByTestId("bot-credential-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(CREDENTIAL_NAME);
  await expect(row).toContainText("https://api.example.test");
  await expect(row).toContainText("Bearer token");
  await expect(addForm).toHaveCount(0);

  // The API returns metadata only, and no input still holds the value.
  const listed = await rpc<Array<Record<string, unknown>>>(page, "botSecrets/list", { botId });
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({
    name: CREDENTIAL_NAME,
    origin: "https://api.example.test",
    auth: { type: "bearer" },
  });
  expect(JSON.stringify(listed)).not.toContain(SENTINEL);
  expect(JSON.stringify(listed)).not.toContain("ciphertext");
  await expectNoLeakedInputValue(page, SENTINEL);

  // Replace: keeps the destination, writes a new value, leaves the old one gone.
  const replaced = page.waitForResponse(
    (response) => response.url().includes("/rpc/botSecrets/put") && response.ok(),
  );
  await credentials.getByTestId(`credential-replace-${CREDENTIAL_NAME}`).click();
  await credentials.getByTestId("credential-replace-value").fill(REPLACEMENT);
  await credentials.getByTestId("credential-replace-save").click();
  await replaced;
  await expect(row).toHaveCount(1);
  await expect(credentials.getByTestId("credential-replace-value")).toHaveCount(0);
  await expectNoLeakedInputValue(page, SENTINEL);
  await expectNoLeakedInputValue(page, REPLACEMENT);
  await captureScreenshot(page, testInfo, "bot-credentials-replace");

  // Remove: needs an explicit confirm, then the empty state returns.
  await credentials.getByTestId(`credential-remove-${CREDENTIAL_NAME}`).click();
  await expect(credentials).toContainText(`Remove ${CREDENTIAL_NAME}?`);
  const removed = page.waitForResponse(
    (response) => response.url().includes("/rpc/botSecrets/remove") && response.ok(),
  );
  await credentials.getByTestId(`credential-remove-confirm-${CREDENTIAL_NAME}`).click();
  await removed;
  await expect(row).toHaveCount(0);
  await expect(credentials.getByTestId("bot-credentials-empty")).toBeVisible();
  expect(await rpc<unknown[]>(page, "botSecrets/list", { botId })).toHaveLength(0);
  await captureScreenshot(page, testInfo, "bot-credentials-removed");
});

/** Fail if any live input value still carries a protected value. */
async function expectNoLeakedInputValue(page: Page, value: string) {
  const leaked = await page.evaluate((needle) => {
    const inputs = Array.from(document.querySelectorAll("input, textarea"));
    return inputs.some((input) => {
      const field = input as HTMLInputElement | HTMLTextAreaElement;
      return field.value.includes(needle);
    });
  }, value);
  expect(leaked).toBe(false);
}

test("named accounts on one site support an optional MFA setup key", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `login-accounts-${stamp}@rakazo.test`, "password12", "Login accounts");
  await completeOnboarding(page);
  const botName = `Login accounts ${stamp}`;
  const botId = await createNamedBot(page, botName);
  await page.locator("main").getByRole("button", { name: botName, exact: true }).click();
  const settings = page.getByTestId("bot-settings");
  await settings.getByTestId("bot-settings-advanced").evaluate((element) => {
    (element as HTMLDetailsElement).open = true;
  });
  const credentials = settings.getByTestId("bot-credentials");
  for (const name of ["work", "personal"]) {
    await credentials.getByTestId("credential-add").click();
    const form = credentials.getByTestId("credential-add-form");
    await form.getByTestId("credential-name").fill(`portal-${name}`);
    await form.getByTestId("credential-origin").fill("https://portal.example.test");
    await form.getByTestId("credential-auth-type").selectOption("login");
    await form.getByLabel("Account label (optional)").fill(name);
    await form.getByTestId("credential-email").fill(`${name}@example.test`);
    await form.getByTestId("credential-value").fill(SENTINEL);
    await expect(form.getByTestId("credential-mfa")).toHaveAttribute("type", "password");
    if (name === "work") await form.getByTestId("credential-mfa").fill("JBSWY3DPEHPK3PXP");
    await form.getByTestId("credential-add-save").click();
    await expect(form).toHaveCount(0);
  }
  const rows = credentials.getByTestId("bot-credential-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "portal-work" })).toContainText("MFA");
  await expect(rows.filter({ hasText: "portal-personal" })).not.toContainText("MFA");
  const listed = await rpc<Array<Record<string, unknown>>>(page, "botSecrets/list", { botId });
  expect(listed).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "portal-work",
        auth: { type: "login", label: "work", hasMfa: true },
      }),
      expect.objectContaining({
        name: "portal-personal",
        auth: { type: "login", label: "personal" },
      }),
    ]),
  );
  for (const protectedValue of [SENTINEL, "JBSWY3DPEHPK3PXP", "work@example.test"]) {
    expect(JSON.stringify(listed)).not.toContain(protectedValue);
    await expectNoLeakedInputValue(page, protectedValue);
  }
  await captureScreenshot(page, testInfo, "bot-credentials-multiple-accounts-mfa");
});
