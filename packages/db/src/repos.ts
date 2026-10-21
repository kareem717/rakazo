import type { Actor, Bot, BotSection, MessageBlock, SpaceBot } from "@rakazo/contracts";
import {
  BOT_COLORS,
  canonicalPiProviderId,
  DEFAULT_COMPUTER_MODE,
  InstructionVersionSchema,
} from "@rakazo/contracts";
import {
  BACKGROUND_RUN_TRIGGERS,
  isBackgroundRunTrigger,
  phoneCallSettings,
  ringingCall,
  runRetryState,
  userVisibleMessages,
} from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";
import type { ComputerMode } from "./computers.js";
import { ensureComputerRecord, parseComputerMode } from "./computers.js";
import { createThreadMessageInTransaction } from "./messages.js";
import { BotSectionNameConflictError, InvalidSectionParentError, IsolationError } from "./scope.js";
import { lockSpaceForContentCreation } from "./spaces.js";
import { activeRunSelection, latestBotRunSelection, previewFromBlocks } from "./thread-listing.js";
import { withTransactionRetry } from "./transaction-retry.js";

/** Newest messages loaded for sidebar preview; enough to skip a short peer-run tail. */
const SIDEBAR_PREVIEW_MESSAGE_WINDOW = 16;

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

function isSpawnKeyConflict(error: unknown): boolean {
  if (!isUniqueViolation(error)) return false;
  const target = (error as { meta?: { target?: string[] | string } }).meta?.target;
  if (target == null) return true;
  const fields = Array.isArray(target) ? target : [target];
  return fields.some((field) => field === "spawnKey" || field.includes("spawnKey"));
}

function rosterRunErrorId(
  latestRun: { id: string; status: string } | undefined,
  activeRun: { status: string } | undefined,
): string | null {
  if (
    latestRun?.status !== "failed" ||
    activeRun?.status === "waiting_input" ||
    activeRun?.status === "waiting_takeover"
  ) {
    return null;
  }
  return latestRun.id;
}

// Roster rows show when the chat last moved. Bot.updatedAt also moves on settings, pin,
// section and reorder writes, so the newest message's time wins when the chat has one.
function rosterUpdatedAt(newestMessage: { createdAt: Date } | undefined, botUpdatedAt: Date) {
  return newestMessage?.createdAt ?? botUpdatedAt;
}

function mapBot(
  bot: {
    id: string;
    spaceId: string;
    name: string;
    title: string;
    description: string;
    instructions: string;
    selfUpdateInstructions?: boolean;
    instructionHistory?: unknown;
    color: string;
    notifyOnFinish: boolean;
    pinned: boolean;
    sectionId: string | null;
    archivedAt: Date | null;
    parentBotId: string | null;
    memoryScope: string | null;
    createdAt: Date;
    updatedAt: Date;
    thread: { id: string; unread: boolean } | null;
    computer: { scope: string } | null;
    voiceId?: string | null;
    voiceProvider?: string | null;
    autoSpeak?: boolean;
    modelProvider?: string | null;
    modelId?: string | null;
    thinkingLevel?: string | null;
    teamChatAmbientEnabled?: boolean;
    teamChatRules?: string;
    fleetManagement?: boolean;
    disabledBuiltinTools?: string[];
    webhookSecretId?: string | null;
    spawnKey?: string | null;
  },
  preview = "",
  status = "idle",
  runErrorId: string | null = null,
  updatedAt: Date = bot.updatedAt,
  incomingCall: Bot["incomingCall"] = null,
): Bot {
  if (!bot.thread) {
    throw new IsolationError("Bot is missing its thread");
  }
  return {
    id: bot.id,
    spaceId: bot.spaceId,
    name: bot.name,
    title: bot.title,
    description: bot.description,
    instructions: bot.instructions,
    selfUpdateInstructions: bot.selfUpdateInstructions ?? false,
    instructionHistory: InstructionVersionSchema.array().parse(bot.instructionHistory ?? []),
    color: bot.color,
    notifyOnFinish: bot.notifyOnFinish,
    pinned: bot.pinned,
    sectionId: bot.sectionId,
    archivedAt: bot.archivedAt?.toISOString() ?? null,
    unread: bot.thread.unread,
    parentBotId: bot.parentBotId,
    memoryScope: bot.memoryScope as "isolated" | "shared" | null,
    threadId: bot.thread.id,
    preview,
    status,
    runErrorId,
    computerMode: bot.computer ? parseComputerMode(bot.computer.scope) : "team",
    createdAt: bot.createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    voiceId: bot.voiceId ?? null,
    voiceProvider: bot.voiceProvider ?? null,
    autoSpeak: bot.autoSpeak ?? false,
    modelProvider: bot.modelProvider ? canonicalPiProviderId(bot.modelProvider) : null,
    modelId: bot.modelId ?? null,
    thinkingLevel: (bot.thinkingLevel as Bot["thinkingLevel"]) ?? null,
    teamChatAmbientEnabled: bot.teamChatAmbientEnabled ?? false,
    teamChatRules: bot.teamChatRules ?? "",
    fleetManagement: bot.fleetManagement ?? false,
    disabledBuiltinTools: bot.disabledBuiltinTools ?? [],
    webhookConfigured: Boolean(bot.webhookSecretId),
    spawnKey: bot.spawnKey ?? null,
    incomingCall,
  };
}

