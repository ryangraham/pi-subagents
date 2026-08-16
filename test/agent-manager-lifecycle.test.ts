import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { AgentManager, SubagentOperationError } from "../src/agent-manager.ts";
import { AgentRegistry } from "../src/registry.ts";
import {
  REGISTRY_VERSION,
  type AgentRecord,
  type ControllerScope,
  type RegistryEvent,
} from "../src/types.ts";
import { FakeAgentSession, fakeBundle, fixedManifest, usage, ZERO_USAGE } from "./helpers/fakes.ts";

const trustedScope: ControllerScope = {
  parentSessionId: "parent-session",
  cwd: "/repo",
  projectTrusted: true,
  mode: "tui",
};

const trackedSessions = new Set<FakeAgentSession>();
afterEach(() => {
  for (const session of trackedSessions) session.cleanup();
  trackedSessions.clear();
});

function session(
  entries: readonly SessionEntry[] = [],
  leafId: string | null = null,
  persistSession = false,
): FakeAgentSession {
  const value = new FakeAgentSession(entries, leafId, { persistSession });
  trackedSessions.add(value);
  return value;
}

function assistant(text: string, timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "fake",
    model: "worker",
    usage: usage(1, 1),
    stopReason: "stop",
    timestamp,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface RecordFixtureOptions {
  agentId?: string;
  runId?: string;
  state?: "working" | "completed" | "failed" | "aborted" | "interrupted";
  childLeafId?: string | null;
  sessionFile?: string;
  error?: string;
  startedAt?: number;
  removed?: boolean;
}

function recordEvents(options: RecordFixtureOptions = {}): RegistryEvent[] {
  const agentId = options.agentId ?? "sa_00000001";
  const runId = options.runId ?? "run_00000001";
  const state = options.state ?? "completed";
  const childLeafId = options.childLeafId ?? "leaf_before_review";
  const sessionFile = options.sessionFile ?? "/tmp/fake-child.jsonl";
  const startedAt = options.startedAt ?? 100;
  const record: AgentRecord = {
    id: agentId,
    description: "implement task",
    cwd: "/repo",
    model: "fake/worker",
    thinkingLevel: "off",
    state: "starting",
    createdAt: 90,
    updatedAt: 90,
    runs: [],
  };
  const run = {
    runId,
    index: 1,
    promptSha256: "a".repeat(64),
    startedAt,
    usageClaimed: false,
  };
  const events: RegistryEvent[] = [
    { version: REGISTRY_VERSION, kind: "created", agentId, at: 90, record },
    {
      version: REGISTRY_VERSION,
      kind: "started",
      state: "working",
      agentId,
      at: startedAt,
      run,
      sessionFile,
      childLeafId,
      manifest: fixedManifest,
    },
  ];
  if (state !== "working") {
    const terminal = {
      version: REGISTRY_VERSION,
      agentId,
      runId,
      at: 200,
      sessionFile,
      childLeafId,
      manifest: fixedManifest,
      usage: usage(2, 1),
      ...(options.error === undefined ? {} : { error: options.error }),
    } as const;
    if (state === "aborted") events.push({ ...terminal, kind: "aborted", state });
    else if (state === "interrupted") events.push({ ...terminal, kind: "interrupted", state });
    else events.push({ ...terminal, kind: "settled", state });
  }
  if (options.removed) {
    events.push({ version: REGISTRY_VERSION, kind: "removed", agentId, at: 300 });
  }
  return events;
}

function setupFailureEvents(error = "model unavailable"): RegistryEvent[] {
  const agentId = "sa_00000001";
  const record: AgentRecord = {
    id: agentId,
    description: "failed setup",
    cwd: "/repo",
    model: "fake/worker",
    state: "starting",
    createdAt: 90,
    updatedAt: 90,
    runs: [],
  };
  return [
    { version: REGISTRY_VERSION, kind: "created", agentId, at: 90, record },
    {
      version: REGISTRY_VERSION,
      kind: "settled",
      state: "failed",
      agentId,
      runId: "run_00000001",
      at: 100,
      run: {
        runId: "run_00000001",
        index: 1,
        promptSha256: "a".repeat(64),
        startedAt: 90,
        usageClaimed: false,
      },
      childLeafId: null,
      error,
    },
  ];
}

interface ManagerFixtureOptions {
  events?: RegistryEvent[];
  freshSessions?: FakeAgentSession[];
  reopen?: (input: unknown) => Promise<ReturnType<typeof fakeBundle>>;
  persist?: (event: RegistryEvent) => void;
  maxActive?: number;
}

function managerFixture(options: ManagerFixtureOptions = {}) {
  const persisted: RegistryEvent[] = [];
  const registry = AgentRegistry.fromEvents(options.events ?? [], (event) => {
    persisted.push(structuredClone(event));
    options.persist?.(event);
  });
  const freshSessions = options.freshSessions ?? [];
  let freshIndex = 0;
  const factory = {
    createFresh: vi.fn(async () => {
      const child = freshSessions[freshIndex++];
      if (!child) throw new Error("Unexpected createFresh call");
      return fakeBundle(child);
    }),
    reopen: vi.fn(
      options.reopen ??
        (async () => {
          throw new Error("Unexpected reopen call");
        }),
    ),
  };
  let agentSequence = 1;
  let runSequence = 1;
  let clock = 1_000;
  const manager = new AgentManager({
    factory,
    registry,
    createAgentId: () => `sa_${(agentSequence++).toString(16).padStart(8, "0")}`,
    createRunId: () => `run_${(runSequence++).toString(16).padStart(8, "0")}`,
    now: () => ++clock,
    ...(options.maxActive === undefined ? {} : { maxActive: options.maxActive }),
  });
  return { manager, factory, registry, persisted };
}

async function startActive(manager: AgentManager, child: FakeAgentSession, description = "active") {
  return manager.start(
    { description, prompt: "work", model: "fake/worker" },
    trustedScope,
  );
}

describe("AgentManager resume", () => {
  it("resumes the same id from its recorded child leaf", async () => {
    const resumedSession = session();
    const { manager, factory } = managerFixture({
      events: recordEvents({ childLeafId: "leaf_before_review" }),
      reopen: async () => fakeBundle(resumedSession),
    });

    const result = manager.resume("sa_00000001", "Fix the findings", trustedScope);
    await vi.waitFor(() => expect(resumedSession.isPending()).toBe(true));
    resumedSession.complete("Status: DONE", usage(7, 2), "leaf_after_fix");

    await expect(result).resolves.toMatchObject({
      outcome: { agentId: "sa_00000001", childLeafId: "leaf_after_fix" },
      claimedUsage: usage(7, 2),
    });
    expect(factory.reopen).toHaveBeenCalledWith(
      expect.objectContaining({
        record: expect.objectContaining({ childLeafId: "leaf_before_review" }),
        prompt: "Fix the findings",
      }),
    );
    expect(factory.createFresh).not.toHaveBeenCalled();
  });

  it("rejects model cwd and resource mutation by exposing only id and prompt", () => {
    expectTypeOf<Parameters<AgentManager["resume"]>[1]>().toEqualTypeOf<string>();
  });

  it("reserves the same id synchronously so simultaneous resumes accept exactly one", async () => {
    const resumedSession = session();
    const setup = deferred<ReturnType<typeof fakeBundle>>();
    const { manager } = managerFixture({
      events: recordEvents(),
      reopen: async () => setup.promise,
    });

    const first = manager.resume("sa_00000001", "first", trustedScope);
    await expect(manager.resume("sa_00000001", "second", trustedScope)).rejects.toThrow(
      "already active",
    );
    setup.resolve(fakeBundle(resumedSession));
    await vi.waitFor(() => expect(resumedSession.isPending()).toBe(true));
    resumedSession.complete("Status: DONE", usage(1, 1));
    await first;
  });

  it("blocks removal during resume setup", async () => {
    const resumedSession = session();
    const setup = deferred<ReturnType<typeof fakeBundle>>();
    const { manager } = managerFixture({
      events: recordEvents(),
      reopen: async () => setup.promise,
    });

    const resuming = manager.resume("sa_00000001", "fix", trustedScope);
    await expect(manager.remove("sa_00000001")).rejects.toThrow("Cannot remove active agent");
    setup.resolve(fakeBundle(resumedSession));
    await vi.waitFor(() => expect(resumedSession.isPending()).toBe(true));
    resumedSession.complete("Status: DONE", usage(1, 1));
    await resuming;
  });

  it("preserves identity model thinking cwd session and the recorded leaf over a sibling", async () => {
    const resumedSession = session();
    const original = recordEvents({ childLeafId: "leaf_recorded", sessionFile: "/tmp/original.jsonl" });
    const { manager, factory } = managerFixture({
      events: original,
      reopen: async () => fakeBundle(resumedSession, {
        ...fixedManifest,
        cwd: "/repo",
        model: "fake/worker",
        thinkingLevel: "off",
      }),
    });

    const result = manager.resume("sa_00000001", "continue recorded branch", trustedScope);
    await vi.waitFor(() => expect(resumedSession.isPending()).toBe(true));
    resumedSession.complete("Status: DONE", usage(1, 1), "leaf_resumed");
    await result;

    expect(factory.reopen).toHaveBeenCalledWith(
      expect.objectContaining({
        parentCwd: "/repo",
        prompt: "continue recorded branch",
        projectTrusted: true,
        record: expect.objectContaining({
          id: "sa_00000001",
          childLeafId: "leaf_recorded",
          sessionFile: "/tmp/original.jsonl",
          cwd: "/repo",
          model: "fake/worker",
          thinkingLevel: "off",
        }),
      }),
    );
    expect(manager.get("sa_00000001")).toMatchObject({
      id: "sa_00000001",
      cwd: "/repo",
      model: "fake/worker",
      thinkingLevel: "off",
      childLeafId: "leaf_resumed",
      runs: [expect.anything(), expect.objectContaining({ index: 2 })],
    });
  });

  it("rejects removed ids without creating or reopening a session", async () => {
    const { manager, factory } = managerFixture({ events: recordEvents({ removed: true }) });

    await expect(manager.resume("sa_00000001", "fix", trustedScope)).rejects.toThrow("removed");
    expect(factory.reopen).not.toHaveBeenCalled();
    expect(factory.createFresh).not.toHaveBeenCalled();
  });

  it("records reopen failure as a failed second run under the stable id", async () => {
    const { manager, factory, persisted } = managerFixture({
      events: recordEvents(),
      reopen: async () => {
        throw new Error("reopen failed");
      },
    });

    const error = await manager
      .resume("sa_00000001", "fix", trustedScope)
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(SubagentOperationError);
    expect(error).toMatchObject({ agentId: "sa_00000001", message: "reopen failed" });
    expect(manager.get("sa_00000001")).toMatchObject({
      state: "failed",
      error: "reopen failed",
      runs: [expect.anything(), expect.objectContaining({ index: 2, usage: ZERO_USAGE })],
    });
    expect(persisted.slice(-2).map((event) => event.kind)).toEqual(["resumed", "settled"]);
    expect(factory.createFresh).not.toHaveBeenCalled();
  });

  it("cancels a deferred reopen without prompting", async () => {
    const resumedSession = session();
    const setup = deferred<ReturnType<typeof fakeBundle>>();
    const { manager, persisted } = managerFixture({
      events: recordEvents(),
      reopen: async () => setup.promise,
    });
    const controller = new AbortController();
    const result = manager.resume("sa_00000001", "fix", trustedScope, controller.signal);
    controller.abort();
    setup.resolve(fakeBundle(resumedSession));

    await expect(result).resolves.toMatchObject({ outcome: { state: "aborted" } });
    expect(resumedSession.prompt).not.toHaveBeenCalled();
    expect(resumedSession.abort).toHaveBeenCalledOnce();
    expect(persisted.slice(-3).map((event) => event.kind)).toEqual([
      "resumed",
      "aborted",
      "usage_claimed",
    ]);
  });

  it("foreground resume cancellation aborts the reopened child", async () => {
    const resumedSession = session();
    const { manager } = managerFixture({
      events: recordEvents(),
      reopen: async () => fakeBundle(resumedSession),
    });
    const controller = new AbortController();
    const result = manager.resume("sa_00000001", "fix", trustedScope, controller.signal);
    await vi.waitFor(() => expect(resumedSession.isPending()).toBe(true));
    controller.abort();

    await expect(result).resolves.toMatchObject({ outcome: { state: "aborted" } });
    expect(resumedSession.abort).toHaveBeenCalledOnce();
  });
});

describe("AgentManager abort and remove", () => {
  it("aborts a live child idempotently", async () => {
    const child = session();
    const { manager } = managerFixture({ freshSessions: [child] });
    const started = await startActive(manager, child);

    await manager.abort(started.agentId);
    await manager.abort(started.agentId);

    expect(child.abort).toHaveBeenCalledOnce();
    expect(manager.get(started.agentId)?.state).toBe("aborted");
  });

  it("aborts a still-pending setup without prompting", async () => {
    const child = session();
    const { manager, persisted } = managerFixture({ freshSessions: [child] });
    const starting = manager.start(
      { description: "pending", prompt: "work", model: "fake/worker" },
      trustedScope,
    );
    const agentId = manager.list()[0]!.id;
    const aborting = manager.abort(agentId);
    await starting;
    await aborting;

    expect(child.prompt).not.toHaveBeenCalled();
    expect(child.abort).toHaveBeenCalledOnce();
    expect(manager.get(agentId)?.state).toBe("aborted");
    expect(persisted.map((event) => event.kind)).toEqual(["created", "aborted"]);
  });

  it("blocks active removal and hides a terminal agent after removal", async () => {
    const child = session();
    const { manager } = managerFixture({ freshSessions: [child] });
    const started = await startActive(manager, child);

    await expect(manager.remove(started.agentId)).rejects.toThrow("Cannot remove active agent");
    child.complete("done", usage(1, 1), "leaf_done");
    await manager.wait(started.agentId);
    await manager.remove(started.agentId);

    expect(manager.list()).toEqual([]);
  });
});

describe("AgentManager stale recovery and transcript replay", () => {
  it("recovers only the newest descendant of the recorded leaf and only once", () => {
    const entries: SessionEntry[] = [
      {
        type: "message",
        id: "root",
        parentId: null,
        timestamp: new Date(500).toISOString(),
        message: { role: "user", content: "root", timestamp: 500 },
      },
      {
        type: "message",
        id: "leaf_recorded",
        parentId: "root",
        timestamp: new Date(900).toISOString(),
        message: assistant("recorded", 900),
      },
      {
        type: "message",
        id: "descendant_1",
        parentId: "leaf_recorded",
        timestamp: new Date(1_100).toISOString(),
        message: { role: "user", content: "partial", timestamp: 1_100 },
      },
      {
        type: "message",
        id: "descendant_2",
        parentId: "descendant_1",
        timestamp: new Date(1_200).toISOString(),
        message: assistant("partial answer", 1_200),
      },
      {
        type: "message",
        id: "sibling_newer",
        parentId: "root",
        timestamp: new Date(1_300).toISOString(),
        message: assistant("wrong sibling", 1_300),
      },
    ];
    const persistedSession = session(entries, "sibling_newer", true);
    const { manager, persisted } = managerFixture({
      events: recordEvents({
        state: "working",
        childLeafId: "leaf_recorded",
        sessionFile: persistedSession.sessionFile,
        startedAt: 1_000,
      }),
    });

    manager.recoverStale();
    manager.recoverStale();

    expect(manager.get("sa_00000001")).toMatchObject({
      state: "interrupted",
      childLeafId: "descendant_2",
      runs: [expect.objectContaining({ childLeafId: "descendant_2" })],
    });
    expect(persisted.filter((event) => event.kind === "interrupted")).toHaveLength(1);
  });

  it("returns a synthetic error transcript for setup failure without JSONL", async () => {
    const { manager } = managerFixture({ events: setupFailureEvents("model unavailable") });

    await expect(manager.loadTranscript("sa_00000001")).resolves.toEqual([
      expect.objectContaining({ kind: "error", text: "model unavailable", isError: true }),
    ]);
  });

  it("replays only the recorded child branch without creating an AgentSession", async () => {
    const entries: SessionEntry[] = [
      {
        type: "message",
        id: "root",
        parentId: null,
        timestamp: new Date(1).toISOString(),
        message: { role: "user", content: "root", timestamp: 1 },
      },
      {
        type: "message",
        id: "branch_a",
        parentId: "root",
        timestamp: new Date(2).toISOString(),
        message: assistant("branch a", 2),
      },
      {
        type: "message",
        id: "branch_b",
        parentId: "root",
        timestamp: new Date(3).toISOString(),
        message: assistant("branch b", 3),
      },
    ];
    const persistedSession = session(entries, "branch_b", true);
    const { manager, factory } = managerFixture({
      events: recordEvents({ childLeafId: "branch_b", sessionFile: persistedSession.sessionFile }),
    });

    const records = await manager.loadTranscript("sa_00000001");
    const text = records.map((record) => record.text).join("\n");
    expect(text).toContain("branch b");
    expect(text).not.toContain("branch a");
    expect(factory.createFresh).not.toHaveBeenCalled();
    expect(factory.reopen).not.toHaveBeenCalled();
  });
});

describe("AgentManager shutdown", () => {
  it("rejects later starts and disposes a factory result racing with shutdown without prompting", async () => {
    const child = session();
    const setup = deferred<ReturnType<typeof fakeBundle>>();
    const registry = AgentRegistry.fromEvents([], vi.fn());
    let agentSequence = 1;
    let runSequence = 1;
    const factory = {
      createFresh: vi.fn(async () => setup.promise),
      reopen: vi.fn(),
    };
    const manager = new AgentManager({
      factory,
      registry,
      createAgentId: () => `sa_${(agentSequence++).toString(16).padStart(8, "0")}`,
      createRunId: () => `run_${(runSequence++).toString(16).padStart(8, "0")}`,
      now: () => 1_000,
    });
    const starting = manager.start(
      { description: "pending", prompt: "work", model: "fake/worker" },
      trustedScope,
    );
    const shuttingDown = manager.shutdown();
    await expect(
      manager.start({ description: "late", prompt: "late", model: "fake/worker" }, trustedScope),
    ).rejects.toThrow("shutting down");
    setup.resolve(fakeBundle(child));

    await shuttingDown;
    await starting;
    expect(child.prompt).not.toHaveBeenCalled();
    expect(child.dispose).toHaveBeenCalledOnce();
    expect(manager.get("sa_00000001")?.state).toBe("interrupted");
  });

  it("aggregates an idle abort failure after a racing factory bundle is durably interrupted", async () => {
    const child = session();
    child.abort.mockRejectedValue(new Error("idle abort failed"));
    const setup = deferred<ReturnType<typeof fakeBundle>>();
    const registry = AgentRegistry.fromEvents([], vi.fn());
    const manager = new AgentManager({
      factory: { createFresh: vi.fn(async () => setup.promise), reopen: vi.fn() },
      registry,
      createAgentId: () => "sa_00000001",
      createRunId: () => "run_00000001",
      now: () => 1_000,
    });
    const starting = manager.start(
      { description: "pending", prompt: "work", model: "fake/worker" },
      trustedScope,
    );
    const shuttingDown = manager.shutdown();
    setup.resolve(fakeBundle(child));

    const error = await shuttingDown.catch((value: unknown) => value);
    await expect(starting).rejects.toThrow("idle abort failed");
    expect(error).toBeInstanceOf(AggregateError);
    expect(child.prompt).not.toHaveBeenCalled();
    expect(child.dispose).toHaveBeenCalledOnce();
    expect(manager.get("sa_00000001")?.state).toBe("interrupted");
  });

  it("interrupts four children in parallel", async () => {
    const sessions = Array.from({ length: 4 }, () => session());
    const { manager } = managerFixture({ freshSessions: sessions });
    const started = await Promise.all(
      sessions.map((child, index) => startActive(manager, child, `child ${index}`)),
    );
    const gates = sessions.map(() => deferred<void>());
    sessions.forEach((child, index) => {
      child.abort.mockImplementation(async () => {
        await gates[index]!.promise;
        child.complete("partial", usage(1, 1));
      });
    });

    const shuttingDown = manager.shutdown();
    await vi.waitFor(() => sessions.forEach((child) => expect(child.abort).toHaveBeenCalledOnce()));
    gates.forEach((gate) => gate.resolve());
    await shuttingDown;

    expect(started.map((value) => manager.get(value.agentId)?.state)).toEqual([
      "interrupted",
      "interrupted",
      "interrupted",
      "interrupted",
    ]);
  });

  it("cleans every child before aggregating a cleanup failure", async () => {
    const sessions = [session(), session()];
    const { manager } = managerFixture({ freshSessions: sessions });
    const started = await Promise.all(sessions.map((child) => startActive(manager, child)));
    sessions[0]!.abort.mockRejectedValue(new Error("first abort failed"));
    sessions[1]!.abort.mockImplementation(async () => {
      sessions[1]!.complete("partial", ZERO_USAGE);
    });

    const error = await manager.shutdown().catch((value: unknown) => value);

    expect(error).toBeInstanceOf(AggregateError);
    expect(sessions[0]!.dispose).toHaveBeenCalledOnce();
    expect(sessions[1]!.dispose).toHaveBeenCalledOnce();
    expect(started.map((value) => manager.get(value.agentId)?.state)).toEqual([
      "interrupted",
      "interrupted",
    ]);
  });

  it("is idempotent and returns the same shutdown promise", async () => {
    const { manager } = managerFixture();

    const first = manager.shutdown();
    const second = manager.shutdown();

    expect(first).toBe(second);
    await first;
  });
});
