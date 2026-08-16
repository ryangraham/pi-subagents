import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";

export const CUSTOM_ENTRY_TYPE = "pi-subagents";
export const REGISTRY_VERSION = 1 as const;
export const MAX_ACTIVE_AGENTS = 4;
export const MAX_RESULT_BYTES = 50 * 1024;
export const MAX_TRANSCRIPT_RECORDS = 2_000;
export const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;

export type AgentState =
  | "starting"
  | "working"
  | "completed"
  | "needs_context"
  | "blocked"
  | "failed"
  | "aborted"
  | "interrupted"
  | "removed";

export type RunTerminalState = Exclude<AgentState, "starting" | "working" | "removed">;

export interface DispatchRequest {
  description: string;
  prompt: string;
  model: string;
  cwd?: string;
}

export interface ResolvedModelSpec {
  provider: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
  canonical: string;
}

export interface ContextManifest {
  cwd: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  tools: string[];
  contextFiles: string[];
  skills: Array<{ name: string; path: string }>;
  parentHistoryIncluded: false;
  extensionsDisabled: true;
  promptTemplatesDisabled: true;
  themesDisabled: true;
  customSystemPromptsDisabled: true;
  agentDefinitionsDisabled: true;
  dispatchBytes: number;
  dispatchSha256: string;
}

export interface AgentOutcome {
  agentId: string;
  runId: string;
  state: RunTerminalState;
  finalText: string;
  error?: string;
  sessionFile?: string;
  childLeafId: string | null;
  usage: Usage;
  startedAt: number;
  settledAt: number;
  manifest?: ContextManifest;
}

export type TranscriptRecordKind =
  | "user"
  | "text"
  | "thinking"
  | "tool"
  | "retry"
  | "compaction"
  | "error"
  | "status";

export interface TranscriptRecord {
  id: string;
  kind: TranscriptRecordKind;
  timestamp: number;
  text: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  streaming?: boolean;
}

export interface AgentRunRecord {
  runId: string;
  index: number;
  promptSha256: string;
  startedAt: number;
  settledAt?: number;
  usage?: Usage;
  usageClaimed: boolean;
  childLeafId?: string | null;
}

export interface AgentRecord {
  id: string;
  description: string;
  cwd: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
  state: AgentState;
  sessionFile?: string;
  childLeafId?: string | null;
  manifest?: ContextManifest;
  error?: string;
  createdAt: number;
  updatedAt: number;
  runs: AgentRunRecord[];
}

interface RegistryEventBase {
  version: typeof REGISTRY_VERSION;
  agentId: string;
  at: number;
}

interface WorkingRegistryPayload {
  run: AgentRunRecord;
  state: "working";
  sessionFile?: string;
  childLeafId: string | null;
  manifest?: ContextManifest;
}

interface TerminalRegistryPayload {
  /** Present only when a fresh setup settles before its `started` event. */
  run?: AgentRunRecord;
  sessionFile?: string;
  childLeafId: string | null;
  manifest?: ContextManifest;
  error?: string;
  usage?: Usage;
}

export type RegistryEvent =
  | (RegistryEventBase & { kind: "created"; record: AgentRecord })
  | (RegistryEventBase & WorkingRegistryPayload & { kind: "started" })
  | (RegistryEventBase & WorkingRegistryPayload & { kind: "resumed" })
  | (RegistryEventBase &
      TerminalRegistryPayload & {
        kind: "settled";
        runId: string;
        state: "completed" | "needs_context" | "blocked" | "failed";
      })
  | (RegistryEventBase & TerminalRegistryPayload & { kind: "aborted"; runId: string; state: "aborted" })
  | (RegistryEventBase &
      TerminalRegistryPayload & { kind: "interrupted"; runId: string | null; state: "interrupted" })
  | (RegistryEventBase & { kind: "usage_claimed"; runId: string })
  | (RegistryEventBase & { kind: "removed" });
