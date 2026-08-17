import type { Usage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/agent-manager.ts";
import { registerSubagentTools, type SubagentToolDetails } from "../src/tools.ts";
import type {
  AgentOutcome,
  AgentRecord,
  ClaimedOutcome,
  StartResult,
} from "../src/types.ts";
import { fixedManifest, usage } from "./helpers/fakes.ts";

type RegisteredTool = ToolDefinition<any, SubagentToolDetails>;

function outcome(
  state: AgentOutcome["state"] = "completed",
  overrides: Partial<AgentOutcome> = {},
): AgentOutcome {
  return {
    agentId: "sa_00000001",
    runId: "run_00000001",
    state,
    finalText: `terminal text for ${state}`,
    sessionFile: "/sessions/child.jsonl",
    childLeafId: "leaf_done",
    usage: usage(10, 4),
    startedAt: 1_000,
    settledAt: 2_000,
    manifest: fixedManifest,
    ...overrides,
  };
}

function record(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "sa_00000001",
    description: "implement task",
    cwd: "/repo",
    model: "fake/worker",
    thinkingLevel: "off",
    state: "completed",
    sessionFile: "/sessions/child.jsonl",
    childLeafId: "leaf_done",
    manifest: fixedManifest,
    createdAt: 1_000,
    updatedAt: 2_000,
    runs: [
      {
        runId: "run_00000001",
        index: 1,
        promptSha256: "a".repeat(64),
        startedAt: 1_000,
        settledAt: 2_000,
        usage: usage(10, 4),
        usageClaimed: false,
        childLeafId: "leaf_done",
      },
    ],
    ...overrides,
  };
}

function fakeManager() {
  const completed: ClaimedOutcome = { outcome: outcome(), claimedUsage: usage(10, 4) };
  const started: StartResult = {
    agentId: "sa_00000001",
    runId: "run_00000001",
    state: "working",
  };
  return {
    run: vi.fn(async () => completed),
    start: vi.fn(async () => started),
    wait: vi.fn(async () => completed),
    resume: vi.fn(async () => completed),
    abort: vi.fn(async () => record({ state: "aborted" })),
    list: vi.fn(() => [record()]),
    get: vi.fn(() => record()),
  };
}

function context(
  mode: ExtensionContext["mode"] = "tui",
  trusted = true,
): ExtensionContext {
  return {
    mode,
    cwd: "/repo",
    signal: undefined,
    sessionManager: {
      getSessionId: () => "parent-session",
    },
    isProjectTrusted: () => trusted,
  } as unknown as ExtensionContext;
}

