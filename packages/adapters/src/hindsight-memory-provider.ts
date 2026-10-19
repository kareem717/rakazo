import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AdapterContext,
  SemanticMemoryForgetRequest,
  SemanticMemoryProvider,
  SemanticMemoryPurgeHistoryRequest,
  SemanticMemoryRecallRequest,
  SemanticMemoryResponse,
  SemanticMemoryResult,
  SemanticMemorySaveRequest,
} from "@rakazo/adapter-kit";
import { z } from "zod";
import { combineSignals } from "./connector-safety.js";
import type { HindsightConnection, HindsightNetwork } from "./hindsight-client.js";
import {
  classifyHindsightSettings,
  HindsightRequestError,
  normalizeHindsightUrl,
  requestHindsight,
} from "./hindsight-client.js";
import { MemoryProviderDeploymentOwnerRequiredError } from "./serenity-memory-provider.js";

export { classifyHindsightSettings, hindsightRequiresDeploymentOwner } from "./hindsight-client.js";
export const HINDSIGHT_PROVIDER_ID = "hindsight";
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const bankMap = z.record(identifier, identifier).refine((value) => {
  const count = Object.keys(value).length;
  return count > 0 && count <= 100;
}, "Map between one and 100 bots to Hindsight banks.");
const operationSchema = z.object({
  operation_id: z.string(),
  status: z.enum(["pending", "processing", "completed", "failed", "cancelled", "not_found"]),
  child_operations: z.array(z.object({ operation_id: z.string(), status: z.string() })).nullish(),
});
const documentSchema = z.object({
  id: z.string(),
  bank_id: z.string(),
  original_text: z.string().nullable(),
  memory_unit_count: z.number().int().nonnegative(),
  tags: z.array(z.string()).default([]),
});
interface HindsightConfig extends HindsightConnection {
  botBanks: Record<string, string>;
  sharedBankId?: string;
  allowWrites: boolean;
}

function parseConnection(
  settings: Record<string, string>,
  credentials: Record<string, string>,
): HindsightConfig {
  const apiKey = credentials.apiKey?.trim();
  if (!apiKey || apiKey.length < 8 || apiKey.length > 4096 || /[\r\n]/.test(apiKey))
    throw new Error("A valid Hindsight API key is required.");
  let botBanks: Record<string, string>;
  try {
    botBanks = bankMap.parse(JSON.parse(settings.botBanks ?? ""));
  } catch {
    throw new Error("Map between one and 100 bot IDs to valid Hindsight bank IDs.");
  }
  const sharedBankId = settings.sharedBankId?.trim() || undefined;
  if (sharedBankId) identifier.parse(sharedBankId);
  if (settings.allowWrites && !["true", "false"].includes(settings.allowWrites))
    throw new Error("allowWrites must be true or false.");
  return {
    baseUrl: normalizeHindsightUrl(settings.baseUrl ?? ""),
    apiKey,
    botBanks,
    sharedBankId,
    allowWrites: settings.allowWrites === "true",
    ...(settings.endpointTrust === "private" ? { endpointTrust: "private" } : {}),
  };
}

export async function prepareHindsightConnection(
  settings: Record<string, string>,
  credentials: Record<string, string>,
  network: HindsightNetwork = {},
  options?: { allowPrivateEndpoint?: boolean },
): Promise<{ settings: Record<string, string>; credentials: Record<string, string> }> {
  const classified = await classifyHindsightSettings(settings, network);
  if (classified.endpointTrust === "private" && options?.allowPrivateEndpoint === false)
    throw new MemoryProviderDeploymentOwnerRequiredError();
  const config = parseConnection(classified, credentials);
  const signal = AbortSignal.timeout(15_000);
  try {
    for (const bank of new Set([
      ...Object.values(config.botBanks),
      ...(config.sharedBankId ? [config.sharedBankId] : []),
    ])) {
      await requestHindsight(config, bank, "stats", signal, {}, network);
    }
  } catch (error) {
    throw new Error(errorMessage(error));
  }
  return {
    settings: {
      baseUrl: config.baseUrl,
      botBanks: JSON.stringify(config.botBanks),
      allowWrites: String(config.allowWrites),
      ...(config.sharedBankId ? { sharedBankId: config.sharedBankId } : {}),
      ...(config.endpointTrust ? { endpointTrust: config.endpointTrust } : {}),
    },
    credentials: { apiKey: config.apiKey },
  };
}

