import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentRecord, AgentRunRecord, ContextManifest, RegistryEvent } from "./types.ts";
import { CUSTOM_ENTRY_TYPE, REGISTRY_VERSION } from "./types.ts";

export type AppendRegistryEvent = (event: RegistryEvent) => void;

function withoutError(record: AgentRecord): AgentRecord {
  const copy = structuredClone(record);
  delete copy.error;
  return copy;
}

function manifestMetadata(manifest: ContextManifest | undefined): Partial<AgentRecord> {
  if (!manifest) return {};
  return {
    manifest: structuredClone(manifest),
    cwd: manifest.cwd,
    model: manifest.model,
    thinkingLevel: manifest.thinkingLevel,
  };
}

export class AgentRegistry {
  private records = new Map<string, AgentRecord>();

  private constructor(
    events: readonly RegistryEvent[],
    private readonly persist: AppendRegistryEvent,
  ) {
    for (const event of events) this.apply(event);
  }

  static fromEntries(entries: readonly SessionEntry[], persist: AppendRegistryEvent): AgentRegistry {
    const events = entries.flatMap((entry) => {
      if (entry.type !== "custom" || entry.customType !== CUSTOM_ENTRY_TYPE) return [];
      const value = entry.data as RegistryEvent | undefined;
      return value?.version === REGISTRY_VERSION ? [value] : [];
    });
    return new AgentRegistry(events, persist);
  }

  static fromEvents(events: readonly RegistryEvent[], persist: AppendRegistryEvent): AgentRegistry {
    return new AgentRegistry(events, persist);
  }

  get(agentId: string): AgentRecord | undefined {
    const record = this.records.get(agentId);
    return record ? structuredClone(record) : undefined;
  }

  list(): AgentRecord[] {
    return [...this.records.values()]
      .filter((record) => record.state !== "removed")
      .map((record) => structuredClone(record));
  }

  append(event: RegistryEvent): void {
    const before = new Map(this.records);
    try {
      this.apply(event);
      this.persist(event);
    } catch (error) {
      this.records = before;
      throw error;
    }
  }

  claimUsage(agentId: string, runId: string, at = Date.now()): AgentRunRecord["usage"] | undefined {
    const record = this.require(agentId);
    const run = record.runs.find((value) => value.runId === runId);
    if (!run?.usage || run.usageClaimed) return undefined;
    this.append({ version: REGISTRY_VERSION, kind: "usage_claimed", agentId, runId, at });
    return structuredClone(run.usage);
  }

  markStaleInterrupted(
    at: number,
    resolveLeaf: (record: AgentRecord) => string | null = (record) => record.childLeafId ?? null,
  ): void {
    for (const record of this.records.values()) {
      if (record.state !== "working" && record.state !== "starting") continue;
      const run = record.runs.at(-1);
      this.append({
        version: REGISTRY_VERSION,
        kind: "interrupted",
        state: "interrupted",
        agentId: record.id,
        runId: run?.runId ?? null,
        childLeafId: resolveLeaf(structuredClone(record)),
        error: "Controller stopped while child was active",
        at,
      });
    }
  }

  remove(agentId: string, at = Date.now()): void {
    const record = this.require(agentId);
    if (record.state === "starting" || record.state === "working") {
      throw new Error(`Cannot remove active agent ${agentId}`);
    }
    this.append({ version: REGISTRY_VERSION, kind: "removed", agentId, at });
  }

  private require(agentId: string): AgentRecord {
    const record = this.records.get(agentId);
    if (!record) throw new Error(`Unknown subagent: ${agentId}`);
    return record;
  }

