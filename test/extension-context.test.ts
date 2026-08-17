import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ModelRuntime,
  SessionEntry,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSubagentsExtension } from "../src/index.ts";
import type { SessionFactory } from "../src/session-factory.ts";
import type { SubagentToolDetails } from "../src/tools.ts";
import {
  CUSTOM_ENTRY_TYPE,
  REGISTRY_VERSION,
  type AgentRecord,
  type RegistryEvent,
} from "../src/types.ts";
import {
  FakeAgentSession,
  fakeBundle,
  fixedManifest,
  usage,
} from "./helpers/fakes.ts";

const tempDirs: string[] = [];
const childSessions = new Set<FakeAgentSession>();

afterEach(async () => {
  for (const child of childSessions) child.cleanup();
  childSessions.clear();
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

async function createParent(name: string): Promise<SessionManager> {
  const root = await mkdtemp(join(tmpdir(), `pi-subagents-${name}-`));
  tempDirs.push(root);
  const cwd = join(root, "project");
  const sessions = join(root, "sessions");
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(sessions, { recursive: true })]);
  return SessionManager.create(cwd, sessions);
}

function userMessage(text: string, timestamp = 1) {
  return {
    role: "user" as const,
    content: [{ type: "text" as const, text }],
    timestamp,
  };
}

function lifecycleEvents(
  agentId: string,
  state: "working" | "completed" | "failed" = "completed",
  cwd = "/repo",
): RegistryEvent[] {
  const record: AgentRecord = {
    id: agentId,
    description: `${agentId} task`,
    cwd,
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
      manifest: { ...structuredClone(fixedManifest), cwd },
    },
  ];
  if (state !== "working") {
    events.push({
      version: REGISTRY_VERSION,
      kind: "settled",
      state,
      agentId,
      runId: run.runId,
      at: 120,
      childLeafId: null,
      manifest: { ...structuredClone(fixedManifest), cwd },
      usage: usage(2, 1),
      ...(state === "failed" ? { error: "failed" } : {}),
    });
  }
  return events;
}

function appendLifecycle(parent: SessionManager, events: readonly RegistryEvent[]): void {
  for (const event of events) parent.appendCustomEntry(CUSTOM_ENTRY_TYPE, event);
}

interface ExtensionHarnessOptions {
  factory?: Pick<SessionFactory, "createFresh" | "reopen">;
}

