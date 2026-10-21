import * as z from "zod";
import { Id, IsoDate, RunStatus } from "./ids.js";

export const RUN_TRIGGERS = [
  "user",
  "routine",
  "resume",
  "follow_up",
  "reaction",
  "call_end",
  "spawn",
  "skill",
  "bot_message",
  "webhook",
  "messaging",
  "cloud_agent",
  "created",
  "tickets",
] as const;
export const RunTriggerSchema = z.enum(RUN_TRIGGERS);
export type RunTrigger = z.infer<typeof RunTriggerSchema>;

export const RunRetrySchema = z.object({
  attempt: z.number().int().positive(),
  maxAttempts: z.number().int().positive(),
  at: IsoDate,
  error: z.string(),
});
export type RunRetry = z.infer<typeof RunRetrySchema>;

export const RoutineRunSchema = z.object({
  id: Id,
  botId: Id,
  groupId: Id.nullable(),
  status: RunStatus,
  retry: RunRetrySchema.nullable().optional(),
  error: z.string().nullable(),
  createdAt: IsoDate,
  startedAt: IsoDate.nullable(),
  completedAt: IsoDate.nullable(),
  messageId: Id.nullable(),
});
export type RoutineRun = z.infer<typeof RoutineRunSchema>;

export const RoutineRunCursorSchema = z.object({ id: Id, createdAt: IsoDate });
export type RoutineRunCursor = z.infer<typeof RoutineRunCursorSchema>;
export const RoutineHistorySchema = z.object({
  runs: z.array(RoutineRunSchema),
  nextCursor: RoutineRunCursorSchema.nullable(),
});
export type RoutineHistory = z.infer<typeof RoutineHistorySchema>;

export const RunActivityRowSchema = z.object({
  runId: Id,
  botId: Id,
  botName: z.string(),
  groupId: Id.nullable(),
  groupName: z.string().nullable(),
  threadId: Id,
  status: RunStatus,
  retry: RunRetrySchema.nullable().optional(),
  trigger: RunTriggerSchema,
  notificationsEnabled: z.boolean(),
  promptSnippet: z.string(),
  updatedAt: z.string(),
});
export type RunActivityRow = z.infer<typeof RunActivityRowSchema>;

export const RunsListOutputSchema = z.object({
  runs: z.array(RunActivityRowSchema),
});
export type RunsListOutput = z.infer<typeof RunsListOutputSchema>;

export const RunToolActivitySchema = z.object({
  id: z.string(),
  name: z.string(),
  startedAt: IsoDate,
  completedAt: IsoDate.nullable(),
  status: z.enum(["running", "succeeded", "failed", "paused", "interrupted"]),
  error: z.string().nullable(),
});
export type RunToolActivity = z.infer<typeof RunToolActivitySchema>;

export const RunDetailsSchema = z.object({
  run: RunActivityRowSchema,
  routineName: z.string().nullable(),
  error: z.string().nullable(),
  attempts: z.array(
    z.object({
      number: z.number().int().positive(),
      status: z.string(),
      error: z.string().nullable(),
      startedAt: IsoDate,
      finishedAt: IsoDate.nullable(),
    }),
  ),
  tools: z.array(RunToolActivitySchema),
  messageId: Id.nullable(),
});
export type RunDetails = z.infer<typeof RunDetailsSchema>;
