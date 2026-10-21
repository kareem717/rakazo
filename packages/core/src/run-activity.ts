import type { RunToolActivity } from "@rakazo/contracts";

/** Project only tool audit metadata; arguments, outputs and model reasoning stay private. */
export function projectRunToolActivity(
  events: readonly { id: string; type: string; createdAt: Date | string; payload: unknown }[],
  runStatus: string,
): RunToolActivity[] {
  const tools = new Map<string, RunToolActivity>();
  function interrupt() {
    for (const tool of tools.values()) if (tool.status === "running") tool.status = "interrupted";
  }
  for (const event of events) {
    if (event.type === "run.started") {
      interrupt();
      continue;
    }
    if (event.type !== "agent.tool.called" && event.type !== "agent.tool.completed") continue;
    const payload =
      event.payload && typeof event.payload === "object"
        ? (event.payload as Record<string, unknown>)
        : {};
    if (typeof payload.name !== "string") continue;
    const id = typeof payload.executionId === "string" ? payload.executionId : event.id;
    const at = new Date(event.createdAt).toISOString();
    const existing = tools.get(id);
    if (event.type === "agent.tool.called") {
      // Some runtimes publish their tool event after executeTool's completion audit.
      if (existing?.completedAt) continue;
      tools.set(id, {
        id,
        name: payload.name.slice(0, 256),
        startedAt: at,
        completedAt: null,
        status: "running",
        error: null,
      });
    } else {
      tools.set(id, {
        id,
        name: payload.name.slice(0, 256),
        startedAt:
          existing?.startedAt ??
          new Date(
            new Date(at).getTime() -
              (typeof payload.durationMs === "number" && Number.isFinite(payload.durationMs)
                ? Math.min(Math.max(0, payload.durationMs), new Date(at).getTime())
                : 0),
          ).toISOString(),
        completedAt: at,
        status:
          payload.outcome === "error"
            ? "failed"
            : payload.outcome === "paused"
              ? "paused"
              : "succeeded",
        error: typeof payload.error === "string" ? payload.error.slice(0, 2_000) : null,
      });
    }
  }
  if (runStatus !== "running" && runStatus !== "leased") interrupt();
  return [...tools.values()];
}
