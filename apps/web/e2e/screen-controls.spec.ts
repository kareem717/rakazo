import { expect, test } from "@playwright/test";
import { injectScreenViewerBridge } from "../src/screen-viewer-bridge";
import { captureScreenshot } from "./helpers";

test.beforeEach(async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.route("**/novnc/session/**", (route) => {
    if (route.request().url().includes("/app/ui.js"))
      return route.fulfill({
        contentType: "text/javascript",
        headers: { "access-control-allow-origin": "*" },
        body: `class Viewer extends EventTarget {
        viewOnly = new URLSearchParams(location.search).get("view_only")==="true";
        _rfbConnectionState="connected"; keys=[]; pasted=[];
        focus(){document.getElementById("screen").focus()}
        clipboardPasteFrom(text){this.pasted.push(text)}
        sendKey(symbol,code,down){
          this.keys.push({symbol,code,down});
          if(code==="KeyX" && down===undefined)this.dispatchEvent(new CustomEvent("clipboard",{detail:{text:"Cut from computer"}}));
          if(code==="KeyC" && down===undefined)this.dispatchEvent(new CustomEvent("clipboard",{detail:{text:"Copied from computer"}}));
        }
      }; export default {rfb:new Viewer()};`,
      });
    return route.fulfill({
      contentType: "text/html",
      body: injectScreenViewerBridge(`<!doctype html><html><head><script type="module">
      import UI from "./app/ui.js"; window.fixtureViewer=UI.rfb;
      </script></head><body><div id="screen" tabindex="0">Remote desktop</div></body></html>`),
    });
  });
});

test("Mac shortcuts and explicit clipboard sync work through a sandboxed viewer", async ({
  page,
}, testInfo) => {
  await page.goto("/e2e/fixtures/screen-controls.html");
  await page.evaluate(() => navigator.clipboard.writeText("From device"));
  await page.getByRole("button", { name: "Clipboard", exact: true }).click();
  await page.getByRole("button", { name: "From device", exact: true }).click();
  const viewer = page.frameLocator('iframe[title="Controlled screen"]');
  await expect
    .poll(() => viewer.locator("body").evaluate(() => (window as any).fixtureViewer.pasted))
    .toEqual(["From device"]);
  await page.getByRole("button", { name: "Select all", exact: true }).click();
  await expect
    .poll(() =>
      viewer
        .locator("body")
        .evaluate(() => (window as any).fixtureViewer.keys.some((key: any) => key.code === "KeyA")),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Clipboard", exact: true }).click();
  await viewer.locator("#screen").click();
  await page.keyboard.press("Meta+x");
  await expect
    .poll(() =>
      viewer
        .locator("body")
        .evaluate(() => (window as any).fixtureViewer.keys.some((key: any) => key.code === "KeyX")),
    )
    .toBe(true);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("From device");
  await page.getByRole("button", { name: "Clipboard", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Clipboard text" })).toHaveValue(
    "Cut from computer",
  );
  await page.getByRole("switch", { name: "Sync clipboard" }).click();
  await page.getByRole("button", { name: "Clipboard", exact: true }).click();
  await viewer.locator("#screen").click();
  await page.keyboard.press("Meta+c");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("Copied from computer");
  await page.getByRole("button", { name: "Clipboard", exact: true }).click();
  await captureScreenshot(page, testInfo, "computer-clipboard-controls");
  await page.getByRole("button", { name: "Clipboard", exact: true }).click();
  await page.getByRole("button", { name: "Release control", exact: true }).click();
  await expect(page.getByRole("button", { name: "Clipboard", exact: true })).toHaveCount(0);
});

test("clipboard permission denial keeps manual paste available", async ({ page }) => {
  await page.addInitScript(() => {
    if (window.top === window)
      Object.defineProperty(navigator, "clipboard", {
        value: {
          readText: async () => {
            throw Error("denied");
          },
          writeText: async () => {
            throw Error("denied");
          },
        },
      });
  });
  await page.goto("/e2e/fixtures/screen-controls.html");
  await page.getByRole("button", { name: "Clipboard", exact: true }).click();
  await page.getByRole("button", { name: "From device", exact: true }).click();
  await expect(page.getByText("Use the text field to copy or paste.")).toBeVisible();
  await page.getByRole("textbox", { name: "Clipboard text" }).fill("Manual paste 🌍");
  await page.getByRole("button", { name: "Paste", exact: true }).click();
  const viewer = page.frameLocator('iframe[title="Controlled screen"]');
  await expect
    .poll(() => viewer.locator("body").evaluate(() => (window as any).fixtureViewer.pasted))
    .toEqual(["Manual paste 🌍"]);
});
