import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { AgentRegistry } from "../src/registry.ts";
import {
  CUSTOM_ENTRY_TYPE,
  REGISTRY_VERSION,
  type AgentRecord,
  type AgentRunRecord,
  type ContextManifest,
  type RegistryEvent,
} from "../src/types.ts";

const AGENT_ID = "sa_1234abcd";
const RUN_ID = "run_1";

const usage = (input = 7, output = 3): Usage => ({
  input,
  output,
  cacheRead: 2,
  cacheWrite: 1,
  totalTokens: input + output + 3,
  cost: { input: 0.7, output: 0.3, cacheRead: 0.2, cacheWrite: 0.1, total: 1.3 },
});

const manifest = (overrides: Partial<ContextManifest> = {}): ContextManifest => ({
  cwd: "/repo",
  model: "fake/worker",
  thinkingLevel: "off" as ThinkingLevel,
  tools: ["read", "bash", "edit", "write"],
  contextFiles: ["/repo/AGENTS.md"],
  skills: [{ name: "example", path: "/agent/skills/example/SKILL.md" }],
  parentHistoryIncluded: false,
  extensionsDisabled: true,
  promptTemplatesDisabled: true,
  themesDisabled: true,
  customSystemPromptsDisabled: true,
  agentDefinitionsDisabled: true,
  dispatchBytes: 12,
  dispatchSha256: "a".repeat(64),
  ...overrides,
});

const runRecord = (overrides: Partial<AgentRunRecord> = {}): AgentRunRecord => ({
  runId: RUN_ID,
  index: 1,
  promptSha256: "b".repeat(64),
  startedAt: 100,
  usageClaimed: false,
  ...overrides,
});

const createdRecord = (overrides: Partial<AgentRecord> = {}): AgentRecord => ({
  id: AGENT_ID,
  description: "implement task",
  cwd: "/repo",
  model: "fake/worker",
  state: "starting",
  createdAt: 100,
  updatedAt: 100,
  runs: [],
  ...overrides,
});

const createdEvent = (record = createdRecord()): RegistryEvent => ({
  version: REGISTRY_VERSION,
  kind: "created",
  agentId: record.id,
  at: record.createdAt,
  record,
});

const startedEvent = (run = runRecord()): RegistryEvent => ({
  version: REGISTRY_VERSION,
  kind: "started",
  agentId: AGENT_ID,
  at: 110,
  state: "working",
  run,
  sessionFile: "/sessions/child.jsonl",
  childLeafId: "leaf_started",
  manifest: manifest(),
});

const settledEvent = (overrides: Partial<Extract<RegistryEvent, { kind: "settled" }>> = {}): RegistryEvent => ({
  version: REGISTRY_VERSION,
  kind: "settled",
  agentId: AGENT_ID,
  at: 200,
  runId: RUN_ID,
  state: "completed",
  sessionFile: "/sessions/child.jsonl",
  childLeafId: "leaf_done",
  manifest: manifest(),
  usage: usage(),
  ...overrides,
});

const usageClaimedEvent = (): RegistryEvent => ({
  version: REGISTRY_VERSION,
  kind: "usage_claimed",
  agentId: AGENT_ID,
  runId: RUN_ID,
  at: 210,
});

const customEntry = (id: string, customType: string, data: unknown, parentId: string | null = null): SessionEntry => ({
  type: "custom",
  id,
  parentId,
  timestamp: "2026-08-16T00:00:00.000Z",
  customType,
  data,
});

describe("AgentRegistry folding", () => {
  it("folds only pi-subagents custom entries from the supplied active branch", () => {
    const append = vi.fn();
    const foreignEntry = customEntry("foreign", "another-extension", { version: REGISTRY_VERSION });
    const createdEntry = customEntry("created", CUSTOM_ENTRY_TYPE, createdEvent());
    const startedEntry = customEntry("started", CUSTOM_ENTRY_TYPE, startedEvent(), "created");
    const settledEntry = customEntry("settled", CUSTOM_ENTRY_TYPE, settledEvent(), "started");

    const registry = AgentRegistry.fromEntries([foreignEntry, createdEntry, startedEntry, settledEntry], append);

    expect(registry.list()).toHaveLength(1);
    expect(registry.get(AGENT_ID)?.state).toBe("completed");
    expect(append).not.toHaveBeenCalled();
  });

  it("ignores unsupported registry versions", () => {
    const unsupported = customEntry("future", CUSTOM_ENTRY_TYPE, {
      ...createdEvent(),
      version: REGISTRY_VERSION + 1,
    });

    expect(AgentRegistry.fromEntries([unsupported], vi.fn()).list()).toEqual([]);
  });

  it("keeps entries from another parent branch invisible when they are not supplied", () => {
    const registry = AgentRegistry.fromEntries(
      [customEntry("created", CUSTOM_ENTRY_TYPE, createdEvent())],
      vi.fn(),
    );

    expect(registry.get("sa_deadbeef")).toBeUndefined();
  });

  it("returns defensive record copies", () => {
    const registry = AgentRegistry.fromEvents([createdEvent(), startedEvent(), settledEvent()], vi.fn());
    const record = registry.get(AGENT_ID);
    if (!record) throw new Error("fixture record missing");
    record.description = "mutated";
    record.runs[0]!.usage!.input = 999;

    expect(registry.get(AGENT_ID)?.description).toBe("implement task");
    expect(registry.get(AGENT_ID)?.runs[0]?.usage?.input).toBe(7);
  });
});

