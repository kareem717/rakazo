import { describe, expect, it } from "vitest";
import { projectRunToolActivity } from "./run-activity.js";

const at = "2026-01-01T00:00:00Z";
const event = (id: string, type: string, payload: unknown = {}) => ({
  id,
  type,
  createdAt: at,
  payload,
});
describe("run tool activity", () => {
  it("pairs durable tool calls with their outcome without exposing arguments or results", () => {
    const tools = projectRunToolActivity(
      [
        event("1", "agent.tool.called", {
          name: "list_files",
          executionId: "call-1",
          args: { secret: "private" },
        }),
        event("2", "agent.tool.completed", {
          name: "list_files",
          executionId: "call-1",
          outcome: "error",
          error: "Computer unavailable",
          result: "private output",
        }),
      ],
      "failed",
    );
    expect(tools).toEqual([
      {
        id: "call-1",
        name: "list_files",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:00.000Z",
        status: "failed",
        error: "Computer unavailable",
      },
    ]);
    expect(JSON.stringify(tools)).not.toContain("private");
  });
  it("preserves an outcome when the runtime publishes its call after completion", () => {
    const tools = projectRunToolActivity(
      [
        event("1", "agent.tool.completed", {
          name: "read_file",
          executionId: "call-1",
          outcome: "succeeded",
          durationMs: 500,
        }),
        event("2", "agent.tool.called", { name: "read_file", executionId: "call-1" }),
      ],
      "completed",
    );
    expect(tools[0]?.status).toBe("succeeded");
    expect(tools[0]?.startedAt).toBe("2025-12-31T23:59:59.500Z");
  });
  it("marks abandoned calls from an older attempt as interrupted", () => {
    const tools = projectRunToolActivity(
      [
        event("1", "agent.tool.called", { name: "list_files", executionId: "old" }),
        event("2", "run.started"),
        event("3", "agent.tool.called", { name: "read_file", executionId: "new" }),
      ],
      "running",
    );
    expect(tools.map((tool) => tool.status)).toEqual(["interrupted", "running"]);
  });
  it("never leaves a historical call looking live in a paused or finished run", () => {
    expect(
      projectRunToolActivity(
        [event("1", "agent.tool.called", { name: "read_file" })],
        "waiting_input",
      )[0]?.status,
    ).toBe("interrupted");
  });
  it("can show a completion when its start has aged out of the recent window", () => {
    expect(
      projectRunToolActivity(
        [event("1", "agent.tool.completed", { name: "ask_user", outcome: "paused" })],
        "waiting_input",
      )[0]?.status,
    ).toBe("paused");
  });
});
