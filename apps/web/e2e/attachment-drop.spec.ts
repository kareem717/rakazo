import type { Locator } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  rpc,
  signup,
} from "./helpers";

async function dragFiles(target: Locator, type: string, names = ["notes.txt", "photo.png"]) {
  await target.evaluate(
    (element, { type, names }) => {
      const dataTransfer = new DataTransfer();
      for (const name of names) {
        const image = name.endsWith(".png");
        const data = image
          ? Uint8Array.from(
              atob(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
              ),
              (c) => c.charCodeAt(0),
            )
          : "meeting notes";
        dataTransfer.items.add(
          new File([data], name, {
            type: image
              ? "image/png"
              : name.endsWith(".txt")
                ? "text/plain"
                : "application/octet-stream",
          }),
        );
      }
      element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
    },
    { type, names },
  );
}

for (const kind of ["bot", "group"] as const) {
  test(`drop attachments anywhere in a ${kind} chat and send them`, async ({ page }, testInfo) => {
    await signup(
      page,
      `attachment-drop-${kind}-${Date.now()}@rakazo.test`,
      "password12",
      "Drop Test",
    );
    await completeOnboarding(page);
    if (kind === "group") {
      const botId = activeBotId(page);
      const group = await rpc<{ id: string }>(page, "groups/create", {
        name: "Drop team",
        botIds: [botId, await createNamedBot(page, "Drop peer")],
      });
      await page.goto(`/app/g/${group.id}`);
    }
    const composer = page.getByRole("combobox", { name: /Message/ });
    await expect(composer).toBeVisible();
    await composer.fill("Please read these");
    const transcript = page.getByTestId("transcript");
    await dragFiles(transcript, "dragenter");
    await expect(page.getByText("Drop to attach", { exact: true })).toBeVisible();
    await captureScreenshot(page, testInfo, `attachment-drop-${kind}-target`);
    await dragFiles(transcript, "drop");
    await expect(page.getByText("Drop to attach", { exact: true })).toBeHidden();
    await expect(page.getByRole("button", { name: "Remove notes.txt" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove photo.png" })).toBeVisible();
    await expect(composer).toHaveValue("Please read these");
    await expect(composer).toBeFocused();
    // A second drop over the composer follows the same path, without duplicates.
    await dragFiles(composer, "drop", ["extra.txt"]);
    await expect(page.getByRole("button", { name: "Remove extra.txt" })).toHaveCount(1);
    await page.getByRole("button", { name: "Remove extra.txt" }).click();
    await dragFiles(transcript, "drop", ["unsupported.exe"]);
    await expect(page.getByText(/Skipped unsupported.exe/)).toBeVisible();
    await captureScreenshot(page, testInfo, `attachment-drop-${kind}-previews`);
    const sent = page.waitForRequest("**/rpc/threads/send");
    await composer.press("Enter");
    const request = await sent;
    const input = request.postDataJSON().json;
    expect(input.artifactIds).toHaveLength(2);
    await expect(transcript.getByText("Please read these", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove notes.txt" })).toBeHidden();
  });
}

test("files dropped during an earlier send remain queued for the next message", async ({
  page,
}) => {
  await signup(
    page,
    `attachment-drop-pending-${Date.now()}@rakazo.test`,
    "password12",
    "Drop Test",
  );
  await completeOnboarding(page);
  const composer = page.getByRole("combobox", { name: /Message/ });
  const transcript = page.getByTestId("transcript");
  await expect(composer).toBeVisible();
  await dragFiles(transcript, "drop", ["first.txt"]);
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/rpc/threads/send", async (route) => {
    await released;
    await route.continue();
  });
  await composer.fill("First message");
  const started = page.waitForRequest("**/rpc/threads/send");
  await composer.press("Enter");
  await started;
  await dragFiles(transcript, "drop", ["next.txt"]);
  await expect(page.getByRole("button", { name: "Remove next.txt" })).toBeVisible();
  release();
  await expect(page.getByRole("button", { name: "Remove first.txt" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Remove next.txt" })).toBeVisible();
  await page.unroute("**/rpc/threads/send");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "Remove next.txt" })).toBeHidden();
});