describe("AgentRegistry transitions", () => {
  it("persists started metadata while moving to working", () => {
    const registry = AgentRegistry.fromEvents([createdEvent(), startedEvent()], vi.fn());

    expect(registry.get(AGENT_ID)).toMatchObject({
      state: "working",
      cwd: "/repo",
      model: "fake/worker",
      thinkingLevel: "off",
      sessionFile: "/sessions/child.jsonl",
      childLeafId: "leaf_started",
      runs: [expect.objectContaining({ runId: RUN_ID, usageClaimed: false })],
    });
  });

  it("rejects settlement before a run starts", () => {
    expect(() => AgentRegistry.fromEvents([createdEvent(), settledEvent()], vi.fn())).toThrow(
      "Invalid registry transition",
    );
  });

  it("allows a fresh setup failure to settle directly from starting", () => {
    const failed: RegistryEvent = {
      version: REGISTRY_VERSION,
      kind: "settled",
      agentId: AGENT_ID,
      at: 200,
      runId: RUN_ID,
      state: "failed",
      run: runRecord(),
      childLeafId: null,
      error: "model unavailable",
    };
    const registry = AgentRegistry.fromEvents([createdEvent(), failed], vi.fn());

    expect(registry.get(AGENT_ID)).toMatchObject({
      state: "failed",
      error: "model unavailable",
      childLeafId: null,
      runs: [expect.objectContaining({ runId: RUN_ID, settledAt: 200, childLeafId: null })],
    });
  });

  it("does not allow successful settlement directly from starting", () => {
    expect(() =>
      AgentRegistry.fromEvents([createdEvent(), settledEvent({ run: runRecord(), state: "completed" })], vi.fn()),
    ).toThrow("Invalid registry transition");
  });

  it("clears an earlier error when a new run starts and succeeds", () => {
    const firstRun = runRecord();
    const failed = settledEvent({ state: "failed", error: "provider down" });
    const secondRun = runRecord({ runId: "run_2", index: 2, startedAt: 300 });
    const resumed: RegistryEvent = {
      version: REGISTRY_VERSION,
      kind: "resumed",
      agentId: AGENT_ID,
      at: 300,
      state: "working",
      run: secondRun,
      sessionFile: "/sessions/child.jsonl",
      childLeafId: "leaf_done",
      manifest: manifest(),
    };
    const completed = settledEvent({
      at: 400,
      runId: "run_2",
      childLeafId: "leaf_fix",
      usage: usage(1, 1),
    });
    const registry = AgentRegistry.fromEvents(
      [createdEvent(), startedEvent(firstRun), failed, resumed, completed],
      vi.fn(),
    );

    expect(registry.get(AGENT_ID)?.state).toBe("completed");
    expect(registry.get(AGENT_ID)?.error).toBeUndefined();
    expect(registry.get(AGENT_ID)?.runs).toHaveLength(2);
  });

  it("rejects a terminal event for an older run while a newer run is active", () => {
    const failed = settledEvent({ state: "failed", error: "first attempt failed" });
    const resumed: RegistryEvent = {
      version: REGISTRY_VERSION,
      kind: "resumed",
      agentId: AGENT_ID,
      at: 300,
      state: "working",
      run: runRecord({ runId: "run_2", index: 2, startedAt: 300 }),
      sessionFile: "/sessions/child.jsonl",
      childLeafId: "leaf_done",
      manifest: manifest(),
    };
    const staleTerminal = settledEvent({ at: 400, runId: RUN_ID, childLeafId: "leaf_stale" });
    const registry = AgentRegistry.fromEvents([createdEvent(), startedEvent(), failed, resumed], vi.fn());

    expect(() => registry.append(staleTerminal)).toThrow(`Unknown active run: ${RUN_ID}`);
    expect(registry.get(AGENT_ID)).toMatchObject({ state: "working", childLeafId: "leaf_done" });
  });

  it("persists terminal metadata and usage without final assistant text", () => {
    const failed = settledEvent({
      state: "failed",
      error: "provider down",
      sessionFile: "/sessions/final.jsonl",
      childLeafId: "leaf_error",
      manifest: manifest({ cwd: "/repo/subdir" }),
      usage: usage(11, 5),
    });
    const registry = AgentRegistry.fromEvents([createdEvent(), startedEvent(), failed], vi.fn());
    const record = registry.get(AGENT_ID);

    expect(record).toMatchObject({
      state: "failed",
      error: "provider down",
      cwd: "/repo/subdir",
      sessionFile: "/sessions/final.jsonl",
      childLeafId: "leaf_error",
      runs: [expect.objectContaining({ usage: usage(11, 5), childLeafId: "leaf_error" })],
    });
    expect(JSON.stringify(failed)).not.toContain("finalText");
    expect(JSON.stringify(record)).not.toContain("finalText");
  });

  it("blocks active removal and makes removed final", () => {
    const active = AgentRegistry.fromEvents([createdEvent(), startedEvent()], vi.fn());
    expect(() => active.remove(AGENT_ID, 300)).toThrow("Cannot remove active agent");

    const terminal = AgentRegistry.fromEvents([createdEvent(), startedEvent(), settledEvent()], vi.fn());
    terminal.remove(AGENT_ID, 300);
    expect(terminal.list()).toEqual([]);
    expect(terminal.get(AGENT_ID)?.state).toBe("removed");
    expect(() => terminal.append(usageClaimedEvent())).toThrow(`Agent is removed: ${AGENT_ID}`);
  });

  it("rolls the in-memory transition back when persistence fails", () => {
    const persist = vi.fn(() => {
      throw new Error("disk full");
    });
    const registry = AgentRegistry.fromEvents([createdEvent()], persist);

    expect(() => registry.append(startedEvent())).toThrow("disk full");
    expect(registry.get(AGENT_ID)).toMatchObject({ state: "starting", runs: [] });
  });
});

