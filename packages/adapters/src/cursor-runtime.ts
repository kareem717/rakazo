import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentOptions, Run, SDKAgent, SDKCustomTool, SDKJsonValue } from "@cursor/sdk";
import { validateToolCall } from "@earendil-works/pi-ai/utils/validation";
import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  AgentUsage,
} from "@rakazo/adapter-kit";
import { redactSecrets } from "@rakazo/core";
import { DELEGATION_TOOL_NAMES } from "./builtin-tools.js";
import { CURSOR_MANAGED_LIMITS_MESSAGE } from "./cursor-models.js";
import {
  createGate,
  createQueue,
  createRuntimeToolSession,
  MISSING_TOOL_FINAL_RESPONSE_ERROR,
  priorRuntimeHistory,
  withoutSteeringMessages,
} from "./pi-runtime.js";
import { sanitizeSensitiveText } from "./runtime-errors.js";

type ToolBudget = ReturnType<typeof createRuntimeToolSession>["budget"];

type RuntimeOptions = {
  runOtherModel: AgentRuntime["run"];
};

/** The optional Cursor agent loop, confined to Rakazo's executor-backed tools. */
export class CursorAgentRuntime implements AgentRuntime {
  private readonly running = new Map<
    string,
    { controller: AbortController; work: Promise<void> }
  >();

  constructor(private readonly options: RuntimeOptions) {}

  describe() {
    return {
      id: "cursor",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { streaming: true, compaction: false, tools: true, scripted: false },
    };
  }

  async abort(runId: string) {
    const active = this.running.get(runId);
    active?.controller.abort();
    await active?.work;
  }

  run(
    request: AgentRunRequest,
    context?: Partial<AdapterContext>,
  ): AsyncIterableIterator<AgentRuntimeEvent> {
    return this.start(request, context);
  }

