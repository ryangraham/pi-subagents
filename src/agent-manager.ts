import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { ChildRun } from "./child-run.ts";
import { AgentRegistry } from "./registry.ts";
import { extractFinalAssistantText, hashPrompt, ZERO_USAGE } from "./result.ts";
import type { SessionFactory } from "./session-factory.ts";
import type {
  AgentOutcome,
  AgentRecord,
  AgentRunRecord,
  ClaimedOutcome,
  ControllerScope,
  DispatchRequest,
  RegistryEvent,
  StartResult,
  TranscriptRecord,
} from "./types.ts";
import { MAX_ACTIVE_AGENTS, REGISTRY_VERSION } from "./types.ts";

export class SubagentOperationError extends Error {
  constructor(
    readonly agentId: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SubagentOperationError";
  }
}

export interface AgentManagerDependencies {
  factory: Pick<SessionFactory, "createFresh" | "reopen">;
  registry: AgentRegistry;
  createAgentId?: () => string;
  createRunId?: () => string;
  now?: () => number;
  maxActive?: number;
}

type AbortTerminalState = "aborted" | "interrupted";
type RosterListener = (records: AgentRecord[]) => void;

interface ActiveRun {
  agentId: string;
  runId: string;
  child: ChildRun;
  managedCompletion: Promise<AgentOutcome>;
}

interface SetupHandle {
  startResult: StartResult;
  active?: ActiveRun;
  outcome?: AgentOutcome;
}

interface PendingSetup {
  agentId: string;
  runId: string;
  completion: Promise<SetupHandle>;
  requestedTerminalState?: AbortTerminalState;
  removeSignalListener?: () => void;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    rejectPromise = rejectValue;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function describeError(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "Unknown subagent failure";
  }
}

function cloneUsage(usage: Usage): Usage {
  return structuredClone(usage);
}

export class AgentManager {
  readonly #factory: AgentManagerDependencies["factory"];
  readonly #registry: AgentRegistry;
  readonly #createAgentId: () => string;
  readonly #createRunId: () => string;
  readonly #now: () => number;
  readonly #maxActive: number;
  readonly #active = new Map<string, ActiveRun>();
  readonly #pendingSetups = new Map<string, PendingSetup>();
  readonly #rosterListeners = new Set<RosterListener>();
  #reservedSlots = 0;

