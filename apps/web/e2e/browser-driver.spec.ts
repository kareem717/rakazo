import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("the deployment owner can choose the browser driver in computer settings", async ({
  page,
}, testInfo) => {
  let driver = "cdp";
  const settings = () => ({
    browserDriver: driver,
    ownerUserId: "owner",
    signupsEnabled: true,
    signupAllowlist: [],
    hasDeploymentModelCredential: false,
    defaultProvider: null,
    defaultModel: null,
    computerHost: null,
    canChooseHostComputer: false,
    sandboxProvider: "box",
  });
  await page.route("**/rpc/bootstrap", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (body.json?.me) body.json.me.isDeploymentOwner = true;
    await route.fulfill({ response, json: body });
  });
  await page.route("**/rpc/deployment/get", (route) =>
    route.fulfill({ json: { json: settings() } }),
  );
  await page.route("**/rpc/deployment/update", async (route) => {
    driver = route.request().postDataJSON().json.browserDriver;
    await route.fulfill({ json: { json: settings() } });
  });
  await signup(page, `browser-driver-${Date.now()}@rakazo.test`, "password12", "Browser settings");
  await completeOnboarding(page);
  const panel = await openUserSettings(page, "computer");
  const select = panel.getByLabel("Browser driver", { exact: true });
  await expect(select).toBeEnabled();
  await select.selectOption("patchright");
  await expect(select).toHaveValue("patchright");
  await expect(select).toBeEnabled();
  await captureScreenshot(page, testInfo, "browser-driver-patchright");
});
