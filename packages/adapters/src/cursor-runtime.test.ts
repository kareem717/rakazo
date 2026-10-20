import { stat } from "node:fs/promises";
import type { AgentOptions, RunResult, SDKUserMessage, SendOptions, TokenUsage } from "@cursor/sdk";
import type { AgentRunRequest, AgentRuntimeEvent, ConnectorTool } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approvalPausedToolResult } from "./approval-effect.js";
import { probeCursorModels } from "./cursor-models.js";
import { PiAgentRuntime } from "./pi-runtime.js";

const fake = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  configs: [] as AgentOptions[],
  steps: [] as Array<{
    tools?: Array<{ name: string; args: Record<string, string | number | string[]> }>;
    text?: string;
    error?: string;
    waitForCancel?: boolean;
    usage?: TokenUsage[];
  }>,
  sends: [] as SDKUserMessage[],
  results: [] as unknown[],
  cancels: [] as ReturnType<typeof vi.fn>[],
  close: vi.fn(),
}));

vi.mock("@cursor/sdk", () => ({
  Agent: { create: fake.create },
  Cursor: { models: { list: fake.list } },
  JsonlLocalAgentStore: class {
    constructor(readonly root: string) {}
  },
}));

const shell: ConnectorTool = {
  name: "shell",
  description: "Run a command in the bot computer",
  inputSchema: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  },
};
const request = (overrides: Partial<AgentRunRequest> = {}): AgentRunRequest => ({
  botId: "bot-fixture",
  threadId: "thread-fixture",
  runId: "run-fixture",
  prompt: "List my notes.",
  instructions: "Help with the user's notes.",
  history: [],
  tools: [shell],
  model: { provider: "cursor", id: "composer-2.5", apiKey: "fake-cursor-user-key" },
  ...overrides,
});
const collect = async (events: AsyncIterable<AgentRuntimeEvent>) => {
  const result: AgentRuntimeEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
};