  constructor(dependencies: AgentManagerDependencies) {
    this.#factory = dependencies.factory;
    this.#registry = dependencies.registry;
    this.#createAgentId = dependencies.createAgentId ?? (() => `sa_${randomBytes(4).toString("hex")}`);
    this.#createRunId = dependencies.createRunId ?? (() => `run_${randomBytes(4).toString("hex")}`);
    this.#now = dependencies.now ?? Date.now;
    this.#maxActive = dependencies.maxActive ?? MAX_ACTIVE_AGENTS;
    if (!Number.isInteger(this.#maxActive) || this.#maxActive <= 0) {
      throw new Error("maxActive must be a positive integer");
    }
  }

  start(request: DispatchRequest, scope: ControllerScope): Promise<StartResult> {
    return this.#beginFresh(request, scope).then((setup) => setup.startResult);
  }

  async run(
    request: DispatchRequest,
    scope: ControllerScope,
    signal?: AbortSignal,
  ): Promise<ClaimedOutcome> {
    const setup = await this.#beginFresh(request, scope, signal);
    if (setup.outcome) return this.#claim(setup.outcome);
    if (!setup.active) {
      throw new SubagentOperationError(setup.startResult.agentId, "Subagent setup produced no active run");
    }
    const outcome = await this.#waitForActive(setup.active, signal, true);
    return this.#claim(outcome);
  }

  async wait(agentId: string, signal?: AbortSignal): Promise<ClaimedOutcome> {
    const pending = this.#pendingSetups.get(agentId);
    if (pending) {
      let setup: SetupHandle;
      try {
        setup = await this.#waitForSetup(pending.completion, signal);
      } catch (error) {
        throw this.#asOperationError(agentId, error);
      }
      if (setup.outcome) return this.#claim(setup.outcome);
      if (setup.active) {
        const outcome = await this.#waitForActive(setup.active, signal, false);
        return this.#claim(outcome);
      }
    }

    const active = this.#active.get(agentId);
    if (active) {
      const outcome = await this.#waitForActive(active, signal, false);
      return this.#claim(outcome);
    }

    const record = this.#registry.get(agentId);
    if (!record) throw new SubagentOperationError(agentId, `Unknown subagent: ${agentId}`);
    const outcome = this.#reconstructOutcome(record);
    return this.#claim(outcome);
  }

  list(): AgentRecord[] {
    return this.#registry.list();
  }

  get(agentId: string): AgentRecord | undefined {
    return this.#registry.get(agentId);
  }

  hasActive(): boolean {
    return this.#active.size > 0 || this.#pendingSetups.size > 0 || this.#reservedSlots > 0;
  }

  subscribe(listener: RosterListener): () => void {
    this.#rosterListeners.add(listener);
    try {
      listener(this.list());
    } catch {
      this.#rosterListeners.delete(listener);
      return () => undefined;
    }
    return () => {
      this.#rosterListeners.delete(listener);
    };
  }

  subscribeTranscript(
    agentId: string,
    listener: (records: TranscriptRecord[]) => void,
  ): () => void {
    const active = this.#active.get(agentId);
    if (!active) return () => undefined;

    try {
      listener(active.child.transcript.snapshot());
    } catch {
      return () => undefined;
    }

    let unsubscribe = (): void => undefined;
    const relay = (): void => {
      try {
        listener(active.child.transcript.snapshot());
      } catch {
        unsubscribe();
      }
    };
    unsubscribe = active.child.transcript.subscribe(relay);
    return () => unsubscribe();
  }

  #beginFresh(
    request: DispatchRequest,
    scope: ControllerScope,
    signal?: AbortSignal,
  ): Promise<SetupHandle> {
    if (this.#active.size + this.#reservedSlots >= this.#maxActive) {
      return Promise.reject(new Error(`Active subagent limit reached (${this.#maxActive})`));
    }
    this.#reservedSlots += 1;

    let agentId: string;
    let runId: string;
    let run: AgentRunRecord;
    let createdAt: number;
    try {
      agentId = this.#uniqueAgentId();
      runId = this.#uniqueRunId();
      createdAt = this.#now();
      run = {
        runId,
        index: 1,
        promptSha256: hashPrompt(request.prompt),
        startedAt: createdAt,
        usageClaimed: false,
      };
      const record: AgentRecord = {
        id: agentId,
        description: request.description,
        cwd: resolve(scope.cwd, request.cwd ?? "."),
        model: request.model,
        state: "starting",
        createdAt,
        updatedAt: createdAt,
        runs: [],
      };
      this.#registry.append({
        version: REGISTRY_VERSION,
        kind: "created",
        agentId,
        at: createdAt,
        record,
      });
    } catch (error) {
      this.#reservedSlots -= 1;
      return Promise.reject(error);
    }

    const setupDeferred = deferred<SetupHandle>();
    const pending: PendingSetup = {
      agentId,
      runId,
      completion: setupDeferred.promise,
    };
    this.#pendingSetups.set(agentId, pending);

    if (signal) {
      const onAbort = (): void => {
        pending.requestedTerminalState ??= "aborted";
      };
      signal.addEventListener("abort", onAbort, { once: true });
      pending.removeSignalListener = () => signal.removeEventListener("abort", onAbort);
      if (signal.aborted) onAbort();
    }

    this.#notifyRoster();
    void this.#initializeFresh(request, scope, run, pending).then(
      setupDeferred.resolve,
      (error) => setupDeferred.reject(this.#asOperationError(agentId, error)),
    );
    // A roster subscriber may observe and ignore this setup. Keep a rejection
    // observer attached even when no public start waiter survives.
    void setupDeferred.promise.catch(() => undefined);
    return setupDeferred.promise;
  }

  async #initializeFresh(
    request: DispatchRequest,
    scope: ControllerScope,
    run: AgentRunRecord,
    pending: PendingSetup,
  ): Promise<SetupHandle> {
    let bundle: Awaited<ReturnType<AgentManagerDependencies["factory"]["createFresh"]>> | undefined;
    let started = false;
    let reservationHeld = true;
    try {
      try {
        bundle = await this.#factory.createFresh({
          parentSessionId: scope.parentSessionId,
          parentCwd: scope.cwd,
          request,
          projectTrusted: scope.projectTrusted,
        });
      } catch (error) {
        let failure = error;
        try {
          this.#persistSetupFailure(pending.agentId, run, error);
        } catch (persistenceError) {
          failure = persistenceError;
        }
        throw this.#asOperationError(pending.agentId, failure);
      }

      try {
        this.#registry.append({
          version: REGISTRY_VERSION,
          kind: "started",
          state: "working",
          agentId: pending.agentId,
          at: this.#now(),
          run,
          ...(bundle.session.sessionFile ? { sessionFile: bundle.session.sessionFile } : {}),
          childLeafId: this.#readLeaf(bundle),
          manifest: bundle.manifest,
        });
        started = true;
      } catch (error) {
        let failure = error;
        try {
          this.#persistSetupFailure(pending.agentId, run, error, bundle);
        } catch (persistenceError) {
          failure = persistenceError;
        } finally {
          this.#disposeBundle(bundle);
        }
        throw this.#asOperationError(pending.agentId, failure);
      }

      const startResult: StartResult = {
        agentId: pending.agentId,
        runId: pending.runId,
        state: "working",
      };

      if (pending.requestedTerminalState) {
        this.#notifyRoster();
        try {
          await bundle.session.abort();
        } catch {
          // The durable requested terminal state still wins if idle-session abort cleanup fails.
        }
        const outcome = this.#unpromptedOutcome(
          pending.agentId,
          run,
          pending.requestedTerminalState,
          bundle,
        );
        try {
          this.#persistOutcome(outcome);
        } finally {
          this.#disposeBundle(bundle);
        }
        return { startResult, outcome };
      }

      let child: ChildRun;
      try {
        child = ChildRun.launch({
          agentId: pending.agentId,
          runId: pending.runId,
          prompt: request.prompt,
          bundle,
          startedAt: run.startedAt,
          now: this.#now,
        });
      } catch (error) {
        this.#notifyRoster();
        let failure = error;
        try {
          this.#persistSetupFailure(pending.agentId, run, error, bundle, started);
        } catch (persistenceError) {
          failure = persistenceError;
        } finally {
          this.#disposeBundle(bundle);
        }
        throw this.#asOperationError(pending.agentId, failure);
      }

      const active = this.#activate(child, pending.agentId, pending.runId);
      this.#reservedSlots -= 1;
      reservationHeld = false;
      this.#notifyRoster();
      return { startResult, active };
    } finally {
      pending.removeSignalListener?.();
      if (this.#pendingSetups.get(pending.agentId) === pending) {
        this.#pendingSetups.delete(pending.agentId);
      }
      if (reservationHeld) this.#reservedSlots -= 1;
    }
  }

  #activate(child: ChildRun, agentId: string, runId: string): ActiveRun {
    let active!: ActiveRun;
    const managedCompletion = child.completion
      .then((outcome) => {
        try {
          this.#persistOutcome(outcome);
          return outcome;
        } catch (error) {
          this.#notifyRoster();
          throw this.#asOperationError(agentId, error);
        }
      })
      .finally(() => {
        if (this.#active.get(agentId) === active) this.#active.delete(agentId);
        child.dispose();
      });
    active = { agentId, runId, child, managedCompletion };
    this.#active.set(agentId, active);
    // Background completion must be observed before start() can return.
    void managedCompletion.catch(() => undefined);
    return active;
  }

  async #waitForActive(
    active: ActiveRun,
    signal: AbortSignal | undefined,
    abortOnCancel: boolean,
  ): Promise<AgentOutcome> {
    try {
      await active.child.wait(signal, abortOnCancel);
      return await active.managedCompletion;
    } catch (error) {
      throw this.#asOperationError(active.agentId, error);
    }
  }

  #waitForSetup(completion: Promise<SetupHandle>, signal?: AbortSignal): Promise<SetupHandle> {
    if (!signal) return completion;
    if (signal.aborted) return Promise.reject(new Error("Waiting cancelled"));
    return new Promise<SetupHandle>((resolveValue, rejectValue) => {
      let finished = false;
      const cleanup = (): void => signal.removeEventListener("abort", onAbort);
      const onAbort = (): void => {
        if (finished) return;
        finished = true;
        cleanup();
        rejectValue(new Error("Waiting cancelled"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      void completion.then(
        (setup) => {
          if (finished) return;
          finished = true;
          cleanup();
          resolveValue(setup);
        },
        (error) => {
          if (finished) return;
          finished = true;
          cleanup();
          rejectValue(error);
        },
      );
    });
  }

  #persistSetupFailure(
    agentId: string,
    run: AgentRunRecord,
    error: unknown,
    bundle?: Awaited<ReturnType<AgentManagerDependencies["factory"]["createFresh"]>>,
    started = false,
  ): void {
    const at = this.#now();
    const message = describeError(error);
    const metadata = bundle
      ? {
          ...(bundle.session.sessionFile ? { sessionFile: bundle.session.sessionFile } : {}),
          childLeafId: this.#readLeaf(bundle),
          manifest: bundle.manifest,
        }
      : { childLeafId: null };
    this.#appendRegistry({
      version: REGISTRY_VERSION,
      kind: "settled",
      state: "failed",
      agentId,
      runId: run.runId,
      at,
      ...(!started ? { run } : {}),
      ...metadata,
      error: message,
      ...(started ? { usage: cloneUsage(ZERO_USAGE) } : {}),
    });
  }

  #unpromptedOutcome(
    agentId: string,
    run: AgentRunRecord,
    state: AbortTerminalState,
    bundle: Awaited<ReturnType<AgentManagerDependencies["factory"]["createFresh"]>>,
  ): AgentOutcome {
    const sessionFile = bundle.session.sessionFile;
    return {
      agentId,
      runId: run.runId,
      state,
      finalText: "",
      error: state === "aborted" ? "Subagent aborted before prompt" : "Controller interrupted before prompt",
      ...(sessionFile ? { sessionFile } : {}),
      childLeafId: this.#readLeaf(bundle),
      usage: cloneUsage(ZERO_USAGE),
      startedAt: run.startedAt,
      settledAt: this.#now(),
      manifest: structuredClone(bundle.manifest),
    };
  }

  #persistOutcome(outcome: AgentOutcome): void {
    const metadata = {
      version: REGISTRY_VERSION,
      agentId: outcome.agentId,
      runId: outcome.runId,
      at: outcome.settledAt,
      ...(outcome.sessionFile ? { sessionFile: outcome.sessionFile } : {}),
      childLeafId: outcome.childLeafId,
      ...(outcome.manifest ? { manifest: outcome.manifest } : {}),
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
      usage: cloneUsage(outcome.usage),
    };
    let event: RegistryEvent;
    if (outcome.state === "aborted") {
      event = { ...metadata, kind: "aborted", state: "aborted" };
    } else if (outcome.state === "interrupted") {
      event = { ...metadata, kind: "interrupted", state: "interrupted" };
    } else {
      event = { ...metadata, kind: "settled", state: outcome.state };
    }
    this.#appendRegistry(event);
  }

  #reconstructOutcome(record: AgentRecord): AgentOutcome {
    if (record.state === "starting" || record.state === "working" || record.state === "removed") {
      throw new SubagentOperationError(record.id, `Subagent is not terminal: ${record.id}`);
    }
    const run = record.runs.at(-1);
    if (!run) throw new SubagentOperationError(record.id, `Subagent has no recorded run: ${record.id}`);

    let finalText = "";
    if (record.sessionFile && record.childLeafId) {
      try {
        const sessionManager = SessionManager.open(record.sessionFile);
        const context = buildSessionContext(sessionManager.getEntries(), record.childLeafId);
        finalText = extractFinalAssistantText(context.messages);
      } catch (error) {
        throw this.#asOperationError(record.id, error);
      }
    }

    return {
      agentId: record.id,
      runId: run.runId,
      state: record.state,
      finalText,
      ...(record.error === undefined ? {} : { error: record.error }),
      ...(record.sessionFile === undefined ? {} : { sessionFile: record.sessionFile }),
      childLeafId: record.childLeafId ?? null,
      usage: cloneUsage(run.usage ?? ZERO_USAGE),
      startedAt: run.startedAt,
      settledAt: run.settledAt ?? record.updatedAt,
      ...(record.manifest === undefined ? {} : { manifest: structuredClone(record.manifest) }),
    };
  }

  #claim(outcome: AgentOutcome): ClaimedOutcome {
    let claimedUsage: Usage | undefined;
    try {
      claimedUsage = this.#registry.claimUsage(outcome.agentId, outcome.runId, this.#now());
    } catch (error) {
      throw this.#asOperationError(outcome.agentId, error);
    }
    if (claimedUsage) this.#notifyRoster();
    return {
      outcome,
      ...(claimedUsage === undefined ? {} : { claimedUsage }),
    };
  }

  #uniqueAgentId(): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = this.#createAgentId();
      if (!this.#registry.get(candidate) && !this.#pendingSetups.has(candidate) && !this.#active.has(candidate)) {
        return candidate;
      }
    }
    throw new Error("Unable to generate a unique subagent id after 100 attempts");
  }

  #uniqueRunId(): string {
    const inMemory = new Set<string>();
    for (const pending of this.#pendingSetups.values()) inMemory.add(pending.runId);
    for (const active of this.#active.values()) inMemory.add(active.runId);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = this.#createRunId();
      if (!this.#registry.hasRunId(candidate) && !inMemory.has(candidate)) return candidate;
    }
    throw new Error("Unable to generate a unique run id after 100 attempts");
  }

  #appendRegistry(event: RegistryEvent): void {
    this.#registry.append(event);
    this.#notifyRoster();
  }

  #notifyRoster(): void {
    for (const listener of [...this.#rosterListeners]) {
      try {
        listener(this.list());
      } catch {
        this.#rosterListeners.delete(listener);
      }
    }
  }

  #readLeaf(bundle: Awaited<ReturnType<AgentManagerDependencies["factory"]["createFresh"]>>): string | null {
    try {
      return bundle.session.sessionManager.getLeafId();
    } catch {
      return null;
    }
  }

  #disposeBundle(bundle: Awaited<ReturnType<AgentManagerDependencies["factory"]["createFresh"]>>): void {
    try {
      bundle.session.dispose();
    } catch {
      // Setup cleanup is best effort; the durable outcome is authoritative.
    }
  }

  #asOperationError(agentId: string, error: unknown): SubagentOperationError {
    if (error instanceof SubagentOperationError) return error;
    return new SubagentOperationError(agentId, describeError(error), { cause: error });
  }
}
