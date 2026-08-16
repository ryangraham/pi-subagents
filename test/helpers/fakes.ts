import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, StopReason, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import type {
  AgentSessionEvent,
  AgentSessionEventListener,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import type { ChildSessionBundle } from "../../src/session-factory.ts";
import type { ContextManifest } from "../../src/types.ts";

export const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function usage(input: number, output: number): Usage {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: {
      input: input / 1_000,
      output: output / 1_000,
      cacheRead: 0,
      cacheWrite: 0,
      total: (input + output) / 1_000,
    },
  };
}

export const fixedManifest: ContextManifest = {
  cwd: "/repo",
  model: "fake/worker",
  thinkingLevel: "off",
  tools: ["read", "bash", "edit", "write"],
  contextFiles: ["/repo/AGENTS.md"],
  skills: [{ name: "example", path: "/agent/skills/example/SKILL.md" }],
  parentHistoryIncluded: false,
  extensionsDisabled: true,
  promptTemplatesDisabled: true,
  themesDisabled: true,
  customSystemPromptsDisabled: true,
  agentDefinitionsDisabled: true,
  dispatchBytes: 4,
  dispatchSha256: "a".repeat(64),
};

function assistantMessage(
  text: string,
  messageUsage: Usage,
  stopReason: StopReason,
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: "openai-completions",
    provider: "fake",
    model: "worker",
    usage: structuredClone(messageUsage),
    stopReason,
    ...(errorMessage === undefined ? {} : { errorMessage }),
    timestamp: Date.now(),
  };
}

export class FakeAgentSession {
  readonly sessionFile = "/tmp/fake-child.jsonl";
  readonly sessionId = "fake-child-session";
  readonly thinkingLevel: ThinkingLevel = "off";
  readonly prompt = vi.fn((text: string): Promise<void> => {
    if (this.resolvePrompt || this.rejectPrompt) throw new Error("Fake prompt already active");
    this.promptText = text;
    return new Promise<void>((resolve, reject) => {
      this.resolvePrompt = resolve;
      this.rejectPrompt = reject;
    });
  });
  readonly abort = vi.fn(async (): Promise<void> => {
    if (!this.resolvePrompt && !this.rejectPrompt) return;
    this.emitAssistant("", this.abortUsage, "aborted", "Request aborted");
    this.resolvePending();
  });
  readonly dispose = vi.fn((): void => {
    this.disposed = true;
  });
  readonly sessionManager = {
    getLeafId: (): string | null => this.leafId,
    getEntries: (): SessionEntry[] => structuredClone(this.entries),
  };

  promptText: string | undefined;
  disposed = false;
  private readonly listeners = new Set<AgentSessionEventListener>();
  private resolvePrompt: (() => void) | undefined;
  private rejectPrompt: ((error: unknown) => void) | undefined;
  private lastAssistantText: string | undefined;
  private abortUsage: Usage = structuredClone(ZERO_USAGE);
  private leafId: string | null;
  private entries: SessionEntry[];

  constructor(entries: readonly SessionEntry[] = [], leafId: string | null = null) {
    this.entries = structuredClone([...entries]);
    this.leafId = leafId;
  }

  subscribe(listener: AgentSessionEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  getLastAssistantText(): string | undefined {
    return this.lastAssistantText;
  }

  getActiveToolNames(): string[] {
    return ["read", "bash", "edit", "write"];
  }

  setAbortUsage(value: Usage): void {
    this.abortUsage = structuredClone(value);
  }

  emit(event: AgentSessionEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  emitAssistant(
    text: string,
    messageUsage: Usage,
    stopReason: StopReason = "stop",
    errorMessage?: string,
  ): void {
    this.lastAssistantText = text;
    this.emit({
      type: "message_end",
      message: assistantMessage(text, messageUsage, stopReason, errorMessage),
    });
  }

  emitToolResult(messageUsage: Usage): void {
    const message: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: [{ type: "text", text: "tool output" }],
      details: {},
      usage: structuredClone(messageUsage),
      isError: false,
      timestamp: Date.now(),
    };
    this.emit({ type: "message_end", message });
  }

  emitCompaction(messageUsage: Usage): void {
    this.emit({
      type: "compaction_end",
      reason: "threshold",
      result: {
        summary: "compacted",
        firstKeptEntryId: "entry_1",
        tokensBefore: 1_000,
        usage: structuredClone(messageUsage),
      },
      aborted: false,
      willRetry: false,
    });
  }

  complete(text: string, messageUsage: Usage, leafId = "leaf_complete"): void {
    this.requirePending();
    this.leafId = leafId;
    this.emitAssistant(text, messageUsage, "stop");
    this.resolvePending();
  }

  completeError(errorMessage: string, messageUsage: Usage, leafId = "leaf_error"): void {
    this.requirePending();
    this.leafId = leafId;
    this.emitAssistant("", messageUsage, "error", errorMessage);
    this.resolvePending();
  }

  fail(error: unknown, messageUsage: Usage, leafId = "leaf_failed"): void {
    this.requirePending();
    this.leafId = leafId;
    let message = "Unknown child failure";
    try {
      message = error instanceof Error ? error.message : String(error);
    } catch {
      // Preserve the raw rejection for ChildRun while keeping the fake event well formed.
    }
    this.emitAssistant("", messageUsage, "error", message);
    const reject = this.rejectPrompt;
    this.clearPending();
    reject?.(error);
  }

  private requirePending(): void {
    if (!this.resolvePrompt || !this.rejectPrompt) throw new Error("Fake prompt is not active");
  }

  private resolvePending(): void {
    const resolve = this.resolvePrompt;
    this.clearPending();
    resolve?.();
  }

  private clearPending(): void {
    this.resolvePrompt = undefined;
    this.rejectPrompt = undefined;
  }
}

export function fakeBundle(
  session: FakeAgentSession,
  manifest: ContextManifest = fixedManifest,
): ChildSessionBundle {
  return {
    session: session as unknown as ChildSessionBundle["session"],
    manifest: structuredClone(manifest),
    resolvedModel: { provider: "fake", modelId: "worker", canonical: "fake/worker" },
  };
}