beforeEach(() => {
  fake.configs = [];
  fake.steps = [];
  fake.sends = [];
  fake.results = [];
  fake.cancels = [];
  fake.close.mockReset();
  fake.create.mockReset();
  fake.list.mockReset();
  fake.create.mockImplementation(async (config: AgentOptions) => {
    fake.configs.push(config);
    return {
      close: fake.close,
      async send(message: SDKUserMessage, options: SendOptions) {
        fake.sends.push(message);
        const step = fake.steps.shift() ?? { text: "Finished." };
        let cancelled = false;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const cancel = vi.fn(async () => {
          cancelled = true;
          release();
        });
        fake.cancels.push(cancel);
        let result: RunResult = { id: "cursor-run", status: "finished", result: step.text };
        return {
          id: "cursor-run",
          cancel,
          async *stream() {
            for (const [index, call] of (step.tools ?? []).entries()) {
              const tool = config.local?.customTools?.[call.name];
              if (!tool) throw new Error("Unknown custom tool");
              fake.results.push(await tool.execute(call.args, { toolCallId: `call-${index}` }));
              if (cancelled) break;
            }
            if (step.waitForCancel) await gate;
            if (step.error) throw new Error(step.error);
            if (!cancelled && step.text)
              await options.onDelta?.({ update: { type: "text-delta", text: step.text } });
            for (const usage of step.usage ?? []) yield { type: "usage", usage };
            if (cancelled) result = { id: "cursor-run", status: "cancelled" };
          },
          async wait() {
            return result;
          },
        };
      },
    };
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("Cursor as a main runtime through the shared provider entry point", () => {
  it("streams a reply and confines the SDK to executor-backed tools and isolated settings", async () => {
    fake.steps.push({
      tools: [{ name: "shell", args: { command: "ls notes" } }],
      text: "Two notes.",
    });
    const executeTool = vi.fn(async () => ({ stdout: "a.md b.md", code: 0 }));
    const events = await collect(new PiAgentRuntime().run(request({ executeTool })));
    expect(executeTool).toHaveBeenCalledWith(
      "shell",
      { command: "ls notes" },
      expect.any(String),
      undefined,
      expect.any(Object),
    );
    expect(events).toContainEqual({ type: "text", text: "Two notes." });
    expect(events.at(-1)).toEqual({ type: "done", text: "Two notes." });
    expect(fake.configs[0]).toMatchObject({
      apiKey: "fake-cursor-user-key",
      tools: ["mcp"],
      mcpServers: {},
      local: { settingSources: [], enableAgentRetries: false },
    });
    expect(fake.configs[0]?.systemPrompt).toBeUndefined();
    expect(Object.keys(fake.configs[0]?.local?.customTools ?? {})).toEqual(["shell"]);
    await expect(stat(fake.configs[0]!.local!.cwd!)).rejects.toThrow();
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it("uses the executor's approved route, normalized arguments and image results", async () => {
    fake.steps.push({
      tools: [{ name: "workspace_search", args: { query: "notes" } }],
      text: "Found.",
    });
    const route = { connectorId: "mcp", resourceId: "server-fixture", toolName: "search" };
    const executeTool = vi.fn(async () => ({
      kind: "agent_tool_result",
      content: [{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" }],
      details: {},
    }));
    await collect(
      new PiAgentRuntime().run(
        request({
          executeTool,
          tools: [
            {
              name: "workspace.search",
              description: "Search",
              inputSchema: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
              },
              route,
            },
          ],
        }),
      ),
    );
    expect(executeTool).toHaveBeenCalledWith(
      "workspace.search",
      { query: "notes" },
      expect.any(String),
      route,
      expect.any(Object),
    );
    expect(fake.results[0]).toMatchObject({
      content: [{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" }],
    });
  });

  it("stops for approval without running the next effect or claiming a final answer", async () => {
    fake.steps.push({
      tools: [
        { name: "shell", args: { command: "first" } },
        { name: "shell", args: { command: "second" } },
      ],
      text: "Should not be emitted.",
    });
    const executeTool = vi.fn(async () => approvalPausedToolResult());
    const events = await collect(new PiAgentRuntime().run(request({ executeTool })));
    expect(executeTool).toHaveBeenCalledOnce();
    expect(fake.cancels[0]).toHaveBeenCalled();
    expect(events.some((event) => event.type === "text")).toBe(false);
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("uses the shared user-choice pause behavior", async () => {
    fake.steps.push({
      tools: [{ name: "ask_user", args: { question: "Which folder?", options: ["Work", "Home"] } }],
    });
    const events = await collect(
      new PiAgentRuntime().run(
        request({ tools: [{ name: "ask_user", description: "Ask the user", inputSchema: {} }] }),
      ),
    );
    expect(events).toContainEqual({
      type: "ask",
      text: "Which folder?",
      actions: [
        { id: "choice-1", label: "Work" },
        { id: "choice-2", label: "Home" },
      ],
    });
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("enforces the shared tool-call limit", async () => {
    vi.stubEnv("MAX_TOOL_CALLS_PER_TURN", "1");
    fake.steps.push({
      tools: [
        { name: "shell", args: { command: "first" } },
        { name: "shell", args: { command: "second" } },
      ],
    });
    const executeTool = vi.fn(async () => ({ ok: true }));
    const events = await collect(new PiAgentRuntime().run(request({ executeTool })));
    expect(executeTool).toHaveBeenCalledOnce();
    expect(events.at(-1)).toMatchObject({
      type: "done",
      text: expect.stringContaining("limit of 1 tool calls"),
    });
  });

  it("accounts each usage event once and keeps unknown cost unknown", async () => {
    const usage = {
      inputTokens: 12,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheWriteTokens: 0,
      totalTokens: 20,
    };
    fake.steps.push({ text: "Done.", usage: [usage, usage] });
    const onUsage = vi.fn();
    const events = await collect(new PiAgentRuntime().run(request({ onUsage })));
    expect(onUsage).toHaveBeenCalledTimes(2);
    expect(events.filter((event) => event.type === "usage")).toEqual([
      expect.objectContaining({ type: "usage", inputTokens: 12, costUsd: null, accounted: true }),
      expect.objectContaining({ type: "usage", inputTokens: 12, costUsd: null, accounted: true }),
    ]);
  });

  it("includes instructions, prior conversation, images and durable steering", async () => {
    const claimSteering = vi
      .fn()
      .mockResolvedValueOnce([{ id: "steer-1", messageId: "message-steer", text: "Use Work." }])
      .mockResolvedValue([]);
    await collect(
      new PiAgentRuntime().run(
        request({
          sourceMessageId: "message-current",
          claimSteering,
          history: [
            { id: "message-prior", role: "assistant", content: "Earlier reply." },
            { id: "message-current", role: "user", content: "List my notes." },
          ],
          currentTurnImages: [
            { name: "image.png", mimeType: "image/png", data: new Uint8Array([1, 2]) },
          ],
        }),
      ),
    );
    expect(fake.sends[0]?.text).toContain("Help with the user's notes.");
    expect(fake.sends[0]?.text).toContain("Earlier reply.");
    expect(fake.sends[0]?.text.match(/List my notes/g)).toHaveLength(1);
    expect(fake.sends[0]?.text).toContain("Use Work.");
    expect(fake.sends[0]?.images).toEqual([{ data: "AQI=", mimeType: "image/png" }]);
    expect(claimSteering).toHaveBeenLastCalledWith(["steer-1"]);
  });

  it("redacts provider credentials from failures and removes transient state", async () => {
    fake.steps.push({ error: "rejected fake-cursor-user-key" });
    await expect(collect(new PiAgentRuntime().run(request()))).rejects.toThrow(
      "rejected [redacted]",
    );
    await expect(stat(fake.configs[0]!.local!.cwd!)).rejects.toThrow();
  });

  it("never falls back to an ambient account when a scoped key is missing", async () => {
    await expect(
      collect(
        new PiAgentRuntime().run(request({ model: { provider: "cursor", id: "composer-2.5" } })),
      ),
    ).rejects.toThrow("Connect Cursor");
    expect(fake.create).not.toHaveBeenCalled();
  });

  it.each(["return", "abort", "signal"])(
    "cancels a quiet SDK run via %s without waiting for a model response",
    async (method) => {
      fake.steps.push({ waitForCancel: true });
      const runtime = new PiAgentRuntime();
      const controller = new AbortController();
      const stream = runtime.run(request(), { signal: controller.signal });
      const pending = stream.next();
      await vi.waitFor(() => expect(fake.sends).toHaveLength(1));
      if (method === "return") await stream.return!();
      else if (method === "abort") await runtime.abort("run-fixture");
      else controller.abort();
      await pending;
      await stream.return!();
      expect(fake.cancels[0]).toHaveBeenCalled();
      expect(fake.close).toHaveBeenCalled();
      await expect(stat(fake.configs[0]!.local!.cwd!)).rejects.toThrow();
    },
  );

  it("retains prior conversation when messages have no IDs", async () => {
    await collect(
      new PiAgentRuntime().run(
        request({
          history: [
            { role: "user", content: "Earlier question." },
            { role: "assistant", content: "Earlier reply." },
            { role: "user", content: "List my notes." },
          ],
        }),
      ),
    );
    expect(fake.sends[0]?.text).toContain("Earlier question.");
    expect(fake.sends[0]?.text).toContain("Earlier reply.");
    expect(fake.sends[0]?.text.match(/List my notes/g)).toHaveLength(1);
  });

  it("runs helpers with the same restricted tools and keeps their text out of the main reply", async () => {
    fake.steps.push(
      {
        tools: [{ name: "run_subagent", args: { name: "Finder", task: "Find notes" } }],
        text: "Main answer.",
      },
      { tools: [{ name: "shell", args: { command: "ls notes" } }], text: "Helper answer." },
    );
    const executeTool = vi.fn(async () => ({ stdout: "notes", code: 0 }));
    const events = await collect(
      new PiAgentRuntime().run(
        request({
          executeTool,
          tools: [shell, { name: "run_subagent", description: "Run a helper", inputSchema: {} }],
        }),
      ),
    );
    expect(fake.configs).toHaveLength(2);
    expect(Object.keys(fake.configs[1]?.local?.customTools ?? {})).toEqual(["shell"]);
    expect(events.filter((event) => event.type === "text")).toEqual([
      { type: "text", text: "Main answer." },
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "subagent",
        name: "Finder",
        status: "completed",
        result: "Helper answer.",
      }),
    );
    expect(events.filter((event) => event.type === "done")).toHaveLength(1);
  });

  it("propagates a helper's approval pause to the main agent", async () => {
    fake.steps.push(
      {
        tools: [{ name: "run_subagent", args: { name: "Finder", task: "Find notes" } }],
        text: "Should not run.",
      },
      { tools: [{ name: "shell", args: { command: "ls notes" } }], text: "Should not run." },
    );
    const events = await collect(
      new PiAgentRuntime().run(
        request({
          executeTool: vi.fn(async () => approvalPausedToolResult()),
          tools: [shell, { name: "run_subagent", description: "Run a helper", inputSchema: {} }],
        }),
      ),
    );
    expect(fake.cancels.every((cancel) => cancel.mock.calls.length > 0)).toBe(true);
    expect(events.some((event) => event.type === "text")).toBe(false);
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("validates arguments before they reach the executor", async () => {
    fake.steps.push({ tools: [{ name: "strict_query", args: {} }] });
    const executeTool = vi.fn();
    await expect(
      collect(
        new PiAgentRuntime().run(
          request({
            executeTool,
            tools: [
              {
                name: "strict_query",
                description: "Search",
                inputSchema: {
                  type: "object",
                  properties: { query: { type: "string" } },
                  required: ["query"],
                },
              },
            ],
          }),
        ),
      ),
    ).rejects.toThrow();
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("fails before inference when a caller requires per-model-call budget reservations", async () => {
    const beforeCall = vi.fn();
    const runtime = new PiAgentRuntime({ modelCallObserver: { beforeCall, afterCall: vi.fn() } });
    await expect(collect(runtime.run(request()))).rejects.toThrow(
      "per-model-call budget reservations",
    );
    expect(fake.create).not.toHaveBeenCalled();
    expect(beforeCall).not.toHaveBeenCalled();
  });

  it("does not discover models through ambient credentials", async () => {
    await expect(probeCursorModels(" ")).rejects.toThrow("user API key is required");
    expect(fake.list).not.toHaveBeenCalled();
  });

  it("discovers the key's models without changing global SDK settings", async () => {
    fake.list.mockResolvedValue([
      { id: "composer-2.5" },
      { id: "allowed-model" },
      { id: "allowed-model" },
    ]);
    await expect(probeCursorModels("fake-user-key")).resolves.toEqual([
      "composer-2.5",
      "allowed-model",
    ]);
    expect(fake.list).toHaveBeenCalledWith({ apiKey: "fake-user-key" });
  });
});
