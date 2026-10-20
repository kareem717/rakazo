import { ORPCError } from "@orpc/server";
import type { Actor, RunActivityRow, RunDetails } from "@rakazo/contracts";
import { MessageBlock } from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  BACKGROUND_RUN_TRIGGERS,
  botMessageContext,
  projectRunToolActivity,
  RUN_SETUP_MAX_ATTEMPTS,
  runRetryState,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

const RECENT_LIMIT = 20;
const TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const;

function promptSnippet(prompt: string, max = 120): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

export function activityPromptSnippet(
  input: { trigger: string; prompt: string; sourceBlocks?: unknown },
  max = 120,
): string {
  if (input.trigger !== "bot_message") return promptSnippet(input.prompt, max);
  const parsed = MessageBlock.array().safeParse(input.sourceBlocks);
  const message = parsed.success ? botMessageContext(parsed.data) : undefined;
  if (!message) return "Message from another agent";
  const name = message.fromBotName.trim() || "Another agent";
  const label =
    message.intent === "result" || message.intent === "status" || message.intent === "fyi"
      ? `Update from ${name}`
      : `${name} asked`;
  return promptSnippet(message.text.trim() ? `${label}: ${message.text}` : label, max);
}

export function activityNotificationsEnabled(
  groupId: string | null,
  notifyOnFinish: boolean,
): boolean {
  return groupId !== null || notifyOnFinish;
}

export async function listSpaceRuns(
  prisma: PrismaClient,
  actor: Actor,
  filter: "active" | "recent",
): Promise<RunActivityRow[]> {
  const rows = await prisma.run.findMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      bot: { archivedAt: null },
      // Background ticket work belongs on the board, not in the activity list.
      trigger: { notIn: [...BACKGROUND_RUN_TRIGGERS] },
      ...(filter === "active"
        ? { status: { in: [...ACTIVE_RUN_STATUSES] } }
        : { status: { in: [...TERMINAL_STATUSES] } }),
    },
    include: {
      attempts: {
        where: { status: "setup_failed", error: { not: null } },
        orderBy: { finishedAt: "desc" },
        take: RUN_SETUP_MAX_ATTEMPTS,
        select: { error: true, finishedAt: true },
      },
      bot: { select: { name: true, archivedAt: true, notifyOnFinish: true } },
      task: { select: { prompt: true } },
      sourceMessage: { select: { blocks: true } },
      thread: {
        select: {
          groupId: true,
          group: { select: { name: true } },
        },
      },
    },
    orderBy:
      filter === "active"
        ? [{ updatedAt: "desc" }, { id: "desc" }]
        : [{ completedAt: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
    take: filter === "recent" ? RECENT_LIMIT : undefined,
  });

  return rows.map((row) => ({
    runId: row.id,
    botId: row.botId,
    botName: row.bot.name,
    groupId: row.thread.groupId,
    groupName: row.thread.group?.name ?? null,
    threadId: row.threadId,
    status: row.status as RunActivityRow["status"],
    retry: runRetryState(row),
    trigger: row.trigger as RunActivityRow["trigger"],
    notificationsEnabled: activityNotificationsEnabled(row.thread.groupId, row.bot.notifyOnFinish),
    promptSnippet: activityPromptSnippet({
      trigger: row.trigger,
      prompt: row.task.prompt,
      sourceBlocks: row.sourceMessage?.blocks,
    }),
    updatedAt: (filter === "recent" && row.completedAt
      ? row.completedAt
      : row.updatedAt
    ).toISOString(),
  }));
}

export async function getRunDetails(
  prisma: PrismaClient,
  actor: Actor,
  runId: string,
): Promise<RunDetails> {
  const run = await prisma.run.findFirst({
    where: { id: runId, spaceId: actor.spaceId, userId: actor.userId, bot: { archivedAt: null } },
    include: {
      bot: { select: { name: true, notifyOnFinish: true } },
      routine: { select: { name: true } },
      task: { select: { prompt: true } },
      sourceMessage: { select: { blocks: true } },
      thread: { select: { groupId: true, group: { select: { name: true } } } },
      attempts: { orderBy: { fence: "asc" } },
    },
  });
  if (!run) throw new ORPCError("NOT_FOUND");
  const [events, message] = await Promise.all([
    prisma.event.findMany({
      where: {
        runId,
        threadId: run.threadId,
        spaceId: actor.spaceId,
        type: { in: ["run.started", "agent.tool.called", "agent.tool.completed"] },
      },
      orderBy: { seq: "desc" },
      take: 1_000,
      select: { id: true, type: true, createdAt: true, payload: true },
    }),
    prisma.message.findFirst({
      where: { runId, threadId: run.threadId, role: "bot" },
      orderBy: { seq: "desc" },
      select: { id: true },
    }),
  ]);
  const retry = runRetryState({
    ...run,
    attempts: run.attempts.filter(
      (attempt) => attempt.status === "setup_failed" && attempt.error !== null,
    ),
  });
  return {
    run: {
      runId: run.id,
      botId: run.botId,
      botName: run.bot.name,
      groupId: run.thread.groupId,
      groupName: run.thread.group?.name ?? null,
      threadId: run.threadId,
      status: run.status as RunActivityRow["status"],
      trigger: run.trigger as RunActivityRow["trigger"],
      notificationsEnabled: activityNotificationsEnabled(
        run.thread.groupId,
        run.bot.notifyOnFinish,
      ),
      promptSnippet: activityPromptSnippet({
        trigger: run.trigger,
        prompt: run.task.prompt,
        sourceBlocks: run.sourceMessage?.blocks,
      }),
      updatedAt: run.updatedAt.toISOString(),
      retry,
    },
    routineName: run.routine?.name ?? null,
    error: run.error?.slice(0, 2_000) ?? null,
    attempts: run.attempts.map((attempt, index) => ({
      number: index + 1,
      status: attempt.status,
      error: attempt.error?.slice(0, 2_000) ?? null,
      startedAt: attempt.startedAt.toISOString(),
      finishedAt: attempt.finishedAt?.toISOString() ?? null,
    })),
    tools: projectRunToolActivity(events.reverse(), run.status),
    messageId: message?.id ?? null,
  };
}
