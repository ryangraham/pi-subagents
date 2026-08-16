import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { AgentState, RunTerminalState } from "./types.ts";
import { MAX_RESULT_BYTES } from "./types.ts";

const STATUS_LINE = /^\s*(?:[-*]\s*)?(?:\*\*)?status(?:\*\*)?\s*:\s*(?:\*\*)?(DONE_WITH_CONCERNS|DONE|NEEDS_CONTEXT|BLOCKED)(?:\*\*)?\s*$/im;

export function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

export function classifyFinalResponse(text: string): Extract<AgentState, "completed" | "needs_context" | "blocked"> {
  const value = STATUS_LINE.exec(text)?.[1]?.toUpperCase();
  if (value === "NEEDS_CONTEXT") return "needs_context";
  if (value === "BLOCKED") return "blocked";
  return "completed";
}

export function extractFinalAssistantText(messages: readonly AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    return message.content
      .filter((block): block is Extract<(typeof message.content)[number], { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

export const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function addUsage(left: Usage, right: Usage): Usage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    totalTokens: left.totalTokens + right.totalTokens,
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    },
  };
}

export interface TruncatedText {
  text: string;
  truncated: boolean;
  omittedBytes: number;
}

export function truncateUtf8(text: string, maxBytes = MAX_RESULT_BYTES): TruncatedText {
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= maxBytes) return { text, truncated: false, omittedBytes: 0 };

  const chunks: string[] = [];
  let keptBytes = 0;
  for (const codePoint of text) {
    const size = Buffer.byteLength(codePoint, "utf8");
    if (keptBytes + size > maxBytes) break;
    chunks.push(codePoint);
    keptBytes += size;
  }
  return { text: chunks.join(""), truncated: true, omittedBytes: totalBytes - keptBytes };
}

export function formatOutcomeForModel(
  agentId: string,
  state: RunTerminalState,
  finalText: string,
  sessionFile?: string,
): string {
  const result = truncateUtf8(finalText);
  const location = sessionFile ? ` Full output: ${sessionFile}` : "";
  const notice = result.truncated
    ? `\n\n[Output truncated: ${result.omittedBytes} bytes omitted.${location}]`
    : "";
  return `agent_id: ${agentId}\nstatus: ${state}\n\n${result.text}${notice}`;
}