function extensionHarness(
  parent: SessionManager,
  options: ExtensionHarnessOptions = {},
) {
  const tools: ToolDefinition<any, SubagentToolDetails>[] = [];
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
  const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> }>();
  const appendEntry = vi.fn((customType: string, data: unknown) =>
    parent.appendCustomEntry(customType, data));
  const sendMessage = vi.fn();
  const sendUserMessage = vi.fn();
  const notify = vi.fn();
  const setWidget = vi.fn();
  const requestRender = vi.fn();
  const components: Array<{ dispose?(): void }> = [];
  const custom = vi.fn(async (factory: (...args: any[]) => any) => {
    let resolveDone!: (value: unknown) => void;
    const completion = new Promise<unknown>((resolve) => {
      resolveDone = resolve;
    });
    let closed = false;
    const done = (value?: unknown): void => {
      if (closed) return;
      closed = true;
      resolveDone(value);
    };
    const component = await factory(
      { requestRender } as unknown as TUI,
      {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      } as Theme,
      { matches: (data: string, action: string) => data === `<${action}>` },
      done,
    );
    components.push(component);
    done(undefined);
    await completion;
    component.dispose?.();
  });
  const confirm = vi.fn(async () => true);
  const pi = {
    registerTool: (tool: ToolDefinition<any, SubagentToolDetails>) => tools.push(tool),
    on: (name: string, handler: (event: any, ctx: ExtensionContext) => unknown) => {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    },
    registerCommand: (
      name: string,
      command: { handler(args: string, ctx: ExtensionContext): Promise<void> },
    ) => commands.set(name, command),
    registerShortcut: vi.fn(),
    appendEntry,
    sendMessage,
    sendUserMessage,
  } as unknown as ExtensionAPI;
  const factory = options.factory ?? {
    createFresh: vi.fn(async () => {
      throw new Error("Unexpected createFresh call");
    }),
    reopen: vi.fn(async () => {
      throw new Error("Unexpected reopen call");
    }),
  };
  createSubagentsExtension({
    createModelRuntime: async () => ({} as ModelRuntime),
    createSessionFactory: () => factory as SessionFactory,
  })(pi);
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: parent.getCwd(),
    signal: undefined,
    sessionManager: parent,
    isProjectTrusted: () => true,
    ui: { notify, setWidget, requestRender, custom, confirm },
  } as unknown as ExtensionContext;

  const emit = async (name: string, event: object, eventContext: ExtensionContext = ctx) => {
    const results: unknown[] = [];
    for (const handler of handlers.get(name) ?? []) {
      results.push(await handler(event, eventContext));
    }
    return results.at(-1);
  };
  const execute = (
    name: string,
    params: Record<string, unknown>,
    eventContext: ExtensionContext = ctx,
  ) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Missing tool ${name}`);
    return tool.execute(`call_${name}`, params, undefined, undefined, eventContext);
  };
  const listText = async (): Promise<string> => {
    const result = await execute("subagent_list", {});
    const first = result.content[0];
    return first?.type === "text" ? first.text : "";
  };

  return {
    ctx,
    tools,
    commands,
    appendEntry,
    sendMessage,
    sendUserMessage,
    notify,
    setWidget,
    requestRender,
    custom,
    components,
    emit,
    execute,
    listText,
  };
}

describe("extension context and branch acceptance", () => {
  it("keeps lifecycle data and tool-result details out of model-visible content", async () => {
    const parent = await createParent("context-exclusion");
    parent.appendMessage(userMessage("controller-visible user message"));
    const lifecycleSentinel = "LIFECYCLE_SENTINEL_MUST_NOT_ENTER_MESSAGES";
    const created = lifecycleEvents("sa_11111111", "completed", parent.getCwd())[0]!;
    if (created.kind !== "created") throw new Error("Expected a created lifecycle fixture");
    parent.appendCustomEntry(CUSTOM_ENTRY_TYPE, {
      ...created,
      record: { ...created.record, description: lifecycleSentinel },
    });
    const detailsSentinel = "DETAILS_SENTINEL_MUST_NOT_ENTER_TOOL_CONTENT";
    parent.appendMessage({
      role: "toolResult",
      toolCallId: "call_parent",
      toolName: "subagent_run",
      content: [{ type: "text", text: "terminal response only" }],
      details: { nested: detailsSentinel },
      isError: false,
      timestamp: 2,
    });

    const context = parent.buildSessionContext();
    expect(JSON.stringify(context.messages)).not.toContain(lifecycleSentinel);
    const toolResult = context.messages.find((message) => message.role === "toolResult");
    expect(toolResult).toBeDefined();
    expect(JSON.stringify(toolResult!.content)).toBe(JSON.stringify([
      { type: "text", text: "terminal response only" },
    ]));
    expect(JSON.stringify(toolResult!.content)).not.toContain(detailsSentinel);
    expect((toolResult as { details?: unknown }).details).toEqual({ nested: detailsSentinel });
  });

  it("recovers IDs after compaction and a complete runtime rebuild", async () => {
    const parent = await createParent("compaction-recovery");
    parent.appendMessage(userMessage("old controller turn", 1));
    appendLifecycle(parent, lifecycleEvents("sa_22222222", "completed", parent.getCwd()));
    const keptId = parent.appendMessage(userMessage("kept controller turn", 2));
    parent.appendCompaction("summary of old controller turn", keptId, 1_000);

    expect(parent.buildContextEntries().some(
      (entry: SessionEntry) => entry.type === "custom" && entry.customType === CUSTOM_ENTRY_TYPE,
    )).toBe(false);
    const first = extensionHarness(parent);
    await first.emit("session_start", { type: "session_start", reason: "startup" });
    expect(await first.listText()).toContain("sa_22222222");
    await first.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });

    const rebuilt = extensionHarness(parent);
    await rebuilt.emit("session_start", { type: "session_start", reason: "startup" });
    expect(await rebuilt.listText()).toContain("sa_22222222");
    expect(parent.buildSessionContext().messages.some(
      (message) => JSON.stringify(message).includes("sa_22222222"),
    )).toBe(false);
    await rebuilt.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  });

  it("switches to the active branch roster and hides sibling-only IDs", async () => {
    const parent = await createParent("tree-branches");
    const rootId = parent.appendMessage(userMessage("shared root"));
    appendLifecycle(parent, lifecycleEvents("sa_aaaaaaaa", "completed", parent.getCwd()));
    const firstLeaf = parent.getLeafId()!;
    parent.branch(rootId);
    appendLifecycle(parent, lifecycleEvents("sa_bbbbbbbb", "completed", parent.getCwd()));
    const secondLeaf = parent.getLeafId()!;

    parent.branch(firstLeaf);
    const harness = extensionHarness(parent);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    expect(await harness.listText()).toContain("sa_aaaaaaaa");
    expect(await harness.listText()).not.toContain("sa_bbbbbbbb");

    parent.branch(secondLeaf);
    await harness.emit("session_tree", {
      type: "session_tree",
      oldLeafId: firstLeaf,
      newLeafId: secondLeaf,
    });
    const switched = await harness.listText();
    expect(switched).toContain("sa_bbbbbbbb");
    expect(switched).not.toContain("sa_aaaaaaaa");
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  });

  it("marks stale work interrupted once across a simulated restart", async () => {
    const parent = await createParent("stale-restart");
    appendLifecycle(parent, lifecycleEvents("sa_cccccccc", "working", parent.getCwd()));
    const first = extensionHarness(parent);
    await first.emit("session_start", { type: "session_start", reason: "startup" });
    expect(await first.listText()).toContain("sa_cccccccc | interrupted");
    expect(first.appendEntry.mock.calls.filter(([, event]) =>
      (event as RegistryEvent).kind === "interrupted")).toHaveLength(1);
    await first.emit("session_shutdown", { type: "session_shutdown", reason: "restart" });

    const restarted = extensionHarness(parent);
    await restarted.emit("session_start", { type: "session_start", reason: "startup" });
    expect(await restarted.listText()).toContain("sa_cccccccc | interrupted");
    expect(restarted.appendEntry.mock.calls.filter(([, event]) =>
      (event as RegistryEvent).kind === "interrupted")).toHaveLength(0);
    await restarted.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  });

  it("blocks active navigation while widget and viewer updates never create model messages", async () => {
    const parent = await createParent("active-ui-isolation");
    const child = new FakeAgentSession([], null, { persistSession: true });
    childSessions.add(child);
    const factory = {
      createFresh: vi.fn(async () => fakeBundle(child)),
      reopen: vi.fn(async () => {
        throw new Error("Unexpected reopen call");
      }),
    };
    const harness = extensionHarness(parent, { factory });
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    const widgetFactory = harness.setWidget.mock.calls[0]![1] as (
      tui: TUI,
      theme: Theme,
    ) => { dispose(): void };
    widgetFactory(
      { requestRender: harness.requestRender } as unknown as TUI,
      {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      } as Theme,
    );
    const started = await harness.execute("subagent_start", {
      description: "active acceptance child",
      prompt: "do acceptance work",
      model: "fake/worker",
    });
    expect(started.details.agentId).toMatch(/^sa_[0-9a-f]{8}$/);

    expect(await harness.emit("session_before_tree", { type: "session_before_tree" })).toEqual({
      cancel: true,
    });
    expect(await harness.emit("session_before_fork", { type: "session_before_fork" })).toEqual({
      cancel: true,
    });
    await harness.commands.get("agents")!.handler("", harness.ctx);
    expect(harness.custom).toHaveBeenCalledOnce();

    child.complete("Status: DONE", usage(4, 2));
    await harness.execute("subagent_wait", { agentId: started.details.agentId });
    expect(harness.requestRender).toHaveBeenCalled();
    expect(harness.sendMessage).not.toHaveBeenCalled();
    expect(harness.sendUserMessage).not.toHaveBeenCalled();
    expect(parent.buildSessionContext().messages).toEqual([]);
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  });
});