export function createRepos(
  prisma: PrismaClient,
  capabilities: { phoneCallsEnabled?: boolean; phoneCallRingSeconds?: number } = {},
) {
  async function requireSectionParent(
    tx: Prisma.TransactionClient,
    actor: Actor,
    parentId: string | null,
    sectionId?: string,
  ) {
    const visited = new Set(sectionId ? [sectionId] : []);
    let current = parentId;
    while (current) {
      if (visited.has(current)) throw new InvalidSectionParentError();
      visited.add(current);
      const parent = await tx.botSection.findFirst({
        where: {
          id: current,
          spaceId: actor.spaceId,
          userId: actor.userId,
        },
      });
      if (!parent) throw new IsolationError();
      current = parent.parentId;
    }
  }

  function sectionDto(section: {
    id: string;
    name: string;
    parentId: string | null;
    position: number;
    createdAt: Date;
    updatedAt: Date;
  }): BotSection {
    return {
      id: section.id,
      name: section.name,
      parentId: section.parentId,
      position: section.position,
      createdAt: section.createdAt.toISOString(),
      updatedAt: section.updatedAt.toISOString(),
    };
  }

  async function listBotSectionsForSpaces(
    actor: Actor,
    spaceIds: string[],
  ): Promise<Array<BotSection & { spaceId: string }>> {
    if (spaceIds.length === 0) return [];
    const sections = await prisma.botSection.findMany({
      where: { spaceId: { in: spaceIds }, userId: actor.userId },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    });
    return sections.map((section) => ({
      id: section.id,
      spaceId: section.spaceId,
      name: section.name,
      parentId: section.parentId,
      position: section.position,
      createdAt: section.createdAt.toISOString(),
      updatedAt: section.updatedAt.toISOString(),
    }));
  }

  async function listSpaceBotsForSpaces(actor: Actor, spaceIds: string[]): Promise<SpaceBot[]> {
    if (spaceIds.length === 0) return [];
    const bots = await prisma.bot.findMany({
      where: {
        spaceId: { in: spaceIds },
        userId: actor.userId,
        archivedAt: null,
      },
      select: {
        id: true,
        spaceId: true,
        name: true,
        title: true,
        color: true,
        notifyOnFinish: true,
        pinned: true,
        sectionId: true,
        updatedAt: true,
        parentBotId: true,
        thread: {
          select: {
            unread: true,
            messages: {
              orderBy: { seq: "desc" },
              take: 1,
              select: { blocks: true, createdAt: true },
            },
            runs: latestBotRunSelection,
          },
        },
        runs: activeRunSelection,
      },
      orderBy: [{ pinned: "desc" }, { position: "asc" }, { createdAt: "asc" }],
    });
    return bots.map((bot) => {
      if (!bot.thread) throw new IsolationError("Bot is missing its thread");
      return {
        id: bot.id,
        spaceId: bot.spaceId,
        name: bot.name,
        title: bot.title,
        color: bot.color,
        notifyOnFinish: bot.notifyOnFinish,
        pinned: bot.pinned,
        sectionId: bot.sectionId,
        unread: bot.thread.unread,
        parentBotId: bot.parentBotId,
        preview: previewFromBlocks(bot.thread.messages[0]?.blocks),
        status: bot.runs[0]?.status ?? "idle",
        retry: bot.runs[0] ? runRetryState(bot.runs[0]) : null,
        runErrorId: rosterRunErrorId(bot.thread.runs[0], bot.runs[0]),
        updatedAt: rosterUpdatedAt(bot.thread.messages[0], bot.updatedAt).toISOString(),
      };
    });
  }

  return {
    async listBotSections(actor: Actor): Promise<BotSection[]> {
      return listBotSectionsForSpaces(actor, [actor.spaceId]);
    },

    listBotSectionsForSpaces,

    async createBotSection(
      actor: Actor,
      input: { botId?: string; groupId?: string; name: string; parentId?: string | null },
    ) {
      return prisma.$transaction(async (tx) => {
        await lockSpaceForContentCreation(tx, actor);
        const parentId = input.parentId ?? null;
        await requireSectionParent(tx, actor, parentId);
        const targetWhere = { spaceId: actor.spaceId, userId: actor.userId, archivedAt: null };
        if (input.botId && input.groupId) throw new IsolationError();
        if (
          input.botId &&
          !(await tx.bot.findFirst({ where: { ...targetWhere, id: input.botId } }))
        ) {
          throw new IsolationError();
        }
        if (
          input.groupId &&
          !(await tx.chatGroup.findFirst({ where: { ...targetWhere, id: input.groupId } }))
        ) {
          throw new IsolationError();
        }
        const where = { spaceId: actor.spaceId, userId: actor.userId };
        const existing = await tx.botSection.findFirst({
          where: { ...where, name: input.name, parentId },
        });
        const aggregate = await tx.botSection.aggregate({ where, _max: { position: true } });
        const section =
          existing ??
          (await tx.botSection.create({
            data: {
              ...where,
              name: input.name,
              parentId,
              position: (aggregate._max.position ?? -1) + 1,
            },
          }));
        if (input.botId) {
          await tx.bot.update({ where: { id: input.botId }, data: { sectionId: section.id } });
        } else if (input.groupId) {
          await tx.chatGroup.update({
            where: { id: input.groupId },
            data: { sectionId: section.id },
          });
        }
        return sectionDto(section);
      });
    },

    async updateBotSection(
      actor: Actor,
      input: { sectionId: string; name?: string; parentId?: string | null },
    ) {
      try {
        return await prisma.$transaction(async (tx) => {
          await lockSpaceForContentCreation(tx, actor);
          const existing = await tx.botSection.findFirst({
            where: {
              id: input.sectionId,
              spaceId: actor.spaceId,
              userId: actor.userId,
            },
          });
          if (!existing) throw new IsolationError();
          if (input.parentId !== undefined) {
            await requireSectionParent(tx, actor, input.parentId, existing.id);
          }
          const section = await tx.botSection.update({
            where: { id: existing.id },
            data: {
              name: input.name,
              parentId: input.parentId,
            },
          });
          return sectionDto(section);
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw new BotSectionNameConflictError();
        throw error;
      }
    },

    /** Delete one of the actor's sections; its bots and groups stay, unsectioned (FK SetNull). */
    async deleteBotSection(actor: Actor, input: { sectionId: string }) {
      return prisma.$transaction(async (tx) => {
        await lockSpaceForContentCreation(tx, actor);
        // The row lock blocks concurrent moves into this section until the delete commits.
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id
          FROM bot_sections
          WHERE id = ${input.sectionId}
            AND "spaceId" = ${actor.spaceId}
            AND "userId" = ${actor.userId}
          FOR UPDATE
        `;
        if (locked.length !== 1) throw new IsolationError();
        const where = { sectionId: input.sectionId };
        const releasedBots = await tx.bot.count({ where });
        const releasedGroups = await tx.chatGroup.count({ where });
        // Promote children to the deleted section's parent. Abort atomically if a
        // sibling name conflicts; never silently rename or delete a subsection.
        const section = await tx.botSection.findUniqueOrThrow({ where: { id: input.sectionId } });
        const children = await tx.botSection.findMany({ where: { parentId: section.id } });
        for (const child of children) {
          if (
            await tx.botSection.findFirst({
              where: {
                spaceId: actor.spaceId,
                userId: actor.userId,
                parentId: section.parentId,
                name: child.name,
              },
            })
          )
            throw new BotSectionNameConflictError();
          await tx.botSection.update({
            where: { id: child.id },
            data: { parentId: section.parentId },
          });
        }
        await tx.botSection.delete({ where: { id: input.sectionId } });
        return { id: input.sectionId, releasedBots, releasedGroups };
      });
    },

    async listBots(actor: Actor, options: { archived?: boolean } = {}): Promise<Bot[]> {
      const bots = await prisma.bot.findMany({
        where: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          archivedAt: options.archived ? { not: null } : null,
        },
        include: {
          thread: {
            include: {
              messages: { orderBy: { seq: "desc" }, take: SIDEBAR_PREVIEW_MESSAGE_WINDOW },
              runs: latestBotRunSelection,
            },
          },
          runs: activeRunSelection,
          computer: { select: { scope: true } },
        },
        orderBy: [{ pinned: "desc" }, { position: "asc" }, { createdAt: "asc" }],
      });
      const callThreadIds = capabilities.phoneCallsEnabled
        ? bots.flatMap((bot) => (bot.thread ? [bot.thread.id] : []))
        : [];
      const callMessages = callThreadIds.length
        ? await prisma.message.findMany({
            where: {
              threadId: { in: callThreadIds },
              createdAt: {
                gt: new Date(
                  Date.now() -
                    (capabilities.phoneCallRingSeconds ??
                      phoneCallSettings().phoneCallRingSeconds) *
                      1000,
                ),
              },
              role: "bot",
              clientNonce: { startsWith: "call:", endsWith: ":request" },
            },
            orderBy: { seq: "desc" },
            distinct: ["threadId"],
            select: { threadId: true, role: true, blocks: true },
          })
        : [];
      const callsByThread = new Map(callMessages.map((message) => [message.threadId, message]));
      const candidateRunIds = [
        ...new Set(
          bots.flatMap((bot) =>
            (bot.thread?.messages ?? []).flatMap((message) =>
              message.runId ? [message.runId] : [],
            ),
          ),
        ),
      ];
      const checkedRunIds = new Set<string>();
      const peerRunIds = new Set<string>();
      const backgroundRunIds = new Set<string>();
      const classifyRunIds = async (ids: string[]) => {
        const missing = ids.filter((id) => !checkedRunIds.has(id));
        if (missing.length === 0) return;
        const rows = await prisma.run.findMany({
          where: {
            id: { in: missing },
            trigger: { in: ["bot_message", ...BACKGROUND_RUN_TRIGGERS] },
          },
          select: { id: true, trigger: true },
        });
        for (const row of rows) {
          if (isBackgroundRunTrigger(row.trigger)) backgroundRunIds.add(row.id);
          else peerRunIds.add(row.id);
        }
        for (const id of missing) checkedRunIds.add(id);
      };
      await classifyRunIds(candidateRunIds);
      return Promise.all(
        bots.map(async (bot) => {
          let messages = bot.thread?.messages ?? [];
          const updatedAt = rosterUpdatedAt(messages[0], bot.updatedAt);
          let preview = "";
          for (let attempt = 0; attempt < 5; attempt++) {
            const windowRunIds = [
              ...new Set(messages.flatMap((message) => (message.runId ? [message.runId] : []))),
            ].filter((runId) => !checkedRunIds.has(runId));
            if (windowRunIds.length > 0) {
              await classifyRunIds(windowRunIds);
            }
            const visible = userVisibleMessages(
              messages.map((message) => ({
                ...message,
                blocks: message.blocks as MessageBlock[],
                runId: message.runId ?? undefined,
              })),
              {
                knownPeerRunIds: peerRunIds,
                backgroundRunIds,
                includeDelegatedReplyText: false,
              },
            );
            preview = previewFromBlocks(visible[0]?.blocks);
            if (preview || messages.length === 0 || !bot.thread || attempt === 4) break;
            const oldest = messages[messages.length - 1];
            if (!oldest) break;
            messages = await prisma.message.findMany({
              where: { threadId: bot.thread.id, seq: { lt: oldest.seq } },
              orderBy: { seq: "desc" },
              take: SIDEBAR_PREVIEW_MESSAGE_WINDOW,
            });
            if (messages.length === 0) break;
          }
          return {
            ...mapBot(
              bot,
              preview,
              bot.runs[0]?.status ?? "idle",
              rosterRunErrorId(bot.thread?.runs[0], bot.runs[0]),
              updatedAt,
              ringingCall(
                bot.thread && callsByThread.has(bot.thread.id)
                  ? [callsByThread.get(bot.thread.id)!]
                  : [],
              ),
            ),
            retry: bot.runs[0] ? runRetryState(bot.runs[0]) : null,
          };
        }),
      );
    },

    listSpaceBotsForSpaces,

    async getBot(actor: Actor, botId: string, options: { includeArchived?: boolean } = {}) {
      const bot = await prisma.bot.findFirst({
        where: {
          id: botId,
          spaceId: actor.spaceId,
          userId: actor.userId,
          ...(options.includeArchived ? {} : { archivedAt: null }),
        },
        include: { thread: true, computer: true },
      });
      if (!bot) throw new IsolationError();
      return bot;
    },

    async createBot(
      actor: Actor,
      input: {
        name: string;
        title: string;
        description: string;
        instructions: string;
        notifyOnFinish: boolean;
        color?: string;
        parentBotId?: string | null;
        computerMode?: ComputerMode;
        spawnKey?: string;
        modelProvider?: string | null;
        modelId?: string | null;
        thinkingLevel?: string | null;
        disabledBuiltinTools?: string[];
        initialMessage?: {
          role: "user" | "bot" | "system";
          blocks: MessageBlock[];
          runId?: string;
        };
      },
    ): Promise<Bot> {
      let color = input.color;
      if (color === undefined) {
        const count = await prisma.bot.count({
          where: { spaceId: actor.spaceId, userId: actor.userId },
        });
        color = BOT_COLORS[count % BOT_COLORS.length] ?? BOT_COLORS[0];
      }
      let modelProvider = input.modelProvider ?? null;
      let modelId = input.modelId ?? null;
      let thinkingLevel = input.thinkingLevel ?? null;
      let disabledBuiltinTools = input.disabledBuiltinTools ?? [];
      if (input.parentBotId) {
        const parent = await prisma.bot.findFirst({
          where: {
            id: input.parentBotId,
            spaceId: actor.spaceId,
            userId: actor.userId,
          },
        });
        if (!parent) throw new IsolationError();
        if (!modelId) {
          modelProvider = parent.modelProvider ?? null;
          modelId = parent.modelId ?? null;
        }
        if (thinkingLevel == null) thinkingLevel = parent.thinkingLevel ?? null;
        if (input.disabledBuiltinTools === undefined) {
          disabledBuiltinTools = parent.disabledBuiltinTools;
        }
      }
      const settings = await prisma.deploymentSettings.findUnique({ where: { id: "default" } });
      const envKind = process.env.SANDBOX_PROVIDER ?? "docker";
      const kind =
        envKind === "docker" && settings?.computerHost === "this-mac" ? "desktop" : envKind;
      const insertBot = () =>
        prisma.$transaction(async (tx) => {
          await lockSpaceForContentCreation(tx, {
            spaceId: actor.spaceId,
            userId: actor.userId,
          });
          const positions = await tx.bot.aggregate({
            where: { spaceId: actor.spaceId, userId: actor.userId },
            _max: { position: true },
          });
          const teamComputer = await ensureComputerRecord(tx, {
            mode: "team",
            spaceId: actor.spaceId,
            userId: actor.userId,
            kind,
          });
          const created = await tx.bot.create({
            data: {
              spaceId: actor.spaceId,
              userId: actor.userId,
              name: input.name,
              title: input.title,
              description: input.description,
              instructions: input.instructions,
              notifyOnFinish: input.notifyOnFinish,
              color,
              position: (positions._max.position ?? -1) + 1,
              parentBotId: input.parentBotId ?? null,
              computerId: teamComputer.id,
              spawnKey: input.spawnKey,
              modelProvider,
              modelId,
              thinkingLevel,
              disabledBuiltinTools,
            },
          });
          const thread = await tx.thread.create({
            data: {
              spaceId: actor.spaceId,
              botId: created.id,
              userId: actor.userId,
            },
          });
          if (input.initialMessage) {
            await createThreadMessageInTransaction(tx, {
              threadId: thread.id,
              ...input.initialMessage,
            });
          }
          if ((input.computerMode ?? DEFAULT_COMPUTER_MODE) === "dedicated") {
            const dedicated = await ensureComputerRecord(tx, {
              mode: "dedicated",
              spaceId: actor.spaceId,
              userId: actor.userId,
              botId: created.id,
              kind,
            });
            await tx.bot.update({ where: { id: created.id }, data: { computerId: dedicated.id } });
          }
          await tx.browserProfile.create({
            data: {
              spaceId: actor.spaceId,
              botId: created.id,
              userId: actor.userId,
            },
          });
          await tx.memoryDocument.create({
            data: {
              spaceId: actor.spaceId,
              userId: actor.userId,
              botId: created.id,
              scope: "bot",
              path: "MEMORY.md",
              content: `# ${input.name}\n\n`,
            },
          });
          return tx.bot.findFirstOrThrow({
            where: { id: created.id },
            include: { thread: true, computer: true },
          });
        });

      const findBySpawnKey = async () => {
        if (!input.spawnKey) return null;
        return prisma.bot.findUnique({
          where: {
            spaceId_spawnKey: {
              spaceId: actor.spaceId,
              spawnKey: input.spawnKey,
            },
          },
          include: { thread: true, computer: true },
        });
      };

      let bot: Awaited<ReturnType<typeof insertBot>>;
      try {
        bot = await insertBot();
      } catch (error) {
        if (!input.spawnKey || !isSpawnKeyConflict(error)) throw error;
        const existing = await findBySpawnKey();
        if (!existing || existing.userId !== actor.userId) throw error;
        if (!existing.archivedAt) {
          bot = existing;
        } else {
          // Free the key from the archived bot so empty-space onboarding
          // creates a fresh first bot (stale thread/runtime must not return).
          await prisma.bot.update({
            where: { id: existing.id },
            data: { spawnKey: null },
          });
          try {
            bot = await insertBot();
          } catch (retryError) {
            if (!isSpawnKeyConflict(retryError)) throw retryError;
            const winner = await findBySpawnKey();
            if (!winner || winner.userId !== actor.userId || winner.archivedAt) throw retryError;
            bot = winner;
          }
        }
      }
      return mapBot(bot);
    },

    async reorderBots(actor: Actor, botIds: string[]): Promise<void> {
      await prisma.$transaction(async (tx) => {
        const bots = await tx.bot.findMany({
          where: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            archivedAt: null,
          },
          select: { id: true },
        });
        const existing = new Set(bots.map((bot) => bot.id));
        if (existing.size !== botIds.length || botIds.some((id) => !existing.has(id))) {
          throw new IsolationError();
        }
        // ponytail: rosters are small; switch to one SQL CASE update only if this becomes hot.
        await Promise.all(
          botIds.map((id, position) => tx.bot.update({ where: { id }, data: { position } })),
        );
      });
    },

    async setBotComputer(actor: Actor, botId: string, mode: ComputerMode): Promise<Bot> {
      const bot = await prisma.bot.findFirst({
        where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
        include: { computer: true },
      });
      if (!bot?.computer) throw new IsolationError();
      const kind = bot.computer.kind;
      // Keep ensure + bot link in one transaction so a capped quota lock covers
      // both steps (a computer row alone does not count until a live bot refs it).
      const updated = await withTransactionRetry(() =>
        prisma.$transaction(async (tx) => {
          const computer = await ensureComputerRecord(tx, {
            mode,
            spaceId: actor.spaceId,
            userId: actor.userId,
            botId,
            kind,
          });
          return tx.bot.update({
            where: { id: botId },
            data: { computerId: computer.id },
            include: { thread: true, computer: true },
          });
        }),
      );
      return mapBot(updated);
    },
  };
}
