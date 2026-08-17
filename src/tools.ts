import type { Usage } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AgentManager, SubagentOperationError } from "./agent-manager.ts";
import { formatOutcomeForModel } from "./result.ts";
import type {
  AgentOutcome,
  AgentRecord,
  AgentState,
  ClaimedOutcome,
  ControllerScope,
  DispatchRequest,
} from "./types.ts";

const DispatchParameters = Type.Object(
  {
    description: Type.String({ minLength: 1, maxLength: 120, pattern: "^(?=.*\\S)[^\\r\\n]+$" }),
    prompt: Type.String({ minLength: 1 }),
    model: Type.String({ minLength: 3 }),
    cwd: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const AgentIdParameters = Type.Object(
  {
    agentId: Type.String({ pattern: "^sa_[0-9a-f]{8}$" }),
  },
  { additionalProperties: false },
);

const ResumeParameters = Type.Object(
  {
    agentId: Type.String({ pattern: "^sa_[0-9a-f]{8}$" }),
    prompt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const EmptyParameters = Type.Object({}, { additionalProperties: false });

export type SubagentToolName =
  | "subagent_run"
  | "subagent_start"
  | "subagent_wait"
  | "subagent_resume"
  | "subagent_abort"
  | "subagent_list";

export interface SubagentToolDetails {
  operation: SubagentToolName;
  agentId?: string;
  state?: AgentState;
  outcome?: Omit<AgentOutcome, "finalText">;
  records?: AgentRecord[];
  error?: string;
  infrastructureError?: boolean;
}

const TOOL_METADATA = {
  subagent_run: ["Subagent Run", "Create a fresh isolated subagent and wait for its final response"],
  subagent_start: ["Subagent Start", "Create a fresh isolated background subagent and return its ID"],
  subagent_wait: ["Subagent Wait", "Wait for a background subagent without aborting it if waiting is cancelled"],
  subagent_resume: ["Subagent Resume", "Resume a settled subagent with its original context, model, cwd, and identity"],
  subagent_abort: ["Subagent Abort", "Abort a running subagent by ID"],
  subagent_list: ["Subagent List", "List current-session subagent IDs and states without transcript text"],
} as const;

const SDD_GUIDELINES = [
  "Use subagent_run for each fresh Superpowers implementer, task reviewer, re-reviewer, and final reviewer.",
  "Use subagent_resume with the original implementer ID for Superpowers fix rounds 1-3; use a fresh subagent_run with an explicitly more capable canonical provider/model for fix rounds 4-5.",
  "Never copy controller conversation history into a subagent prompt; pass task briefs, reports, plans, and review packages by file path.",
  "Never run multiple Superpowers implementation agents concurrently.",
  "Every subagent_start must eventually be paired with subagent_wait or subagent_abort so its final result and usage are collected.",
];

const TOOL_NAMES = new Set<SubagentToolName>(Object.keys(TOOL_METADATA) as SubagentToolName[]);

export function scopeFromContext(ctx: ExtensionContext): ControllerScope {
  return {
    parentSessionId: ctx.sessionManager.getSessionId(),
    cwd: ctx.cwd,
    projectTrusted: ctx.isProjectTrusted(),
    mode: ctx.mode,
  };
}

export function formatDuration(milliseconds: number): string {
  let seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const days = Math.floor(seconds / 86_400);
  seconds -= days * 86_400;
  const hours = Math.floor(seconds / 3_600);
  seconds -= hours * 3_600;
  const minutes = Math.floor(seconds / 60);
  seconds -= minutes * 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

function requestFromParams(params: {
  description: string;
  prompt: string;
  model: string;
  cwd?: string;
}): DispatchRequest {
  return {
    description: params.description,
    prompt: params.prompt,
    model: params.model,
    ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
  };
}

function errorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "Unknown subagent failure";
  }
}

function textResult(
  text: string,
  details: SubagentToolDetails,
  usage?: Usage,
): AgentToolResult<SubagentToolDetails> {
  return {
    content: [{ type: "text", text }],
    details,
    ...(usage === undefined ? {} : { usage }),
  };
}

function outcomeMetadata(outcome: AgentOutcome): Omit<AgentOutcome, "finalText"> {
  const { finalText: _finalText, ...metadata } = structuredClone(outcome);
  return metadata;
}

function terminalResult(
  operation: Extract<SubagentToolName, "subagent_run" | "subagent_wait" | "subagent_resume">,
  claimed: ClaimedOutcome,
): AgentToolResult<SubagentToolDetails> {
  const { outcome, claimedUsage } = claimed;
  const infrastructureError = outcome.state === "failed" || outcome.state === "interrupted";
  const body = outcome.finalText || outcome.error || "";
  return textResult(
    formatOutcomeForModel(outcome.agentId, outcome.state, body, outcome.sessionFile),
    {
      operation,
      agentId: outcome.agentId,
      state: outcome.state,
      outcome: outcomeMetadata(outcome),
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
      ...(infrastructureError ? { infrastructureError: true } : {}),
    },
    claimedUsage,
  );
}

function infrastructureFailure(
  operation: SubagentToolName,
  error: unknown,
): AgentToolResult<SubagentToolDetails> {
  const message = errorMessage(error);
  const agentId = error instanceof SubagentOperationError ? error.agentId : undefined;
  const identity = agentId ? `agent_id: ${agentId}\n` : "";
  return textResult(`${identity}status: error\n\n${message}`, {
    operation,
    ...(agentId === undefined ? {} : { agentId }),
    error: message,
    infrastructureError: true,
  });
}

function isInfrastructureDetails(value: unknown, toolName: string): boolean {
  if (!TOOL_NAMES.has(toolName as SubagentToolName) || typeof value !== "object" || value === null) {
    return false;
  }
  const details = value as Partial<SubagentToolDetails>;
  return details.operation === toolName && details.infrastructureError === true;
}

export function registerSubagentTools(
  pi: ExtensionAPI,
  getManager: () => AgentManager,
): void {
  pi.registerTool({
    name: "subagent_run",
    label: TOOL_METADATA.subagent_run[0],
    description: TOOL_METADATA.subagent_run[1],
    promptSnippet: TOOL_METADATA.subagent_run[1],
    promptGuidelines: [...SDD_GUIDELINES],
    parameters: DispatchParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const result = await getManager().run(
          requestFromParams(params),
          scopeFromContext(ctx),
          signal,
        );
        return terminalResult("subagent_run", result);
      } catch (error) {
        return infrastructureFailure("subagent_run", error);
      }
    },
  });

  pi.registerTool({
    name: "subagent_start",
    label: TOOL_METADATA.subagent_start[0],
    description: TOOL_METADATA.subagent_start[1],
    promptSnippet: TOOL_METADATA.subagent_start[1],
    parameters: DispatchParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        if (ctx.mode === "print" || ctx.mode === "json") {
          throw new Error(`subagent_start is unavailable in ${ctx.mode} mode`);
        }
        const result = await getManager().start(requestFromParams(params), scopeFromContext(ctx));
        return textResult(`agent_id: ${result.agentId}\nstatus: working`, {
          operation: "subagent_start",
          agentId: result.agentId,
          state: result.state,
        });
      } catch (error) {
        return infrastructureFailure("subagent_start", error);
      }
    },
  });

  pi.registerTool({
    name: "subagent_wait",
    label: TOOL_METADATA.subagent_wait[0],
    description: TOOL_METADATA.subagent_wait[1],
    promptSnippet: TOOL_METADATA.subagent_wait[1],
    parameters: AgentIdParameters,
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      try {
        return terminalResult(
          "subagent_wait",
          await getManager().wait(params.agentId, signal),
        );
      } catch (error) {
        return infrastructureFailure("subagent_wait", error);
      }
    },
  });

  pi.registerTool({
    name: "subagent_resume",
    label: TOOL_METADATA.subagent_resume[0],
    description: TOOL_METADATA.subagent_resume[1],
    promptSnippet: TOOL_METADATA.subagent_resume[1],
    parameters: ResumeParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        return terminalResult(
          "subagent_resume",
          await getManager().resume(
            params.agentId,
            params.prompt,
            scopeFromContext(ctx),
            signal,
          ),
        );
      } catch (error) {
        return infrastructureFailure("subagent_resume", error);
      }
    },
  });

  pi.registerTool({
    name: "subagent_abort",
    label: TOOL_METADATA.subagent_abort[0],
    description: TOOL_METADATA.subagent_abort[1],
    promptSnippet: TOOL_METADATA.subagent_abort[1],
    parameters: AgentIdParameters,
    async execute(_toolCallId, params) {
      try {
        const record = await getManager().abort(params.agentId);
        return textResult(`agent_id: ${record.id}\nstatus: ${record.state}`, {
          operation: "subagent_abort",
          agentId: record.id,
          state: record.state,
        });
      } catch (error) {
        return infrastructureFailure("subagent_abort", error);
      }
    },
  });

  pi.registerTool({
    name: "subagent_list",
    label: TOOL_METADATA.subagent_list[0],
    description: TOOL_METADATA.subagent_list[1],
    promptSnippet: TOOL_METADATA.subagent_list[1],
    parameters: EmptyParameters,
    async execute() {
      try {
        const records = getManager().list();
        const now = Date.now();
        const text = records.length === 0
          ? "No subagents in this controller branch"
          : records
              .map((record) => {
                const latestRun = record.runs.at(-1);
                const prefix = `${record.id} | ${record.state} | ${record.description} | ${record.model} | runs:${record.runs.length}`;
                if (record.state === "starting" || record.state === "working") {
                  return `${prefix} | elapsed:${formatDuration(now - (latestRun?.startedAt ?? record.createdAt))}`;
                }
                return `${prefix} | settled:${new Date(latestRun?.settledAt ?? record.updatedAt).toISOString()}`;
              })
              .join("\n");
        return textResult(text, { operation: "subagent_list", records });
      } catch (error) {
        return infrastructureFailure("subagent_list", error);
      }
    },
  });

  pi.on("tool_result", (event: ToolResultEvent) => {
    if (isInfrastructureDetails(event.details, event.toolName)) return { isError: true };
    return undefined;
  });
}