  private apply(event: RegistryEvent): void {
    if (event.kind === "created") {
      if (this.records.has(event.agentId)) throw new Error(`Duplicate subagent: ${event.agentId}`);
      if (event.record.id !== event.agentId || event.record.state !== "starting" || event.record.runs.length !== 0) {
        throw new Error(`Invalid created event for ${event.agentId}`);
      }
      this.records.set(event.agentId, structuredClone(event.record));
      return;
    }

    const record = this.require(event.agentId);
    if (record.state === "removed") throw new Error(`Agent is removed: ${event.agentId}`);

    if (event.kind === "started" || event.kind === "resumed") {
      const allowed = event.kind === "started"
        ? record.state === "starting"
        : !["starting", "working"].includes(record.state);
      if (!allowed || record.runs.some((run) => run.runId === event.run.runId)) {
        throw new Error(`Invalid registry transition: ${record.state} -> ${event.kind}`);
      }
      this.records.set(event.agentId, {
        ...withoutError(record),
        state: "working",
        updatedAt: event.at,
        childLeafId: event.childLeafId,
        runs: [...record.runs, structuredClone(event.run)],
        ...(event.sessionFile ? { sessionFile: event.sessionFile } : {}),
        ...manifestMetadata(event.manifest),
      });
      return;
    }

    if (event.kind === "usage_claimed") {
      const runIndex = record.runs.findIndex((run) => run.runId === event.runId);
      const run = record.runs[runIndex];
      if (!run?.usage) throw new Error(`Unknown or unsettled run: ${event.runId}`);
      if (run.usageClaimed) return;
      const runs = record.runs.map((value, index) =>
        index === runIndex ? { ...value, usageClaimed: true } : value,
      );
      this.records.set(event.agentId, { ...record, updatedAt: event.at, runs });
      return;
    }

    if (event.kind === "removed") {
      if (record.state === "starting" || record.state === "working") {
        throw new Error(`Cannot remove active agent ${event.agentId}`);
      }
      this.records.set(event.agentId, { ...record, state: "removed", updatedAt: event.at });
      return;
    }

    if (record.state === "starting" && (event.kind !== "interrupted" || event.runId !== null)) {
      if (!event.run || event.run.runId !== event.runId || !["failed", "aborted", "interrupted"].includes(event.state)) {
        throw new Error(`Invalid registry transition: starting -> ${event.kind}`);
      }
      const run: AgentRunRecord = {
        ...structuredClone(event.run),
        settledAt: event.at,
        childLeafId: event.childLeafId,
        ...(event.usage ? { usage: structuredClone(event.usage) } : {}),
      };
      this.records.set(event.agentId, {
        ...withoutError(record),
        state: event.state,
        updatedAt: event.at,
        childLeafId: event.childLeafId,
        runs: [...record.runs, run],
        ...(event.sessionFile ? { sessionFile: event.sessionFile } : {}),
        ...manifestMetadata(event.manifest),
        ...(event.error ? { error: event.error } : {}),
      });
      return;
    }

    if (event.kind === "interrupted" && event.runId === null) {
      if (record.state !== "starting") {
        throw new Error(`Invalid registry transition: ${record.state} -> interrupted`);
      }
      this.records.set(event.agentId, {
        ...record,
        state: "interrupted",
        updatedAt: event.at,
        childLeafId: event.childLeafId,
        ...(event.error ? { error: event.error } : {}),
      });
      return;
    }

    if (record.state !== "working") {
      throw new Error(`Invalid registry transition: ${record.state} -> ${event.kind}`);
    }
    const runIndex = record.runs.length - 1;
    const activeRun = record.runs[runIndex];
    if (!activeRun || activeRun.runId !== event.runId || activeRun.settledAt !== undefined) {
      throw new Error(`Unknown active run: ${event.runId}`);
    }
    const runs = record.runs.map((run, index) =>
      index === runIndex
        ? {
            ...run,
            settledAt: event.at,
            childLeafId: event.childLeafId,
            ...(event.usage ? { usage: structuredClone(event.usage) } : {}),
          }
        : run,
    );
    const next: AgentRecord = {
      ...withoutError(record),
      state: event.state,
      updatedAt: event.at,
      childLeafId: event.childLeafId,
      runs,
      ...(event.sessionFile ? { sessionFile: event.sessionFile } : {}),
      ...manifestMetadata(event.manifest),
    };
    if (event.error !== undefined) next.error = event.error;
    this.records.set(event.agentId, next);
  }
}