export function createHindsightProvider(
  settings: Record<string, string>,
  credentials: Record<string, string>,
): SemanticMemoryProvider {
  return new HindsightMemoryProvider(parseConnection(settings, credentials));
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function namespace(context: AdapterContext, botId: string, shared = false): string {
  return `rakazo-${digest(JSON.stringify([context.spaceId, context.userId, shared ? "shared" : botId]))}-`;
}

function errorMessage(error: unknown): string {
  return error instanceof HindsightRequestError
    ? error.message
    : "Hindsight operation failed or timed out. No save or deletion was confirmed.";
}

export class HindsightMemoryProvider implements SemanticMemoryProvider {
  constructor(
    private readonly config: HindsightConfig,
    private readonly network: HindsightNetwork = {},
  ) {}

  describe() {
    return {
      id: HINDSIGHT_PROVIDER_ID,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { recall: true, save: true, purgeHistory: true, sharedScope: true } as const,
    };
  }

  private bank(botId: string): string {
    const bank = Object.hasOwn(this.config.botBanks, botId)
      ? this.config.botBanks[botId]
      : undefined;
    if (!bank)
      throw new HindsightRequestError(
        "This bot has no Hindsight bank mapping. Configure its bank in Memory settings.",
      );
    return bank;
  }

  private request<T>(
    bank: string,
    route: string,
    signal: AbortSignal,
    options?: Parameters<typeof requestHindsight>[4],
  ) {
    return requestHindsight<T>(this.config, bank, route, signal, options, this.network);
  }

  async recall(
    request: SemanticMemoryRecallRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<SemanticMemoryResult[]>> {
    try {
      const banks = [this.bank(request.botId)];
      if (request.scope === "shared") {
        if (!this.config.sharedBankId)
          throw new HindsightRequestError(
            "Configure a shared Hindsight bank before enabling shared memory.",
          );
        banks.push(this.config.sharedBankId);
      }
      const signal = combineSignals(context.signal, AbortSignal.timeout(30_000));
      const results: SemanticMemoryResult[] = [];
      const seen = new Set<string>();
      for (const bank of new Set(banks)) {
        const response = await this.request<unknown>(bank, "memories/recall", signal, {
          method: "POST",
          body: {
            query: request.query,
            budget: "high",
            max_tokens: 4096,
            types: ["observation", "world", "experience"],
          },
        });
        const parsed = z
          .object({
            results: z.array(
              z.object({
                id: z.string(),
                text: z.string(),
                document_id: z.string().nullish(),
                mentioned_at: z.string().nullish(),
              }),
            ),
          })
          .parse(response);
        for (const fact of parsed.results) {
          if (seen.has(`${bank}:${fact.id}`)) continue;
          seen.add(`${bank}:${fact.id}`);
          const owned =
            fact.document_id?.startsWith(namespace(context, request.botId)) ||
            (bank === this.config.sharedBankId &&
              fact.document_id?.startsWith(namespace(context, request.botId, true)));
          results.push({
            memory: fact.text,
            score: 1,
            id: owned ? fact.document_id! : `memory:${fact.id}`,
            entity: bank,
            provenance: `Hindsight bank:${bank} fact:${fact.id}${fact.document_id ? ` document:${fact.document_id}` : ""}`,
            ...(fact.mentioned_at ? { updatedAt: fact.mentioned_at } : {}),
          });
        }
      }
      return { ok: true, value: results.slice(0, Math.max(0, request.limit)) };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  async save(
    request: SemanticMemorySaveRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse> {
    // Compaction is Rakazo-owned; do not ingest or later purge Hermes conversation history.
    if (request.source.kind === "history") return { ok: true, value: undefined };
    if (!this.config.allowWrites)
      return {
        ok: false,
        error: "Hindsight is recall only. Enable writing in Memory settings to save facts.",
      };
    let receipt = "";
    try {
      const mapped = this.bank(request.botId);
      const bank = request.scope === "shared" ? this.config.sharedBankId : mapped;
      if (!bank)
        throw new HindsightRequestError(
          "Configure a shared Hindsight bank before saving shared memory.",
        );
      const content = request.content.trim();
      if (!content || Buffer.byteLength(content) > 32 * 1024)
        throw new HindsightRequestError("Hindsight facts must contain between 1 and 32768 bytes.");
      const prefix = namespace(context, request.botId, request.scope === "shared");
      const documentId = `${prefix}${digest(content)}`;
      const hash = digest(JSON.stringify([bank, documentId, context.runId ?? context.operationId]));
      const operationId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20)}`;
      receipt = ` Operation: ${operationId}. Document: ${documentId}.`;
      const signal = combineSignals(context.signal, AbortSignal.timeout(120_000));
      try {
        const existing = documentSchema.parse(
          await this.request(bank, `documents/${documentId}`, signal),
        );
        if (
          existing.id !== documentId ||
          existing.bank_id !== bank ||
          existing.original_text !== content ||
          !existing.tags.includes(prefix) ||
          existing.memory_unit_count === 0
        ) {
          throw new HindsightRequestError(
            "An existing Hindsight source could not be verified. Reconcile it before saving again.",
          );
        }
        return { ok: true, value: undefined };
      } catch (error) {
        if (!(error instanceof HindsightRequestError && error.status === 404)) throw error;
      }
      let operation: z.infer<typeof operationSchema> | undefined;
      try {
        operation = operationSchema.parse(
          await this.request(bank, `operations/${operationId}`, signal),
        );
      } catch (error) {
        if (!(error instanceof HindsightRequestError && error.status === 404)) throw error;
      }
      if (operation && operation.operation_id !== operationId)
        throw new HindsightRequestError("Hindsight returned a different operation.");
      // Some Hindsight versions return 200/not_found rather than HTTP 404.
      if (operation?.status === "not_found") operation = undefined;
      if (!operation) {
        const admitted = z
          .object({
            success: z.literal(true),
            bank_id: z.literal(bank),
            items_count: z.literal(1),
            async: z.literal(true),
            operation_id: z.literal(operationId),
          })
          .parse(
            await this.request(bank, "memories", signal, {
              method: "POST",
              body: {
                async: true,
                operation_id: operationId,
                items: [
                  {
                    content,
                    document_id: documentId,
                    tags: [prefix],
                    metadata: { source: "rakazo" },
                  },
                ],
              },
            }),
          );
        if (!admitted.success) throw new HindsightRequestError("Hindsight did not admit the save.");
      }
      for (;;) {
        operation = operationSchema.parse(
          await this.request(bank, `operations/${operationId}`, signal),
        );
        if (operation.operation_id !== operationId)
          throw new HindsightRequestError("Hindsight returned a different operation.");
        const statuses = [
          operation.status,
          ...(operation.child_operations ?? []).map((child) => child.status),
        ];
        if (statuses.some((status) => ["failed", "cancelled", "not_found"].includes(status)))
          throw new HindsightRequestError(
            `Hindsight save was not completed. Operation: ${operationId}.`,
          );
        if (statuses.every((status) => status === "completed")) break;
        await delay(250, undefined, { signal });
      }
      const doc = documentSchema.parse(await this.request(bank, `documents/${documentId}`, signal));
      if (
        doc.id !== documentId ||
        doc.bank_id !== bank ||
        doc.original_text !== content ||
        doc.memory_unit_count === 0 ||
        !doc.tags.includes(prefix)
      ) {
        throw new HindsightRequestError(
          `Hindsight save could not be verified. Operation: ${operationId}.`,
        );
      }
      return { ok: true, value: undefined };
    } catch (error) {
      return { ok: false, error: `${errorMessage(error)}${receipt}` };
    }
  }

  async purgeHistory(
    _request: SemanticMemoryPurgeHistoryRequest,
    _context: AdapterContext,
  ): Promise<SemanticMemoryResponse> {
    // This adapter never stores compaction generations, so it has nothing to purge.
    return { ok: true, value: undefined };
  }

  async forget(
    request: SemanticMemoryForgetRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<{ id: string; expired: boolean; reason: string | null }>> {
    if (!this.config.allowWrites)
      return {
        ok: false,
        error: "Hindsight is recall only. Enable writing in Memory settings to forget facts.",
      };
    try {
      const bank = this.bank(context.botId ?? "");
      const targetBank = request.entity ?? bank;
      if (targetBank !== bank && targetBank !== this.config.sharedBankId)
        throw new HindsightRequestError("This bot cannot modify that Hindsight bank.");
      const prefixes = [
        ...(targetBank === bank ? [namespace(context, context.botId ?? "")] : []),
        ...(targetBank === this.config.sharedBankId
          ? [namespace(context, context.botId ?? "", true)]
          : []),
      ];
      const prefix = prefixes.find(
        (candidate) =>
          request.id.startsWith(candidate) &&
          /^[a-f0-9]{32}$/.test(request.id.slice(candidate.length)),
      );
      if (!prefix) {
        throw new HindsightRequestError(
          "Only documents saved by this Rakazo bot or shared scope can be forgotten. Hermes memories are preserved.",
        );
      }
      const signal = combineSignals(context.signal, AbortSignal.timeout(30_000));
      const route = `documents/${encodeURIComponent(request.id)}`;
      try {
        const doc = documentSchema.parse(await this.request(targetBank, route, signal));
        if (doc.id !== request.id || doc.bank_id !== targetBank || !doc.tags.includes(prefix))
          throw new HindsightRequestError("Hindsight document ownership could not be verified.");
      } catch (error) {
        if (error instanceof HindsightRequestError && error.status === 404)
          return {
            ok: true,
            value: { id: request.id, expired: true, reason: request.reason ?? null },
          };
        throw error;
      }
      z.object({ success: z.literal(true), document_id: z.literal(request.id) }).parse(
        await this.request(targetBank, route, signal, { method: "DELETE" }),
      );
      try {
        await this.request(targetBank, route, signal);
      } catch (error) {
        if (error instanceof HindsightRequestError && error.status === 404)
          return {
            ok: true,
            value: { id: request.id, expired: true, reason: request.reason ?? null },
          };
        throw error;
      }
      throw new HindsightRequestError(
        "Hindsight deletion was acknowledged but absence was not verified.",
      );
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }
}
