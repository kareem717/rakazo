import { describe, expect, it, vi } from "vitest";
import { activityNotificationsEnabled, activityPromptSnippet, getRunDetails } from "./runs.js";

describe("run activity copy", () => {
  it("presents structured agent messages instead of their internal wake prompt", () => {
    expect(
      activityPromptSnippet({
        trigger: "bot_message",
        prompt: "[bot] A message just arrived from another bot with internal routing data",
        sourceBlocks: [
          {
            kind: "bot_message_received",
            fromBotId: "maya",
            fromBotName: "Maya",
            text: "Please check the release workflow.",
            intent: "request",
          },
        ],
      }),
    ).toBe("Maya asked: Please check the release workflow.");
  });

  it("fails closed when an agent message has no valid structured source", () => {
    expect(
      activityPromptSnippet({
        trigger: "bot_message",
        prompt: "[bot] private internal routing envelope",
        sourceBlocks: [{ kind: "text", text: "not a peer message" }],
      }),
    ).toBe("Message from another agent");
  });
});

describe("run activity notification preference", () => {
  it("silences only direct messages", () => {
    expect(activityNotificationsEnabled(null, false)).toBe(false);
    expect(activityNotificationsEnabled("group-1", false)).toBe(true);
  });
});

describe("run details authorization", () => {
  it("scopes the selected run to the actor before reading events or messages", async () => {
    const run = { findFirst: vi.fn(async () => null) };
    const event = { findMany: vi.fn() };
    const message = { findFirst: vi.fn() };
    const actor = { userId: "owner", spaceId: "owned-space" };
    await expect(
      getRunDetails(
        { run, event, message } as unknown as Parameters<typeof getRunDetails>[0],
        actor,
        "other-run",
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "other-run",
          userId: actor.userId,
          spaceId: actor.spaceId,
          bot: { archivedAt: null },
        },
      }),
    );
    expect(event.findMany).not.toHaveBeenCalled();
    expect(message.findFirst).not.toHaveBeenCalled();
  });
});

it("returns durable processing and retry metadata for an owned run without exposing tool payloads", async () => {
  const at = new Date("2026-01-01T00:00:00Z");
  const owned = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    status: "queued",
    trigger: "routine",
    error: "Computer unavailable",
    updatedAt: at,
    bot: { name: "Assistant", notifyOnFinish: false },
    routine: { name: "Daily check" },
    task: { prompt: "Check files" },
    sourceMessage: null,
    thread: { groupId: null, group: null },
    attempts: [
      { status: "setup_failed", error: "Computer unavailable", startedAt: at, finishedAt: at },
    ],
  };
  const event = {
    findMany: vi.fn(async () => [
      {
        id: "audit-1",
        type: "agent.tool.completed",
        createdAt: at,
        payload: {
          name: "list_files",
          executionId: "call-1",
          outcome: "error",
          error: "Computer unavailable",
          args: "private",
          result: "private",
        },
      },
    ]),
  };
  const db = {
    run: { findFirst: vi.fn(async () => owned) },
    event,
    message: { findFirst: vi.fn(async () => null) },
  };
  const details = await getRunDetails(
    db as unknown as Parameters<typeof getRunDetails>[0],
    { userId: "owner", spaceId: "space-1" },
    "run-1",
  );
  expect(details.run.retry).toMatchObject({
    attempt: 2,
    maxAttempts: 3,
    at: "2026-01-01T00:00:30.000Z",
  });
  expect(details.tools[0]).toMatchObject({ name: "list_files", status: "failed" });
  expect(JSON.stringify(details)).not.toContain("private");
  expect(event.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ runId: "run-1", threadId: "thread-1", spaceId: "space-1" }),
    }),
  );
});