  private start(
    request: AgentRunRequest,
    context?: Partial<AdapterContext>,
    budget?: ToolBudget,
  ): AsyncIterableIterator<AgentRuntimeEvent> {
    const controller = new AbortController();
    const events = this.runEvents(request, controller, context, budget);
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => events.next(),
      return: () => {
        controller.abort();
        return events.return();
      },
      throw: (error) => {
        controller.abort();
        return events.throw(error);
      },
    };
  }

  private async *runEvents(
    request: AgentRunRequest,
    controller: AbortController,
    context?: Partial<AdapterContext>,
    budget?: ToolBudget,
  ): AsyncGenerator<AgentRuntimeEvent, void> {
    const signal = context?.signal
      ? AbortSignal.any([controller.signal, context.signal])
      : controller.signal;
    const queue = createQueue();
    const subagentGate = createGate(4);
    let agent: SDKAgent | undefined;
    let run: Run | undefined;
    let stopped = false;
    const cancel = () => {
      stopped = true;
      void run?.cancel().catch(() => undefined);
    };
    const tools = createRuntimeToolSession({
      request,
      signal,
      budget,
      namespace: request.runId,
      push: (event) => queue.push(event),
      abortTurn: cancel,
      runSubagent: async (id, args) => {
        await subagentGate.acquire();
        try {
          signal.throwIfAborted();
          return await this.subagent(
            request,
            context,
            signal,
            id,
            args,
            (event) => queue.push(event),
            tools.budget,
            () => {
              tools.pause();
              cancel();
            },
          );
        } finally {
          subagentGate.release();
        }
      },
    });
    signal.addEventListener("abort", cancel, { once: true });
    const work = (async () => {
      let root: string | undefined;
      try {
        signal.throwIfAborted();
        if (request.model.maxTokens != null || request.model.contextWindow != null) {
          throw new Error(CURSOR_MANAGED_LIMITS_MESSAGE);
        }
        if (!request.model.apiKey?.trim())
          throw new Error("Connect Cursor with a user API key first.");
        // No shared SDK state, ambient credentials, plugins, project settings or native tools.
        root = await mkdtemp(join(tmpdir(), "rakazo-cursor-"));
        const { Agent, JsonlLocalAgentStore } = await import("@cursor/sdk");
        const customTools: Record<string, SDKCustomTool> = Object.fromEntries(
          tools.tools.map((tool) => [
            tool.name,
            {
              description: tool.description,
              inputSchema: JSON.parse(JSON.stringify(tool.parameters)) as Record<
                string,
                SDKJsonValue
              >,
              execute: async (args, invocation) => {
                signal.throwIfAborted();
                if (stopped || tools.paused || tools.budgetExceeded)
                  throw new Error("This turn has stopped.");
                const id = invocation.toolCallId || randomUUID();
                const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
                const validated = validateToolCall([tool], {
                  type: "toolCall",
                  id,
                  name: tool.name,
                  arguments: prepared as Record<string, SDKJsonValue>,
                });
                const result = await tool.execute(id, validated, signal);
                if (tools.paused || tools.budgetExceeded) cancel();
                return {
                  content: result.content,
                  isError:
                    result.details != null &&
                    typeof result.details === "object" &&
                    (("error" in result.details && result.details.error != null) ||
                      ("isError" in result.details && result.details.isError === true)),
                };
              },
            } satisfies SDKCustomTool,
          ]),
        );
        const config: AgentOptions = {
          apiKey: request.model.apiKey,
          model: { id: request.model.id },
          tools: ["mcp"],
          mcpServers: {},
          local: {
            cwd: root,
            store: new JsonlLocalAgentStore(join(root, "state")),
            settingSources: [],
            customTools,
            enableAgentRetries: false,
          },
        };
        signal.throwIfAborted();
        agent = await Agent.create(config);
        signal.throwIfAborted();
        const seenSteering: string[] = [];
        const initialSteering = (await request.claimSteering?.([])) ?? [];
        seenSteering.push(...initialSteering.map((item) => item.id));
        const history = priorRuntimeHistory(
          withoutSteeringMessages(request.history, initialSteering),
          request.prompt,
          request.sourceMessageId,
        );
        let prompt = [
          request.instructions,
          history.length
            ? `Conversation history (JSON):\n${JSON.stringify(history.map(({ role, content }) => ({ role, content })))}`
            : "",
          `Current user request:\n${request.prompt}`,
          ...initialSteering.map((item) => item.text),
        ]
          .filter(Boolean)
          .join("\n\n");
        let images = [
          ...history.flatMap((item) => item.images ?? []),
          ...(request.currentTurnImages ?? []),
          ...initialSteering.flatMap((item) => item.images ?? []),
        ];
        let fullText = "";
        while (!stopped) {
          signal.throwIfAborted();
          const before = fullText.length;
          try {
            run = await agent.send(
              {
                text: prompt,
                images: images.map((image) => ({
                  data: Buffer.from(image.data).toString("base64"),
                  mimeType: image.mimeType,
                })),
              },
              {
                onDelta: ({ update }) => {
                  if (stopped) return;
                  if (update.type === "text-delta") {
                    fullText += update.text;
                    queue.push({ type: "text", text: update.text });
                  } else if (update.type === "thinking-delta") {
                    queue.push({ type: "progress", text: update.text, reasoning: true });
                  }
                },
              },
            );
            if (stopped || signal.aborted) await run.cancel();
            // The stream carries once-per-model-turn usage; Run.usage is cumulative.
            for await (const message of run.stream()) {
              if (message.type !== "usage") continue;
              const turnUsage: AgentUsage = {
                ...message.usage,
                costUsd: null,
                costSource: null,
                usageSource: "cursor-sdk",
              };
              const event: Extract<AgentRuntimeEvent, { type: "usage" }> = {
                type: "usage",
                provider: request.model.provider,
                model: request.model.id,
                operationKind: request.usageOperationKind ?? "answer",
                ...turnUsage,
              };
              await request.onUsage?.(event);
              queue.push({ ...event, ...(request.onUsage ? { accounted: true } : {}) });
            }
            const result = await run.wait();
            if (!stopped && result.status !== "finished")
              throw new Error(result.error?.message || "Cursor did not complete the run.");
            if (!stopped && result.result && fullText.length === before) {
              fullText += result.result;
              queue.push({ type: "text", text: result.result });
            }
          } finally {
            run = undefined;
          }
          if (stopped || tools.paused) break;
          const followUps: string[] = [];
          await tools.finishShells((text) => followUps.push(text));
          const steering = (await request.claimSteering?.(seenSteering)) ?? [];
          seenSteering.push(...steering.map((item) => item.id));
          followUps.push(...steering.map((item) => item.text));
          if (!followUps.length) break;
          prompt = followUps.join("\n\n");
          images = steering.flatMap((item) => item.images ?? []);
        }
        if (tools.budgetExceeded) {
          const text = `${fullText ? "\n\n" : ""}${tools.budgetMessage}`;
          fullText += text;
          queue.push({ type: "text", text });
        }
        if (!fullText.trim() && !tools.paused && !stopped && !request.allowSilentEmpty) {
          throw new Error(MISSING_TOOL_FINAL_RESPONSE_ERROR);
        }
        queue.push(fullText.trim() ? { type: "done", text: fullText } : { type: "done" });
      } catch (error) {
        if (signal.aborted) queue.push({ type: "done", text: "stopped" });
        else if (tools.paused || tools.budgetExceeded) queue.push({ type: "done" });
        else
          queue.fail(
            new Error(
              redactSecrets(
                sanitizeSensitiveText(error instanceof Error ? error.message : String(error)),
                [request.model.apiKey ?? ""],
              ),
            ),
          );
      } finally {
        signal.removeEventListener("abort", cancel);
        try {
          try {
            agent?.close();
          } finally {
            if (root) await rm(root, { recursive: true, force: true });
          }
        } finally {
          tools.close();
          queue.close();
        }
      }
    })().catch((error: unknown) => {
      queue.fail(
        new Error(
          redactSecrets(
            sanitizeSensitiveText(error instanceof Error ? error.message : String(error)),
            [request.model.apiKey ?? ""],
          ),
        ),
      );
    });
    const active = { controller, work };
    this.running.set(request.runId, active);
    try {
      yield* queue.iterate();
    } finally {
      controller.abort();
      await work;
      if (this.running.get(request.runId) === active) this.running.delete(request.runId);
    }
  }

  private async subagent(
    request: AgentRunRequest,
    context: Partial<AdapterContext> | undefined,
    signal: AbortSignal,
    executionId: string,
    args: Record<string, unknown>,
    push: (event: AgentRuntimeEvent) => void,
    budget: ToolBudget,
    pause: () => void,
  ): Promise<string> {
    const name = String(args.name || "helper");
    const task = String(args.task || "");
    const agentId = executionId;
    push({ type: "subagent", agentId, name, task, status: "running" });
    try {
      if (Boolean(args.model_provider) !== Boolean(args.model_id))
        throw new Error("model_provider and model_id must both be set");
      const provider = String(args.model_provider || request.model.provider);
      const id = String(args.model_id || request.model.id);
      const model =
        provider === request.model.provider && id === request.model.id
          ? request.model
          : await request.resolveModel?.(provider, id);
      if (!model) throw new Error("The helper model is not connected.");
      const child: AgentRunRequest = {
        ...request,
        runId: `${request.runId}:${randomUUID()}`,
        instructions: `${request.instructions}\nYou are a helper named ${name}. Complete the task and return a concise result.\n${String(args.instructions || "")}`,
        prompt: task,
        history: [],
        currentTurnImages: undefined,
        claimSteering: undefined,
        sourceMessageId: undefined,
        resumeFromCheckpoint: undefined,
        model,
        fallbackModels: [],
        usageOperationKind: "subagent",
        onUsage: request.onUsage ? (event) => request.onUsage!({ ...event, agentId }) : undefined,
        onToolCompleted: (completion) => {
          if (completion.paused) pause();
          return request.onToolCompleted?.(completion);
        },
        tools: request.tools.filter((tool) => !DELEGATION_TOOL_NAMES.has(tool.name)),
      };
      const events =
        model.provider === "cursor"
          ? this.start(child, { ...context, signal }, budget)
          : this.options.runOtherModel(child, { ...context, signal });
      let result = "";
      for await (const event of events) {
        if (event.type === "text") result += event.text;
        else if (event.type === "done") {
          if (event.text) result = event.text;
        } else if (event.type === "usage") push({ ...event, agentId });
        else if (event.type !== "progress") push(event);
      }
      push({ type: "subagent", agentId, name, task, status: "completed", result });
      return result;
    } catch (error) {
      const result = redactSecrets(
        sanitizeSensitiveText(error instanceof Error ? error.message : String(error)),
        [request.model.apiKey ?? ""],
      );
      push({ type: "subagent", agentId, name, task, status: "failed", result });
      return `Helper failed: ${result}`;
    }
  }
}
