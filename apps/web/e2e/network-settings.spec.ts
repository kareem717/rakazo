import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("owner configures network scope with transport fields and pending restart", async ({
  page,
}, testInfo) => {
  for (const procedure of ["me", "bootstrap"]) {
    await page.route(`**/rpc/${procedure}`, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const me = procedure === "me" ? body.json : body.json?.me;
      if (me) me.isDeploymentOwner = true;
      await route.fulfill({ response, json: body });
    });
  }
  let current = {
    version: 1,
    mode: "tools",
    transport: { type: "ssh", target: "proxy@egress.example.test", tailscale: true },
  };
  let saved: unknown = current;
  let revision = "0".repeat(64);
  let applyState = {
    available: true,
    phase: "idle",
    operationId: null as string | null,
    revision: null as string | null,
    error: null,
  };
  await page.route("**/rpc/network/applyPreview", (route) =>
    route.fulfill({ json: { json: { computers: [{ id: "example", name: "Example computer" }] } } }),
  );
  await page.route("**/rpc/network/applyStatus", (route) =>
    route.fulfill({ json: { json: applyState } }),
  );
  await page.route("**/rpc/network/apply", async (route) => {
    expect(route.request().postDataJSON().json.revision).toBe(revision);
    expect(route.request().postDataJSON().json.stopComputers).toBe(true);
    current = saved as typeof current;
    applyState = { ...applyState, phase: "succeeded", operationId: "operation", revision };
    await route.fulfill({ json: { json: { ...applyState, phase: "checking" } } });
  });
  const state = () => ({
    available: true,
    writable: true,
    active: current,
    saved,
    revision,
    restartRequired: JSON.stringify(saved) !== JSON.stringify(current),
  });
  let connection = {
    available: true,
    provider: "tailscale",
    state: "needs-login",
    tailnet: null as string | null,
    authUrl: null as string | null,
    exitNodes: [] as { name: string; value: string; online: boolean }[],
  };
  await page.route("**/rpc/network/connection", (route) =>
    route.fulfill({ json: { json: connection } }),
  );
  await page.route("**/rpc/network/connect", (route) => {
    connection = { ...connection, authUrl: "https://login.tailscale.com/a/abc123" };
    return route.fulfill({ json: { json: connection } });
  });
  await page.route("**/rpc/network/get", (route) => route.fulfill({ json: { json: state() } }));
  await page.route("**/rpc/network/save", async (route) => {
    const input = route.request().postDataJSON().json;
    expect(input.revision).toBe(revision);
    saved = input.config;
    revision = "1".repeat(64);
    await route.fulfill({ json: { json: state() } });
  });
  await signup(page, `network-${Date.now()}@rakazo.test`, "password12", "Network settings");
  await completeOnboarding(page);
  const settings = await openUserSettings(page);
  await settings.getByTestId("advanced-settings").locator("summary").first().click();
  await settings
    .locator("summary")
    .filter({ hasText: /^Network$/ })
    .click();
  const form = settings.getByTestId("network-settings");
  await form.getByRole("button", { name: "Connect Tailscale", exact: true }).click();
  await expect(form.getByRole("link", { name: "Continue in Tailscale" })).toHaveAttribute(
    "href",
    "https://login.tailscale.com/a/abc123",
  );
  await captureScreenshot(page, testInfo, "network-settings-authorization");
  connection = {
    ...connection,
    state: "connected",
    tailnet: "example.test",
    authUrl: null,
    exitNodes: [{ name: "exit.example.ts.net", value: "exit.example.ts.net", online: true }],
  };
  await form.getByRole("button", { name: "Refresh connection" }).click();
  await expect(form.getByTestId("network-connection")).toContainText("example.test");
  await expect(form.getByLabel("SSH target", { exact: true })).toHaveValue(
    "proxy@egress.example.test",
  );
  await captureScreenshot(page, testInfo, "network-settings-ssh");
  await form.getByLabel("Connection", { exact: true }).selectOption("socks5");
  await expect(form.getByLabel("SSH target", { exact: true })).toHaveCount(0);
  await expect(form.getByLabel("SOCKS URL", { exact: true })).toBeVisible();
  await form.getByLabel("Routing", { exact: true }).selectOption("all");
  await form.getByLabel("Tailscale exit node", { exact: true }).fill("exit.example.ts.net");
  await captureScreenshot(page, testInfo, "network-settings-exit-node");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(form.getByRole("status")).toContainText("Restart required");
  await captureScreenshot(page, testInfo, "network-settings-restart-required");
  await expect(form.getByRole("button", { name: "Apply and restart", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "network-settings-apply-button");
  await form.getByRole("button", { name: "Apply and restart", exact: true }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Example computer");
  await captureScreenshot(page, testInfo, "network-settings-confirm-drain");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await form.getByRole("button", { name: "Apply and restart", exact: true }).click();
  await dialog.getByRole("button", { name: "Apply and restart", exact: true }).click();
  await expect(form).not.toContainText("Restart required");
  await form.getByLabel("Routing", { exact: true }).selectOption("direct");
  await expect(form.getByLabel("Tailscale exit node", { exact: true })).toHaveCount(0);
});
