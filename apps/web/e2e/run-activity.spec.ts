import { expect, test } from "@playwright/test";
import type { RunDetails } from "@rakazo/contracts";
import { activeBotId, captureScreenshot, completeOnboarding, signup } from "./helpers";

test("run activity shows tools and startup retries independently of chat visibility", async ({
  page,
}, testInfo) => {
  await signup(page, `run-activity-${Date.now()}@rakazo.test`, "password12", "Run Test");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  const at = "2026-01-02T12:00:00.000Z";
  const details: RunDetails = {
    run: {
      runId: "test-run",
      botId,
      botName: "Chief",
      groupId: null,
      groupName: null,
      threadId: "test-thread",
      status: "queued",
      trigger: "routine",
      notificationsEnabled: false,
      promptSnippet: "Check files",
      updatedAt: at,
      retry: { attempt: 2, maxAttempts: 3, at, error: "Computer unavailable" },
    },
    routineName: "Daily file check",
    error: "Computer unavailable",
    messageId: null,
    attempts: [
      {
        number: 1,
        status: "setup_failed",
        error: "Computer unavailable",
        startedAt: at,
        finishedAt: at,
      },
    ],
    tools: [
      {
        id: "tool-1",
        name: "list_files",
        status: "failed",
        error: "Computer unavailable",
        startedAt: at,
        completedAt: at,
      },
    ],
  };
  await page.route("**/rpc/runs/get", (route) => route.fulfill({ json: { json: details } }));
  await page.goto("/app/runs/test-run");
  const view = page.getByTestId("run-details");
  await expect(view.getByRole("heading", { name: "Daily file check" })).toBeVisible();
  await expect(view.getByRole("status")).toHaveText("Retrying 2/3…");
  await expect(view.getByTestId("run-tool-step")).toContainText("List files");
  await expect(view.getByTestId("run-tool-step")).toContainText("Failed");
  await view.locator("summary").filter({ hasText: "Attempts" }).click();
  await captureScreenshot(page, testInfo, "run-activity-startup-retry");
  details.run.status = "waiting_input";
  details.run.retry = null;
  details.error = null;
  details.tools.push({
    id: "tool-2",
    name: "read_file",
    status: "succeeded",
    error: null,
    startedAt: at,
    completedAt: at,
  });
  await expect(view.getByRole("status")).toHaveText("Needs input");
  await expect(view.getByTestId("run-tool-step")).toHaveCount(2);
  await captureScreenshot(page, testInfo, "run-activity-needs-input");
  details.run.status = "failed";
  details.error = "Could not start after 3 attempts. Computer unavailable";
  details.attempts = [1, 2, 3].map((number) => ({
    number,
    status: "setup_failed",
    error: "Computer unavailable",
    startedAt: at,
    finishedAt: at,
  }));
  await expect(view.getByRole("status")).toHaveText("Failed");
  await expect(view.getByText(/Retry at/)).toBeHidden();
  await expect(view.getByText("Could not start after 3 attempts.", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "run-activity-retry-limit");
});
