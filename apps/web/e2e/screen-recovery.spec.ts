import { expect, test } from "@playwright/test";
import { unavailableScreenHtml } from "../src/screen-viewer-bridge";
import { captureScreenshot } from "./helpers";

test("an expired viewer and a later disconnect recover without computer lifecycle actions", async ({
  page,
}, testInfo) => {
  let renewals = 0;
  await page.route("**/screen-recovery-url", (route) => {
    renewals++;
    return route.fulfill({
      json: { url: `/novnc/session/view/${Date.now() + 3_600_000}.fixture-${renewals}/vnc.html` },
    });
  });
  await page.route("**/novnc/session/**", (route) => {
    const expired = /\/1\.(?:expired|released)\//.test(route.request().url());
    return route.fulfill({
      status: expired ? 403 : 200,
      contentType: "text/html",
      body: expired
        ? unavailableScreenHtml()
        : `<!doctype html><html><body><p>Connected screen</p><script>
      function report(){parent.postMessage({source:"rakazo.screen",state:"connected"},"*");}
      addEventListener("message",event=>{if(event.data?.request==="status")report()});report();
      </script></body></html>`,
    });
  });
  await page.goto("/e2e/fixtures/screen-recovery.html");
  const viewer = page.frameLocator('iframe[title="Recovery fixture"]');
  await expect(viewer.getByText("Connected screen")).toBeVisible();
  expect(renewals).toBe(1);
  await page.getByRole("button", { name: "Take control", exact: true }).click();
  await expect(viewer.getByText("Connected screen")).toBeVisible();
  await page.getByRole("button", { name: "Release control", exact: true }).click();
  await expect.poll(() => renewals).toBe(2);
  await expect(viewer.getByText("Connected screen")).toBeVisible();
  await viewer
    .locator("body")
    .evaluate(() => parent.postMessage({ source: "rakazo.screen", state: "disconnected" }, "*"));
  await expect.poll(() => renewals).toBe(3);
  await expect(viewer.getByText("Connected screen")).toBeVisible();
  await captureScreenshot(page, testInfo, "screen-automatically-reconnected");
});
