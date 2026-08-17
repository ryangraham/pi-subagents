import type {
  ExtensionAPI,
  ExtensionContext,
  ModelRuntime,
  SessionEntry,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSubagentsExtension } from "../src/index.ts";
import type { SessionFactory } from "../src/session-factory.ts";
import {
  CUSTOM_ENTRY_TYPE,
  REGISTRY_VERSION,
  type AgentRecord,
  type RegistryEvent,
} from "../src/types.ts";
import { FakeAgentSession, fakeBundle, fixedManifest, usage } from "./helpers/fakes.ts";

const trackedSessions = new Set<FakeAgentSession>();
afterEach(() => {
  for (const session of trackedSessions) session.cleanup();
  trackedSessions.clear();
});

function childSession(): FakeAgentSession {
  const child = new FakeAgentSession();
  trackedSessions.add(child);
  return child;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function branchEntries(
  agentId: string,
  state: "working" | "completed" | "failed" = "completed",
): SessionEntry[] {
  const record: AgentRecord = {
    id: agentId,
    description: `${agentId} task`,
    cwd: "/repo",
    model: "fake/worker",
    state: "starting",
    createdAt: 100,
    updatedAt: 100,
    runs: [],
  };
  const run = {
    runId: `run_${agentId.slice(-8)}`,
    index: 1,
    promptSha256: "a".repeat(64),
    startedAt: 110,
    usageClaimed: false,
  };
  const events: RegistryEvent[] = [
    { version: REGISTRY_VERSION, kind: "created", agentId, at: 100, record },
    {
      version: REGISTRY_VERSION,
      kind: "started",
      state: "working",
      agentId,
      at: 110,
      run,
      childLeafId: null,
      manifest: fixedManifest,
    },
  ];
  if (state !== "working") {
    events.push({
      version: REGISTRY_VERSION,
      kind: "settled",
      state,
      agentId,
      runId: run.runId,
      at: 200,
      childLeafId: null,
      manifest: fixedManifest,
      usage: usage(1, 1),
      ...(state === "failed" ? { error: "failed" } : {}),
    });
  }
  return events.map((event, index) => ({
    type: "custom",
    id: `${agentId}_${index}`,
    parentId: index === 0 ? null : `${agentId}_${index - 1}`,
    timestamp: new Date(100 + index).toISOString(),
    customType: CUSTOM_ENTRY_TYPE,
    data: event,
  }));
}

function context(
  entries: readonly SessionEntry[] = [],
  options: {
    trusted?: boolean;
    mode?: ExtensionContext["mode"];
    hasUI?: boolean;
    sessionId?: string;
  } = {},
) {
  const notify = vi.fn();
  const getBranch = vi.fn(() => structuredClone([...entries]));
  const ctx = {
    mode: options.mode ?? "tui",
    hasUI: options.hasUI ?? true,
    cwd: "/repo",
    signal: undefined,
    sessionManager: {
      getBranch,
      getSessionId: () => options.sessionId ?? "parent-session",
    },
    isProjectTrusted: () => options.trusted ?? true,
    ui: { notify },
  } as unknown as ExtensionContext;
  return { ctx, notify, getBranch };
}

function fixture(factoryOverrides: Partial<Pick<SessionFactory, "createFresh" | "reopen">> = {}) {
  const tools: ToolDefinition<any, any>[] = [];
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
  const appendEntry = vi.fn();
  const pi = {
    registerTool: (tool: ToolDefinition<any, any>) => tools.push(tool),
    on: (name: string, handler: (event: any, ctx: ExtensionContext) => unknown) => {
      const values = handlers.get(name) ?? [];
      values.push(handler);
      handlers.set(name, values);
    },
    appendEntry,
  } as unknown as ExtensionAPI;
  const runtime = {} as ModelRuntime;
  const factory = {
    createFresh: vi.fn(async () => {
      throw new Error("Unexpected createFresh call");
    }),
    reopen: vi.fn(async () => {
      throw new Error("Unexpected reopen call");
    }),
    ...factoryOverrides,
  } as unknown as SessionFactory;
  const createModelRuntime = vi.fn(async () => runtime);
  const createSessionFactory = vi.fn(() => factory);
  createSubagentsExtension({ createModelRuntime, createSessionFactory })(pi);

  const emit = async (name: string, event: object, ctx: ExtensionContext) => {
    const results = [];
    for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
    return results.at(-1);
  };
  const tool = (name: string) => {
    const value = tools.find((candidate) => candidate.name === name);
    if (!value) throw new Error(`Missing tool ${name}`);
    return value;
  };
  const execute = (
    name: string,
    params: Record<string, unknown>,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ) => tool(name).execute("call_1", params, signal, undefined, ctx);

  return {
    tools,
    handlers,
    appendEntry,
    factory,
    createModelRuntime,
    createSessionFactory,
    emit,
    execute,
  };
}

describe("pi-subagents extension lifecycle", () => {
  it("builds from the active branch and recovers stale work on session_start", async () => {
    const { emit, execute, appendEntry, createModelRuntime, createSessionFactory } = fixture();
    const { ctx, getBranch } = context(branchEntries("sa_00000001", "working"));

    await emit("session_start", { type: "session_start", reason: "startup" }, ctx);

    expect(getBranch).toHaveBeenCalledOnce();
    expect(createModelRuntime).toHaveBeenCalledOnce();
    expect(createSessionFactory).toHaveBeenCalledOnce();
    expect(appendEntry).toHaveBeenCalledWith(
      CUSTOM_ENTRY_TYPE,
      expect.objectContaining({ kind: "interrupted", agentId: "sa_00000001" }),
    );
    const listed = await execute("subagent_list", {}, ctx);
    expect(listed.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("sa_00000001 | interrupted"),
    });
  });

  it("uses trust from the execution context instead of retaining session_start trust", async () => {
    const createFresh = vi.fn(async (input: any) => {
      if (!input.projectTrusted) throw new Error("untrusted project");
      return fakeBundle(childSession());
    });
    const { emit, execute } = fixture({ createFresh });
    const startedContext = context([], { trusted: true }).ctx;
    await emit("session_start", { type: "session_start", reason: "startup" }, startedContext);
    const untrusted = context([], { trusted: false }).ctx;

    const result = await execute(
      "subagent_run",
      { description: "work", prompt: "work", model: "fake/worker" },
      untrusted,
    );

    expect(createFresh).toHaveBeenCalledWith(expect.objectContaining({ projectTrusted: false }));
    expect(result.details).toMatchObject({ infrastructureError: true, error: "untrusted project" });
  });

  it("blocks tree and fork navigation only while children are active", async () => {
    const child = childSession();
    const { emit, execute } = fixture({ createFresh: vi.fn(async () => fakeBundle(child)) });
    const { ctx, notify } = context();
    await emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    const started = await execute(
      "subagent_start",
      { description: "work", prompt: "work", model: "fake/worker" },
      ctx,
    );
    expect(started.details).toMatchObject({ agentId: expect.any(String), state: "working" });

    expect(await emit("session_before_tree", { type: "session_before_tree" }, ctx)).toEqual({
      cancel: true,
    });
    expect(await emit("session_before_fork", { type: "session_before_fork" }, ctx)).toEqual({
      cancel: true,
    });
    expect(notify).toHaveBeenCalledWith(
      "Wait for or abort active subagents before branching",
      "warning",
    );

    child.complete("Status: DONE", usage(1, 1));
    const agentId = (started.details as { agentId: string }).agentId;
    await execute("subagent_wait", { agentId }, ctx);
    expect(await emit("session_before_tree", { type: "session_before_tree" }, ctx)).toBeUndefined();
    expect(await emit("session_before_fork", { type: "session_before_fork" }, ctx)).toBeUndefined();
  });

  it("rebuilds the manager from the new branch after tree navigation", async () => {
    const { emit, execute, createModelRuntime, createSessionFactory } = fixture();
    const oldContext = context(branchEntries("sa_00000001")).ctx;
    await emit("session_start", { type: "session_start", reason: "startup" }, oldContext);
    const oldList = await execute("subagent_list", {}, oldContext);
    expect(oldList.content[0]).toMatchObject({ text: expect.stringContaining("sa_00000001") });

    const newContext = context(branchEntries("sa_00000002")).ctx;
    await emit(
      "session_tree",
      { type: "session_tree", newLeafId: "new", oldLeafId: "old" },
      newContext,
    );
    const newList = await execute("subagent_list", {}, newContext);
    const text = newList.content[0]?.type === "text" ? newList.content[0].text : "";

    expect(text).toContain("sa_00000002");
    expect(text).not.toContain("sa_00000001");
    expect(createModelRuntime).toHaveBeenCalledOnce();
    expect(createSessionFactory).toHaveBeenCalledOnce();
  });

  it("awaits active child shutdown before clearing the session runtime", async () => {
    const child = childSession();
    const gate = deferred<void>();
    child.abort.mockImplementation(async () => {
      await gate.promise;
      child.complete("partial", usage(1, 1));
    });
    const { emit, execute } = fixture({ createFresh: vi.fn(async () => fakeBundle(child)) });
    const { ctx } = context();
    await emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    await execute(
      "subagent_start",
      { description: "work", prompt: "work", model: "fake/worker" },
      ctx,
    );

    let settled = false;
    const shuttingDown = emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx)
      .then(() => {
        settled = true;
      });
    await vi.waitFor(() => expect(child.abort).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    gate.resolve();
    await shuttingDown;
    expect(child.dispose).toHaveBeenCalledOnce();

    const after = await execute("subagent_list", {}, ctx);
    expect(after.details).toMatchObject({ infrastructureError: true });
  });

  it("replaces rather than reuses session-scoped runtime on a later session_start", async () => {
    const { emit, execute, createModelRuntime, createSessionFactory } = fixture();
    const first = context(branchEntries("sa_00000001"), { sessionId: "one" }).ctx;
    await emit("session_start", { type: "session_start", reason: "startup" }, first);
    const second = context(branchEntries("sa_00000002"), { sessionId: "two" }).ctx;
    await emit("session_start", { type: "session_start", reason: "reload" }, second);

    const result = await execute("subagent_list", {}, second);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("sa_00000002");
    expect(text).not.toContain("sa_00000001");
    expect(createModelRuntime).toHaveBeenCalledTimes(2);
    expect(createSessionFactory).toHaveBeenCalledTimes(2);
  });
});