function fixture(manager = fakeManager()) {
  const tools: RegisteredTool[] = [];
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
  const pi = {
    registerTool: (definition: RegisteredTool) => tools.push(definition),
    on: (name: string, handler: (event: any, ctx: ExtensionContext) => unknown) => {
      const values = handlers.get(name) ?? [];
      values.push(handler);
      handlers.set(name, values);
    },
  } as unknown as ExtensionAPI;
  registerSubagentTools(pi, () => manager as unknown as AgentManager);
  const tool = (name: string): RegisteredTool => {
    const value = tools.find((candidate) => candidate.name === name);
    if (!value) throw new Error(`Missing tool ${name}`);
    return value;
  };
  const execute = (
    name: string,
    params: Record<string, unknown>,
    ctx = context(),
    signal?: AbortSignal,
  ) => tool(name).execute("call_1", params, signal, undefined, ctx);
  return { manager, tools, handlers, tool, execute };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("registerSubagentTools", () => {
  it("registers the six tools in stable order with Superpowers guidance", () => {
    const { tools, tool } = fixture();

    expect(tools.map((value) => value.name)).toEqual([
      "subagent_run",
      "subagent_start",
      "subagent_wait",
      "subagent_resume",
      "subagent_abort",
      "subagent_list",
    ]);
    expect(tool("subagent_run").promptGuidelines).toEqual(
      expect.arrayContaining([
        expect.stringContaining("fix rounds 1-3"),
        expect.stringContaining("fresh subagent_run"),
        expect.stringContaining("Never copy controller conversation history"),
      ]),
    );
    for (const value of tools) {
      expect(value.label).toMatch(/^Subagent /);
      expect(value.promptSnippet).toBeTruthy();
    }
  });

  it("uses strict schemas that reject multiline descriptions bad ids and extra fields", () => {
    const { tool } = fixture();
    const validDispatch = {
      description: "implement task",
      prompt: "Do the work",
      model: "fake/worker",
    };

    expect(Value.Check(tool("subagent_run").parameters, validDispatch)).toBe(true);
    expect(
      Value.Check(tool("subagent_run").parameters, {
        ...validDispatch,
        description: "line one\nline two",
      }),
    ).toBe(false);
    expect(Value.Check(tool("subagent_run").parameters, { ...validDispatch, extra: true })).toBe(false);
    expect(Value.Check(tool("subagent_wait").parameters, { agentId: "sa_1234abcd" })).toBe(true);
    expect(Value.Check(tool("subagent_wait").parameters, { agentId: "SA_1234ABCD" })).toBe(false);
    expect(
      Value.Check(tool("subagent_resume").parameters, {
        agentId: "sa_1234abcd",
        prompt: "fix",
        model: "forbidden/mutation",
      }),
    ).toBe(false);
    expect(Value.Check(tool("subagent_list").parameters, {})).toBe(true);
    expect(Value.Check(tool("subagent_list").parameters, { extra: true })).toBe(false);
  });

  it("maps every tool to the exact manager operation and execution-time scope", async () => {
    const { manager, execute } = fixture();
    const signal = new AbortController().signal;
    const ctx = context("rpc", false);
    const getSessionId = vi.fn(() => "parent-session");
    (ctx.sessionManager as unknown as { getSessionId(): string }).getSessionId = getSessionId;
    const startContext = context("tui", false);
    const startGetSessionId = vi.fn(() => "parent-session");
    (startContext.sessionManager as unknown as { getSessionId(): string }).getSessionId =
      startGetSessionId;
    const dispatch = {
      description: "implement task",
      prompt: "work",
      model: "fake/worker",
      cwd: "src",
    };

    await execute("subagent_run", dispatch, ctx, signal);
    await execute("subagent_start", dispatch, startContext, signal);
    await execute("subagent_wait", { agentId: "sa_00000001" }, ctx, signal);
    await execute(
      "subagent_resume",
      { agentId: "sa_00000001", prompt: "fix" },
      ctx,
      signal,
    );
    await execute("subagent_abort", { agentId: "sa_00000001" }, ctx, signal);
    await execute("subagent_list", {}, ctx, signal);

    const expectedScope = {
      parentSessionId: "parent-session",
      cwd: "/repo",
      projectTrusted: false,
      mode: "rpc",
    };
    expect(manager.run).toHaveBeenCalledWith(dispatch, expectedScope, signal);
    expect(manager.start).toHaveBeenCalledWith(dispatch, {
      ...expectedScope,
      mode: "tui",
    });
    expect(manager.wait).toHaveBeenCalledWith("sa_00000001", signal);
    expect(manager.resume).toHaveBeenCalledWith("sa_00000001", "fix", expectedScope, signal);
    expect(manager.abort).toHaveBeenCalledWith("sa_00000001");
    expect(manager.list).toHaveBeenCalled();
    expect(getSessionId).toHaveBeenCalledTimes(5);
    expect(startGetSessionId).toHaveBeenCalledOnce();
  });

  it("rejects background start in print and json while keeping foreground run available", async () => {
    const { manager, execute } = fixture();
    const dispatch = {
      description: "implement task",
      prompt: "work",
      model: "fake/worker",
    };

    for (const mode of ["print", "json"] as const) {
      const result = await execute("subagent_start", dispatch, context(mode));
      expect(result.details).toMatchObject({
        operation: "subagent_start",
        infrastructureError: true,
      });
    }
    expect(manager.start).not.toHaveBeenCalled();

    const foreground = await execute("subagent_run", dispatch, context("print"));
    expect(foreground.details).toMatchObject({ operation: "subagent_run", state: "completed" });
    expect(manager.run).toHaveBeenCalledOnce();
  });

  it("returns compact start and duration-aware transcript-free list content", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T00:02:05.000Z"));
    const manager = fakeManager();
    const now = Date.now();
    manager.list.mockReturnValue([
      record({
        id: "sa_00000001",
        state: "working",
        createdAt: now - 65_000,
        updatedAt: now - 65_000,
        runs: [
          {
            runId: "run_1",
            index: 1,
            promptSha256: "a".repeat(64),
            startedAt: now - 65_000,
            usageClaimed: false,
          },
        ],
      }),
      record({
        id: "sa_00000002",
        description: "review task",
        updatedAt: Date.parse("2026-08-15T23:59:00.000Z"),
        runs: [
          {
            runId: "run_2",
            index: 1,
            promptSha256: "b".repeat(64),
            startedAt: Date.parse("2026-08-15T23:58:00.000Z"),
            settledAt: Date.parse("2026-08-15T23:59:00.000Z"),
            usageClaimed: true,
          },
        ],
      }),
    ]);
    const { execute } = fixture(manager);

    const started = await execute(
      "subagent_start",
      { description: "implement", prompt: "work", model: "fake/worker" },
    );
    expect(started.content).toEqual([
      { type: "text", text: "agent_id: sa_00000001\nstatus: working" },
    ]);

    const listed = await execute("subagent_list", {});
    const text = listed.content[0]?.type === "text" ? listed.content[0].text : "";
    expect(text).toContain(
      "sa_00000001 | working | implement task | fake/worker | runs:1 | elapsed:1m 5s",
    );
    expect(text).toContain(
      "sa_00000002 | completed | review task | fake/worker | runs:1 | settled:2026-08-15T23:59:00.000Z",
    );
    expect(text).not.toContain("terminal text");
    expect(JSON.stringify(listed.details)).not.toContain("terminal text");
  });

  it("returns terminal usage and metadata in details without final text or transcripts", async () => {
    const { execute } = fixture();

    const result = await execute(
      "subagent_run",
      { description: "implement", prompt: "work", model: "fake/worker" },
    );
    const details = result.details as SubagentToolDetails;

    expect(result.usage).toEqual(usage(10, 4));
    expect(details).toMatchObject({
      operation: "subagent_run",
      agentId: "sa_00000001",
      state: "completed",
      outcome: {
        runId: "run_00000001",
        sessionFile: "/sessions/child.jsonl",
        childLeafId: "leaf_done",
        usage: usage(10, 4),
        manifest: fixedManifest,
      },
    });
    expect(details.outcome).not.toHaveProperty("finalText");
    expect(details).not.toHaveProperty("records");
    expect(JSON.stringify(details)).not.toContain("terminal text for completed");
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("terminal text for completed"),
    });
  });

  it("marks only infrastructure failures through the tool_result hook", async () => {
    const manager = fakeManager();
    const { execute, handlers } = fixture(manager);
    const hook = handlers.get("tool_result")?.[0];
    if (!hook) throw new Error("Missing tool_result hook");
    const dispatch = { description: "work", prompt: "work", model: "fake/worker" };

    for (const state of ["completed", "needs_context", "blocked", "aborted"] as const) {
      manager.run.mockResolvedValueOnce({ outcome: outcome(state) });
      const result = await execute("subagent_run", dispatch);
      expect(result.details).not.toHaveProperty("infrastructureError", true);
      const hookResult = await hook(
        {
          type: "tool_result",
          toolName: "subagent_run",
          toolCallId: "call_1",
          input: dispatch,
          content: result.content,
          details: result.details,
          ...(result.usage === undefined ? {} : { usage: result.usage }),
          isError: false,
        } satisfies ToolResultEvent,
        context(),
      );
      expect(hookResult).toBeUndefined();
    }

    manager.run.mockResolvedValueOnce({
      outcome: outcome("failed", { error: "provider down", finalText: "" }),
      claimedUsage: usage(2, 1),
    });
    const providerFailure = await execute("subagent_run", dispatch);
    expect(providerFailure.details).toMatchObject({ infrastructureError: true });
    expect(
      await hook(
        {
          type: "tool_result",
          toolName: "subagent_run",
          toolCallId: "call_2",
          input: dispatch,
          content: providerFailure.content,
          details: providerFailure.details,
          ...(providerFailure.usage === undefined ? {} : { usage: providerFailure.usage }),
          isError: false,
        } satisfies ToolResultEvent,
        context(),
      ),
    ).toEqual({ isError: true });

    manager.run.mockRejectedValueOnce(new Error("setup failed"));
    const setupFailure = await execute("subagent_run", dispatch);
    expect(setupFailure.details).toMatchObject({ infrastructureError: true, error: "setup failed" });

    const foreign = await hook(
      {
        type: "tool_result",
        toolName: "another_tool",
        toolCallId: "call_3",
        input: {},
        content: [],
        details: { infrastructureError: true },
        isError: false,
      },
      context(),
    );
    expect(foreign).toBeUndefined();
  });

  it("returns no-roster copy when the branch has no agents", async () => {
    const manager = fakeManager();
    manager.list.mockReturnValue([]);
    const { execute } = fixture(manager);

    const result = await execute("subagent_list", {});
    expect(result.content).toEqual([
      { type: "text", text: "No subagents in this controller branch" },
    ]);
    expect(result.details).toEqual({ operation: "subagent_list", records: [] });
  });
});
