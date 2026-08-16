import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager, SubagentOperationError } from "../src/agent-manager.ts";
import { AgentRegistry } from "../src/registry.ts";
import {
  REGISTRY_VERSION,
  type AgentRecord,
  type ControllerScope,
  type DispatchRequest,
  type RegistryEvent,
  type TranscriptRecord,
} from "../src/types.ts";
import { FakeAgentSession, fakeBundle, fixedManifest, usage } from "./helpers/fakes.ts";

const request: DispatchRequest = {
  description: "implement task",
  prompt: "work",
  model: "fake/worker",
};

const scope: ControllerScope = {
  parentSessionId: "parent-session",
  cwd: "/repo",
  projectTrusted: true,
  mode: "tui",
};

const createdSessions = new Set<FakeAgentSession>();

afterEach(() => {
  for (const session of createdSessions) session.cleanup();
  createdSessions.clear();
});

function fakeSession(): FakeAgentSession {
  const session = new FakeAgentSession([], null, { persistSession: true });
  createdSessions.add(session);
  return session;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function seedEvents(agentId = "sa_existing", runId = "run_existing"): RegistryEvent[] {
  const record: AgentRecord = {
    id: agentId,
    description: "existing",
    cwd: "/repo",
    model: "fake/worker",
    state: "starting",
    createdAt: 1,
    updatedAt: 1,
    runs: [],
  };
  return [
    { version: REGISTRY_VERSION, kind: "created", agentId, at: 1, record },
    {
      version: REGISTRY_VERSION,
      kind: "started",
      state: "working",
      agentId,
      at: 2,
      run: {
        runId,
        index: 1,
        promptSha256: "a".repeat(64),
        startedAt: 2,
        usageClaimed: false,
      },
      sessionFile: "/tmp/existing.jsonl",
      childLeafId: "leaf_existing",
      manifest: fixedManifest,
    },
    {
      version: REGISTRY_VERSION,
      kind: "settled",
      state: "completed",
      agentId,
      runId,
      at: 3,
      sessionFile: "/tmp/existing.jsonl",
      childLeafId: "leaf_existing",
      manifest: fixedManifest,
      usage: usage(1, 1),
    },
  ];
}

interface FixtureOptions {
  sessions?: FakeAgentSession[];
  seed?: RegistryEvent[];
  persist?: (event: RegistryEvent) => void;
  createFresh?: (input: unknown) => Promise<ReturnType<typeof fakeBundle>>;
  createAgentId?: () => string;
  createRunId?: () => string;
  maxActive?: number;
}

function fixture(options: FixtureOptions = {}) {
  const sessions = options.sessions ?? [fakeSession()];
  let sessionIndex = 0;
  const persisted: RegistryEvent[] = [];
  const persist = vi.fn((event: RegistryEvent) => {
    persisted.push(structuredClone(event));
    options.persist?.(event);
  });
  const registry = AgentRegistry.fromEvents(options.seed ?? [], persist);
  const createFresh = vi.fn(
    options.createFresh ??
      (async () => {
        const session = sessions[sessionIndex++];
        if (!session) throw new Error("Fake session queue exhausted");
        return fakeBundle(session);
      }),
  );
  let agentSequence = 0;
  let runSequence = 0;
  let clock = 100;
  const manager = new AgentManager({
    factory: { createFresh, reopen: vi.fn() },
    registry,
    createAgentId:
      options.createAgentId ??
      (() => `sa_${(++agentSequence).toString(16).padStart(8, "0")}`),
    createRunId:
      options.createRunId ??
      (() => `run_${(++runSequence).toString(16).padStart(8, "0")}`),
    now: () => ++clock,
    ...(options.maxActive === undefined ? {} : { maxActive: options.maxActive }),
  });
  return { manager, registry, persisted, createFresh, sessions };
}

async function settle(manager: AgentManager, session: FakeAgentSession, agentId: string): Promise<void> {
  session.complete("Status: DONE", usage(1, 1));
  await manager.wait(agentId);
}

describe("AgentManager fresh dispatch", () => {
  it("starts in the background and returns before completion", async () => {
    const { manager, sessions, createFresh } = fixture();

    await expect(manager.start(request, scope)).resolves.toEqual({
      agentId: "sa_00000001",
      runId: "run_00000001",
      state: "working",
    });
    expect(sessions[0]!.isPending()).toBe(true);
    expect(manager.hasActive()).toBe(true);
    expect(manager.get("sa_00000001")).toMatchObject({ state: "working", runs: [{ index: 1 }] });
    expect(createFresh).toHaveBeenCalledWith({
      parentSessionId: scope.parentSessionId,
      parentCwd: scope.cwd,
      request,
      projectTrusted: true,
    });

    await settle(manager, sessions[0]!, "sa_00000001");
  });

  it("run waits and aborts on caller cancellation", async () => {
    const { manager, sessions } = fixture();
    const controller = new AbortController();
    const result = manager.run(request, scope, controller.signal);
    controller.abort();

    await expect(result).resolves.toMatchObject({ outcome: { state: "aborted" } });
    expect(sessions[0]!.abort).toHaveBeenCalledOnce();
  });

  it("records setup cancellation and prevents prompting after a deferred factory resolves", async () => {
    const session = fakeSession();
    const setup = deferred<ReturnType<typeof fakeBundle>>();
    const { manager } = fixture({ sessions: [session], createFresh: async () => setup.promise });
    const controller = new AbortController();
    const result = manager.run(request, scope, controller.signal);
    controller.abort();
    setup.resolve(fakeBundle(session));

    await expect(result).resolves.toMatchObject({
      outcome: { agentId: "sa_00000001", state: "aborted", finalText: "" },
    });
    expect(session.prompt).not.toHaveBeenCalled();
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(manager.get("sa_00000001")?.state).toBe("aborted");
  });

  it("durably records factory failure and preserves the generated agent id", async () => {
    const { manager } = fixture({
      createFresh: async () => {
        throw new Error("model unavailable");
      },
    });

    const error = await manager.start(request, scope).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(SubagentOperationError);
    expect(error).toMatchObject({ agentId: "sa_00000001", message: "model unavailable" });
    expect(manager.get("sa_00000001")).toMatchObject({
      state: "failed",
      error: "model unavailable",
      runs: [expect.objectContaining({ runId: "run_00000001" })],
    });
    const failedWait = await manager.wait("sa_00000001");
    expect(failedWait).toMatchObject({
      outcome: { state: "failed", finalText: "", error: "model unavailable" },
    });
    expect(failedWait.claimedUsage).toBeUndefined();
    expect(manager.hasActive()).toBe(false);
  });
});

describe("AgentManager waiting and accounting", () => {
  it("wait reconstructs the final response after disposal and claims usage once", async () => {
    const { manager, sessions } = fixture();
    const started = await manager.start(request, scope);
    sessions[0]!.complete("Status: DONE", usage(10, 4), "leaf_1");

    const first = await manager.wait(started.agentId);
    expect(sessions[0]!.dispose).toHaveBeenCalledOnce();
    const second = await manager.wait(started.agentId);

    expect(first).toMatchObject({
      outcome: { finalText: "Status: DONE", state: "completed" },
      claimedUsage: usage(10, 4),
    });
    expect(second).toMatchObject({ outcome: { finalText: "Status: DONE", state: "completed" } });
    expect(second.claimedUsage).toBeUndefined();
  });

  it("concurrent waits claim nested usage exactly once", async () => {
    const { manager, sessions } = fixture();
    const started = await manager.start(request, scope);
    const first = manager.wait(started.agentId);
    const second = manager.wait(started.agentId);
    sessions[0]!.complete("Status: DONE", { ...usage(8, 3), reasoning: 2, cacheWrite1h: 4 });

    const results = await Promise.all([first, second]);
    expect(results.filter((result) => result.claimedUsage !== undefined)).toHaveLength(1);
    expect(results.find((result) => result.claimedUsage)?.claimedUsage).toMatchObject({
      input: 8,
      output: 3,
      reasoning: 2,
      cacheWrite1h: 4,
    });
  });

  it("settles a rejected background child without requiring a waiter", async () => {
    const { manager, sessions } = fixture();
    const started = await manager.start(request, scope);
    sessions[0]!.fail(new Error("provider down"), usage(3, 1), "leaf_failed");

    await vi.waitFor(() => {
      expect(manager.get(started.agentId)).toMatchObject({ state: "failed", error: "provider down" });
      expect(manager.hasActive()).toBe(false);
    });
    expect(sessions[0]!.dispose).toHaveBeenCalledOnce();
  });

  it("disposes a completed live session immediately without a waiter", async () => {
    const { manager, sessions } = fixture();
    const started = await manager.start(request, scope);
    sessions[0]!.complete("Status: DONE", usage(2, 1));

    await vi.waitFor(() => {
      expect(sessions[0]!.dispose).toHaveBeenCalledOnce();
      expect(manager.hasActive()).toBe(false);
      expect(manager.get(started.agentId)?.state).toBe("completed");
    });
  });

  it("reports terminal persistence failure to an explicit waiter with the agent id", async () => {
    const { manager, sessions } = fixture({
      persist: (event) => {
        if (event.kind === "settled") throw new Error("registry disk full");
      },
    });
    const started = await manager.start(request, scope);
    const waiting = manager.wait(started.agentId);
    sessions[0]!.complete("Status: DONE", usage(1, 1));

    const error = await waiting.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(SubagentOperationError);
    expect(error).toMatchObject({ agentId: started.agentId, message: "registry disk full" });
  });

  it("observes managed persistence rejection synchronously for background runs", async () => {
    const unhandled = vi.fn();
    const onUnhandled = (error: unknown): void => unhandled(error);
    process.on("unhandledRejection", onUnhandled);
    try {
      const { manager, sessions } = fixture({
        persist: (event) => {
          if (event.kind === "settled") throw new Error("registry disk full");
        },
      });
      await manager.start(request, scope);
      sessions[0]!.complete("Status: DONE", usage(1, 1));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(unhandled).not.toHaveBeenCalled();
      expect(sessions[0]!.dispose).toHaveBeenCalledOnce();
      expect(manager.hasActive()).toBe(false);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("AgentManager admission and identity", () => {
  it("enforces four active children atomically", async () => {
    const sessions = Array.from({ length: 5 }, () => fakeSession());
    const { manager } = fixture({ sessions });
    const started = await Promise.all(
      [0, 1, 2, 3].map((index) =>
        manager.start({ ...request, description: `agent ${index}` }, scope),
      ),
    );

    await expect(
      manager.start({ ...request, description: "agent 4" }, scope),
    ).rejects.toThrow("Active subagent limit reached (4)");

    await Promise.all(
      started.map((value, index) => settle(manager, sessions[index]!, value.agentId)),
    );
  });

  it("prevents simultaneous starts from passing a one-slot reservation", async () => {
    const session = fakeSession();
    const setup = deferred<ReturnType<typeof fakeBundle>>();
    const { manager } = fixture({
      sessions: [session],
      maxActive: 1,
      createFresh: async () => setup.promise,
    });

    const first = manager.start(request, scope);
    await expect(manager.start({ ...request, description: "second" }, scope)).rejects.toThrow(
      "Active subagent limit reached (1)",
    );
    setup.resolve(fakeBundle(session));
    const started = await first;
    await settle(manager, session, started.agentId);
  });

  it("retries agent and run id collisions against current branch records", async () => {
    const agentIds = ["sa_existing", "sa_unique"];
    const runIds = ["run_existing", "run_unique"];
    const session = fakeSession();
    const { manager } = fixture({
      sessions: [session],
      seed: seedEvents(),
      createAgentId: () => agentIds.shift() ?? "sa_unexpected",
      createRunId: () => runIds.shift() ?? "run_unexpected",
    });

    const started = await manager.start(request, scope);
    expect(started).toEqual({ agentId: "sa_unique", runId: "run_unique", state: "working" });
    await settle(manager, session, started.agentId);
  });

  it("does not reuse a run id retained by a removed durable agent", async () => {
    const removedSeed: RegistryEvent[] = [
      ...seedEvents(),
      {
        version: REGISTRY_VERSION,
        kind: "removed",
        agentId: "sa_existing",
        at: 4,
      },
    ];
    const runIds = ["run_existing", "run_unique"];
    const session = fakeSession();
    const { manager } = fixture({
      sessions: [session],
      seed: removedSeed,
      createRunId: () => runIds.shift() ?? "run_unexpected",
    });

    const started = await manager.start(request, scope);
    expect(started.runId).toBe("run_unique");
    await settle(manager, session, started.agentId);
  });

  it("fails after 100 repeated run id collisions without creating an agent", async () => {
    const { manager, createFresh } = fixture({
      seed: seedEvents(),
      createRunId: () => "run_existing",
    });

    await expect(manager.start(request, scope)).rejects.toThrow(
      "Unable to generate a unique run id after 100 attempts",
    );
    expect(createFresh).not.toHaveBeenCalled();
    expect(manager.hasActive()).toBe(false);
    expect(manager.list()).toHaveLength(1);
  });

  it("fails after 100 repeated agent id collisions without starting setup", async () => {
    const { manager, createFresh } = fixture({
      seed: seedEvents(),
      createAgentId: () => "sa_existing",
    });

    await expect(manager.start(request, scope)).rejects.toThrow(
      "Unable to generate a unique subagent id after 100 attempts",
    );
    expect(createFresh).not.toHaveBeenCalled();
    expect(manager.hasActive()).toBe(false);
    expect(manager.list()).toHaveLength(1);
  });
});

describe("AgentManager subscriptions", () => {
  it("makes the live transcript subscribable from the working roster notification", async () => {
    const { manager, sessions } = fixture();
    const transcriptSnapshots: TranscriptRecord[][] = [];
    let unsubscribeTranscript = (): void => undefined;
    const unsubscribeRoster = manager.subscribe((records) => {
      const working = records.find((record) => record.state === "working");
      if (working && transcriptSnapshots.length === 0) {
        unsubscribeTranscript = manager.subscribeTranscript(working.id, (snapshot) => {
          transcriptSnapshots.push(snapshot);
        });
      }
    });

    const started = await manager.start(request, scope);
    expect(transcriptSnapshots).toHaveLength(1);
    sessions[0]!.emit({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 2,
      delayMs: 1,
      errorMessage: "visible live update",
    });
    expect(transcriptSnapshots).toHaveLength(2);
    expect(transcriptSnapshots[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining("visible live update") }),
      ]),
    );

    unsubscribeTranscript();
    unsubscribeRoster();
    await settle(manager, sessions[0]!, started.agentId);
  });

  it("sends immediate and later defensive roster snapshots and can unsubscribe", async () => {
    const { manager, sessions } = fixture();
    const snapshots: AgentRecord[][] = [];
    const unsubscribe = manager.subscribe((records) => {
      snapshots.push(records);
      if (records[0]) records[0].description = "mutated subscriber copy";
    });
    expect(snapshots).toEqual([[]]);

    const started = await manager.start(request, scope);
    expect(snapshots.length).toBeGreaterThanOrEqual(3);
    expect(manager.get(started.agentId)?.description).toBe("implement task");
    const calls = snapshots.length;
    unsubscribe();
    sessions[0]!.complete("Status: DONE", usage(1, 1));
    await manager.wait(started.agentId);
    expect(snapshots).toHaveLength(calls);
  });

  it("streams bounded defensive transcript snapshots without copying text into roster", async () => {
    const { manager, sessions } = fixture();
    const started = await manager.start(request, scope);
    for (let index = 0; index < 2_005; index += 1) {
      sessions[0]!.emit({
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 2,
        delayMs: 1,
        errorMessage: `retry-${index}`,
      });
    }
    const snapshots: Array<Array<{ text: string }>> = [];
    const unsubscribe = manager.subscribeTranscript(started.agentId, (records) => {
      snapshots.push(records);
      if (snapshots.length === 1 && records[0]) records[0].text = "mutated";
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.length).toBeLessThanOrEqual(2_000);
    expect(snapshots[0]!.at(-1)?.text).toContain("retry-2004");
    sessions[0]!.emit({
      type: "auto_retry_end",
      success: true,
      attempt: 1,
    });
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]![0]?.text).not.toBe("mutated");
    expect(JSON.stringify(manager.list())).not.toContain("retry-2004");

    unsubscribe();
    const calls = snapshots.length;
    sessions[0]!.emit({ type: "agent_settled" });
    expect(snapshots).toHaveLength(calls);
    await settle(manager, sessions[0]!, started.agentId);
  });

  it("removes throwing subscribers without breaking lifecycle persistence", async () => {
    const { manager, sessions, persisted } = fixture();
    const roster = vi.fn(() => {
      throw new Error("roster failed");
    });
    manager.subscribe(roster);

    const started = await manager.start(request, scope);
    const transcript = vi.fn(() => {
      throw new Error("transcript failed");
    });
    manager.subscribeTranscript(started.agentId, transcript);
    sessions[0]!.emit({ type: "agent_start" });
    sessions[0]!.complete("Status: DONE", usage(1, 1));
    await manager.wait(started.agentId);

    expect(roster).toHaveBeenCalledOnce();
    expect(transcript).toHaveBeenCalledOnce();
    expect(persisted).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "settled" })]));
  });
});