describe("AgentRegistry usage claims", () => {
  it("claims terminal usage once and persists usage_claimed", () => {
    const append = vi.fn();
    const runUsage = usage();
    const registry = AgentRegistry.fromEvents(
      [createdEvent(), startedEvent(), settledEvent({ usage: runUsage })],
      append,
    );

    expect(registry.claimUsage(AGENT_ID, RUN_ID, 500)).toEqual(runUsage);
    expect(registry.claimUsage(AGENT_ID, RUN_ID, 600)).toBeUndefined();
    expect(append).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "usage_claimed", runId: RUN_ID, at: 500 }),
    );
  });

  it("rejects a usage claim for an unknown run", () => {
    expect(() =>
      AgentRegistry.fromEvents(
        [
          createdEvent(),
          {
            version: REGISTRY_VERSION,
            kind: "usage_claimed",
            agentId: AGENT_ID,
            runId: "run_missing",
            at: 200,
          },
        ],
        vi.fn(),
      ),
    ).toThrow("Unknown or unsettled run: run_missing");
  });

  it("does not reclaim usage after reconstructing a persisted claim", () => {
    const append = vi.fn();
    const registry = AgentRegistry.fromEvents(
      [createdEvent(), startedEvent(), settledEvent(), usageClaimedEvent()],
      append,
    );

    expect(registry.claimUsage(AGENT_ID, RUN_ID)).toBeUndefined();
    expect(append).not.toHaveBeenCalled();
  });
});

describe("AgentRegistry stale recovery", () => {
  it("marks a stale working agent interrupted exactly once", () => {
    const append = vi.fn();
    const registry = AgentRegistry.fromEvents([createdEvent(), startedEvent()], append);

    registry.markStaleInterrupted(5_000, () => "leaf_recovered");
    registry.markStaleInterrupted(6_000, () => "leaf_wrong");

    expect(registry.get(AGENT_ID)).toMatchObject({
      state: "interrupted",
      childLeafId: "leaf_recovered",
      error: "Controller stopped while child was active",
      runs: [expect.objectContaining({ settledAt: 5_000, childLeafId: "leaf_recovered" })],
    });
    expect(append).toHaveBeenCalledOnce();
  });

  it("interrupts a starting record with no run using a null run id", () => {
    const append = vi.fn();
    const registry = AgentRegistry.fromEvents([createdEvent()], append);

    registry.markStaleInterrupted(5_000);

    expect(registry.get(AGENT_ID)).toMatchObject({ state: "interrupted", runs: [], childLeafId: null });
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "interrupted", runId: null, childLeafId: null }),
    );
  });
});
