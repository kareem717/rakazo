import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("sections contain subsections that collapse, move and survive parent deletion", async ({
  page,
}, testInfo) => {
  await signup(page, `nested-sections-${Date.now()}@rakazo.test`, "password12", "Test User");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  const sidebar = page.locator("aside").first();
  const bot = sidebar.getByRole("button", { name: /^Chief/ });
  await bot.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to", exact: true }).hover();
  await page.getByRole("menuitem", { name: "New section", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "New section" });
  await dialog.getByLabel("Name", { exact: true }).fill("Projects");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  const parentToggle = sidebar.getByRole("button", { name: "Collapse Projects", exact: true });
  await parentToggle.click({ button: "right" });
  await page.getByRole("menuitem", { name: "New subsection", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "New section" });
  await dialog.getByLabel("Name", { exact: true }).fill("Inbox");
  await expect(dialog.getByLabel("Parent section")).not.toHaveValue("");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  const childToggle = sidebar.getByRole("button", { name: "Collapse Inbox", exact: true });
  await expect(childToggle).toBeVisible();
  await bot.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to", exact: true }).hover();
  await page.getByRole("menuitem", { name: "Projects / Inbox", exact: true }).click();
  const childGroup = sidebar
    .locator("[data-sidebar-group]")
    .filter({ has: page.getByRole("button", { name: "Collapse Inbox", exact: true }) });
  await expect(childGroup).toContainText("Chief");
  const parentBox = await parentToggle.boundingBox();
  const childBox = await childToggle.boundingBox();
  expect(childBox!.x).toBeGreaterThan(parentBox!.x);
  await captureScreenshot(page, testInfo, "nested-sections-expanded");

  await parentToggle.click();
  await expect(childToggle).toHaveCount(0);
  await expect(bot).toHaveCount(0);
  await page.reload();
  await expect(sidebar.getByRole("button", { name: "Expand Projects", exact: true })).toBeVisible();
  await expect(childToggle).toHaveCount(0);
  await sidebar.getByRole("button", { name: "Expand Projects", exact: true }).click();
  await expect(childToggle).toBeVisible();

  // Move an existing section with its chat, then put it back under the parent.
  await childToggle.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to", exact: true }).hover();
  await page.getByRole("menuitem", { name: "None", exact: true }).click();
  const sections = await rpc<Array<{ id: string; name: string; parentId: string | null }>>(
    page,
    "botSections/list",
    {},
  );
  const child = sections.find((section) => section.name === "Inbox")!;
  const parent = sections.find((section) => section.name === "Projects")!;
  expect(child.parentId).toBeNull();
  const botAfterMove = await rpc<{ sectionId: string }>(page, "bots/get", { botId });
  expect(botAfterMove.sectionId).toBe(child.id);
  await childToggle.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to", exact: true }).hover();
  await page.getByRole("menuitem", { name: "Projects", exact: true }).click();
  await expect
    .poll(
      async () =>
        (
          await rpc<Array<{ id: string; parentId: string | null }>>(page, "botSections/list", {})
        ).find((section) => section.id === child.id)?.parentId,
    )
    .toBe(parent.id);

  await parentToggle.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete section", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(parentToggle).toHaveCount(0);
  await expect(childToggle).toBeVisible();
  await expect(childGroup).toContainText("Chief");
  await page.reload();
  await expect(childToggle).toBeVisible();
  await expect(childGroup).toContainText("Chief");
  await captureScreenshot(page, testInfo, "nested-section-promoted");
});

test("space menus create sections and section buttons support drag and drop", async ({
  page,
}, testInfo) => {
  await signup(page, `section-controls-${Date.now()}@rakazo.test`, "password12", "Test User");
  await completeOnboarding(page);
  await rpc(page, "spaces/create", { name: "Sales" });
  await page.reload();
  const sidebar = page.locator("aside").first();
  await sidebar.getByRole("button", { name: "Actions for Sales", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Rename space", exact: true })).toBeVisible();
  await page.getByRole("menuitem", { name: "New section", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "New section" });
  await dialog.getByLabel("Name", { exact: true }).fill("Pipeline");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await sidebar.getByRole("button", { name: "Actions for Pipeline", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Move to", exact: true })).toBeVisible();
  await page.getByRole("menuitem", { name: "New subsection", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "New section" });
  await dialog.getByLabel("Name", { exact: true }).fill("Inbound");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  const inbound = sidebar.getByRole("button", { name: "Collapse Inbound", exact: true });
  const pipeline = sidebar.getByRole("button", { name: "Collapse Pipeline", exact: true });
  // Drag a subsection back to its space, then nest it by dragging onto another section.
  const sales = sidebar.getByRole("button", { name: "Open Sales", exact: true });
  await inbound.dragTo(sales);
  await expect
    .poll(async () => {
      const nav = await rpc<{
        spaces: Array<{
          name: string;
          botSections: Array<{ name: string; parentId: string | null }>;
        }>;
      }>(page, "spaces/list", {});
      return nav.spaces
        .find((space) => space.name === "Sales")
        ?.botSections.find((section) => section.name === "Inbound")?.parentId;
    })
    .toBeNull();
  await inbound.dragTo(pipeline);
  await expect
    .poll(async () => {
      const nav = await rpc<{
        spaces: Array<{
          name: string;
          botSections: Array<{ id: string; name: string; parentId: string | null }>;
        }>;
      }>(page, "spaces/list", {});
      const sections = nav.spaces.find((space) => space.name === "Sales")!.botSections;
      return (
        sections.find((section) => section.name === "Inbound")?.parentId ===
        sections.find((section) => section.name === "Pipeline")?.id
      );
    })
    .toBe(true);
  await expect(
    sidebar.getByRole("button", { name: "Actions for Pipeline", exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const childBox = await inbound.boundingBox();
      const parentBox = await pipeline.boundingBox();
      return childBox && parentBox ? childBox.x > parentBox.x : false;
    })
    .toBe(true);
  await captureScreenshot(page, testInfo, "space-and-section-controls");
});
