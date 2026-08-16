import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  ImageContent,
  TextContent,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { TranscriptRecord } from "./types.ts";

export const MAX_LIVE_TRANSCRIPT_RECORDS = 2_000;
export const MAX_LIVE_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
export const MAX_TOOL_RECORD_BYTES = 8 * 1024;

const TOOL_COLLAPSED_MARKER = "\n[… tool detail collapsed …]";

type TranscriptListener = (records: readonly TranscriptRecord[]) => void;

export interface TranscriptStoreOptions {
  maxRecords?: number;
  maxBytes?: number;
  initialRecords?: readonly TranscriptRecord[];
}

interface ToolMetadata {
  name: string;
  argumentsText?: string;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function utf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function capWithToolMarker(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  const prefixBudget = maxBytes - byteLength(TOOL_COLLAPSED_MARKER);
  return `${utf8Prefix(text, prefixBudget)}${TOOL_COLLAPSED_MARKER}`;
}

function capToolText(text: string): string {
  return capWithToolMarker(text, MAX_TOOL_RECORD_BYTES);
}

function capToolArguments(text: string): string {
  return capWithToolMarker(text, Math.floor(MAX_TOOL_RECORD_BYTES / 2));
}

function safeJson(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    const rendered = JSON.stringify(
      value,
      (_key, nested: unknown) => {
        if (typeof nested === "bigint") return nested.toString();
        if (typeof nested !== "object" || nested === null) return nested;
        if (seen.has(nested)) return "[Circular]";
        seen.add(nested);
        return nested;
      },
      2,
    );
    return rendered ?? String(value);
  } catch {
    try {
      return String(value);
    } catch {
      return "[unrenderable]";
    }
  }
}

function contentText(content: readonly (TextContent | ImageContent)[]): string {
  return content
    .map((block) => (block.type === "text" ? block.text : `[image ${block.mimeType}]`))
    .join("\n");
}

function userText(content: string | readonly (TextContent | ImageContent)[]): string {
  return typeof content === "string" ? content : contentText(content);
}

function resultText(result: unknown): string {
  try {
    if (typeof result === "object" && result !== null) {
      const parts: string[] = [];
      if ("content" in result) {
        const content = (result as { content?: unknown }).content;
        if (Array.isArray(content)) {
          const blocks = content.filter(
            (block): block is TextContent | ImageContent =>
              typeof block === "object" &&
              block !== null &&
              (block as { type?: unknown }).type !== undefined &&
              ((block as { type: unknown }).type === "text" ||
                (block as { type: unknown }).type === "image"),
          );
          if (blocks.length > 0) parts.push(contentText(blocks));
        }
      }
      if ("details" in result && (result as { details?: unknown }).details !== undefined) {
        parts.push(`details: ${safeJson((result as { details?: unknown }).details)}`);
      }
      if (parts.length > 0) return parts.join("\n");
    }
  } catch {
    // Fall through to the guarded whole-value renderer.
  }
  return safeJson(result);
}

function entryTimestamp(entry: SessionEntry): number {
  const timestamp = Date.parse(entry.timestamp);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function toolHeading(text: string): string | undefined {
  const separators = [text.indexOf("\n→ "), text.indexOf("\n… running")].filter(
    (index) => index >= 0,
  );
  if (separators.length === 0) return undefined;
  return text.slice(0, Math.min(...separators));
}

export class TranscriptStore {
  readonly #maxRecords: number;
  readonly #maxBytes: number;
  readonly #records = new Map<string, TranscriptRecord>();
  readonly #order: string[] = [];
  readonly #listeners = new Set<TranscriptListener>();
  readonly #toolMetadata = new Map<string, ToolMetadata>();
  #totalBytes = 0;
  #sequence = 0;
  #revision = 0;
  #disposed = false;
  #activeAssistantBase: string | undefined;
  #activeAssistantTimestamp: number | undefined;

  constructor(options: TranscriptStoreOptions = {}) {
    this.#maxRecords = options.maxRecords ?? MAX_LIVE_TRANSCRIPT_RECORDS;
    this.#maxBytes = options.maxBytes ?? MAX_LIVE_TRANSCRIPT_BYTES;
    if (!Number.isInteger(this.#maxRecords) || this.#maxRecords <= 0) {
      throw new Error("maxRecords must be a positive integer");
    }
    if (!Number.isInteger(this.#maxBytes) || this.#maxBytes <= 0) {
      throw new Error("maxBytes must be a positive integer");
    }
    for (const record of options.initialRecords ?? []) this.#upsert({ ...record });
  }

  static replay(entries: readonly SessionEntry[], leafId: string): TranscriptRecord[] {
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const leaf = byId.get(leafId);
    if (!leaf) return [];

    const path: SessionEntry[] = [];
    const visited = new Set<string>();
    let current: SessionEntry | undefined = leaf;
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      path.push(current);
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
    path.reverse();

    const store = new TranscriptStore();
    for (const entry of path) store.#replayEntry(entry);
    return store.snapshot();
  }

  appendUserPrompt(prompt: string, timestamp = Date.now()): void {
    if (this.#disposed) return;
    const revision = this.#revision;
    this.#upsert({
      id: this.#nextId("user"),
      kind: "user",
      timestamp,
      text: prompt,
    });
    this.#notifyIfChanged(revision);
  }

  apply(event: AgentSessionEvent): void {
    if (this.#disposed) return;
    const revision = this.#revision;

    switch (event.type) {
      case "message_start":
        if (event.message.role === "assistant") this.#assistantBase(event.message);
        break;
      case "message_update":
        this.#applyAssistantUpdate(event);
        break;
      case "message_end":
        this.#applyMessageEnd(event.message);
        break;
      case "tool_execution_start":
        this.#startTool(event.toolCallId, event.toolName, event.args, Date.now());
        break;
      case "tool_execution_update":
        this.#updateTool(
          event.toolCallId,
          event.toolName,
          event.args,
          event.partialResult,
          true,
          undefined,
          Date.now(),
        );
        break;
      case "tool_execution_end":
        this.#finishTool(event.toolCallId, event.toolName, event.result, event.isError, Date.now());
        break;
      case "agent_start":
        this.#status("status", "started");
        break;
      case "agent_end":
        this.#status("status", event.willRetry ? "response complete; retry pending" : "response complete");
        break;
      case "agent_settled":
        this.#status("status", "settled");
        break;
      case "queue_update":
        this.#status(
          "status",
          `queue updated: ${event.steering.length} steering, ${event.followUp.length} follow-up`,
        );
        break;
      case "compaction_start":
        this.#status("compaction", `compaction started (${event.reason})`);
        break;
      case "compaction_end": {
        const outcome = event.aborted
          ? `aborted${event.errorMessage ? `: ${event.errorMessage}` : ""}`
          : event.result?.summary ?? (event.willRetry ? "failed; retry pending" : "finished");
        this.#status("compaction", `compaction ${event.reason}: ${outcome}`);
        break;
      }
      case "auto_retry_start":
        this.#status(
          "retry",
          `retry ${event.attempt}/${event.maxAttempts} in ${event.delayMs}ms: ${event.errorMessage}`,
        );
        break;
      case "auto_retry_end":
        this.#status(
          "retry",
          event.success
            ? `retry ${event.attempt} succeeded`
            : `retry ${event.attempt} failed${event.finalError ? `: ${event.finalError}` : ""}`,
        );
        break;
      case "summarization_retry_scheduled":
        this.#status(
          "retry",
          `summary retry ${event.attempt}/${event.maxAttempts} in ${event.delayMs}ms: ${event.errorMessage}`,
        );
        break;
      case "summarization_retry_attempt_start":
        this.#status(
          "retry",
          event.source === "branchSummary"
            ? "branch summary retry started"
            : `compaction ${event.reason} retry started`,
        );
        break;
      case "summarization_retry_finished":
        this.#status("retry", "summary retry finished");
        break;
      case "thinking_level_changed":
        this.#status("status", `thinking level: ${event.level}`);
        break;
      case "bash_execution_update":
        if (event.delta) this.#status("tool", event.delta);
        break;
      case "turn_start":
      case "turn_end":
      case "entry_appended":
      case "session_info_changed":
        break;
    }

    this.#notifyIfChanged(revision);
  }

  snapshot(): TranscriptRecord[] {
    return this.#order.flatMap((id) => {
      const record = this.#records.get(id);
      return record ? [{ ...record }] : [];
    });
  }

  subscribe(listener: TranscriptListener): () => void {
    if (this.#disposed) return () => undefined;
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  dispose(): void {
    this.#disposed = true;
    this.#listeners.clear();
    this.#toolMetadata.clear();
  }

  #applyAssistantUpdate(event: Extract<AgentSessionEvent, { type: "message_update" }>): void {
    const update = event.assistantMessageEvent;
    if (update.type === "error") {
      const base = this.#assistantBase(update.error);
      this.#assistantError(update.error, base, false);
      return;
    }
    if (update.type === "done") {
      const base = this.#assistantBase(update.message);
      this.#assistantContent(update.message, base, false);
      return;
    }
    if (update.type === "start") {
      this.#assistantBase(update.partial);
      return;
    }

    const block = update.partial.content[update.contentIndex];
    const base = this.#assistantBase(update.partial);
    if (block?.type === "text") {
      this.#upsert({
        id: `${base}:content:${update.contentIndex}`,
        kind: "text",
        timestamp: update.partial.timestamp,
        text: block.text,
        streaming: update.type !== "text_end",
      });
    } else if (block?.type === "thinking") {
      this.#upsert({
        id: `${base}:content:${update.contentIndex}`,
        kind: "thinking",
        timestamp: update.partial.timestamp,
        text: block.thinking,
        streaming: update.type !== "thinking_end",
      });
    } else if (block?.type === "toolCall") {
      this.#startToolCall(block, update.partial.timestamp);
    }
  }

  #applyMessageEnd(message: AgentMessage): void {
    if (message.role === "assistant") {
      const base = this.#assistantBase(message);
      this.#assistantContent(message, base, false);
      this.#assistantError(message, base, false);
      this.#activeAssistantBase = undefined;
      this.#activeAssistantTimestamp = undefined;
    } else if (message.role === "toolResult") {
      this.#applyToolResultMessage(message);
    }
  }

  #assistantBase(message: AssistantMessage): string {
    if (
      this.#activeAssistantBase === undefined ||
      this.#activeAssistantTimestamp !== message.timestamp
    ) {
      this.#activeAssistantBase = this.#nextId(`assistant:${message.timestamp}`);
      this.#activeAssistantTimestamp = message.timestamp;
    }
    return this.#activeAssistantBase;
  }

  #assistantContent(
    message: AssistantMessage,
    base: string,
    streaming: boolean,
    timestamp = message.timestamp,
  ): void {
    for (const [index, block] of message.content.entries()) {
      if (block.type === "text") {
        this.#upsert({
          id: `${base}:content:${index}`,
          kind: "text",
          timestamp,
          text: block.text,
          streaming,
        });
      } else if (block.type === "thinking") {
        this.#upsert({
          id: `${base}:content:${index}`,
          kind: "thinking",
          timestamp,
          text: block.thinking,
          streaming,
        });
      } else {
        this.#startToolCall(block, timestamp);
      }
    }
  }

  #assistantError(
    message: AssistantMessage,
    base: string,
    streaming: boolean,
    timestamp = message.timestamp,
  ): void {
    if (!message.errorMessage) return;
    this.#upsert({
      id: `${base}:error`,
      kind: "error",
      timestamp,
      text: message.errorMessage,
      streaming,
      isError: true,
    });
  }

  #startToolCall(toolCall: ToolCall, timestamp: number): void {
    this.#toolMetadata.set(toolCall.id, {
      name: toolCall.name,
      argumentsText: capToolArguments(safeJson(toolCall.arguments)),
    });
    this.#writeTool(toolCall.id, toolCall.name, undefined, true, undefined, timestamp);
  }

  #startTool(toolCallId: string, toolName: string, args: unknown, timestamp: number): void {
    this.#toolMetadata.set(toolCallId, {
      name: toolName,
      argumentsText: capToolArguments(safeJson(args)),
    });
    this.#writeTool(toolCallId, toolName, undefined, true, undefined, timestamp);
  }

  #updateTool(
    toolCallId: string,
    toolName: string,
    args: unknown,
    result: unknown,
    streaming: boolean,
    isError: boolean | undefined,
    timestamp: number,
  ): void {
    if (!this.#toolMetadata.has(toolCallId)) {
      this.#toolMetadata.set(toolCallId, {
        name: toolName,
        argumentsText: capToolArguments(safeJson(args)),
      });
    }
    this.#writeTool(toolCallId, toolName, resultText(result), streaming, isError, timestamp);
  }

  #finishTool(
    toolCallId: string,
    toolName: string,
    result: unknown,
    isError: boolean,
    timestamp: number,
  ): void {
    this.#writeTool(toolCallId, toolName, resultText(result), false, isError, timestamp);
    this.#toolMetadata.delete(toolCallId);
  }

  #applyToolResultMessage(message: ToolResultMessage): void {
    this.#finishTool(
      message.toolCallId,
      message.toolName,
      { content: message.content, details: message.details },
      message.isError,
      message.timestamp,
    );
  }

  #writeTool(
    toolCallId: string,
    toolName: string,
    output: string | undefined,
    streaming: boolean,
    isError: boolean | undefined,
    timestamp: number,
  ): void {
    const id = `tool:${toolCallId}`;
    const metadata = this.#toolMetadata.get(toolCallId);
    const existing = this.#records.get(id);
    const existingHeading = existing?.kind === "tool" ? toolHeading(existing.text) : undefined;
    const heading = metadata
      ? `${metadata.name}${metadata.argumentsText ? ` ${metadata.argumentsText}` : ""}`
      : existingHeading ?? toolName;
    const text = output === undefined ? `${heading}\n… running` : `${heading}\n→ ${output}`;
    this.#upsert({
      id,
      kind: "tool",
      timestamp,
      text: capToolText(text),
      streaming,
      toolCallId,
      toolName: metadata?.name ?? existing?.toolName ?? toolName,
      ...(isError === undefined ? {} : { isError }),
    });
  }

  #status(kind: "status" | "retry" | "compaction" | "tool", text: string): void {
    this.#upsert({
      id: this.#nextId(kind),
      kind,
      timestamp: Date.now(),
      text,
      streaming: false,
    });
  }

  #replayEntry(entry: SessionEntry): void {
    const timestamp = entryTimestamp(entry);
    if (entry.type === "message") {
      const message = entry.message;
      if (message.role === "user") {
        this.#upsert({
          id: `entry:${entry.id}:user`,
          kind: "user",
          timestamp,
          text: userText(message.content),
        });
      } else if (message.role === "assistant") {
        const base = `entry:${entry.id}:assistant`;
        this.#assistantContent(message, base, false, timestamp);
        this.#assistantError(message, base, false, timestamp);
      } else if (message.role === "toolResult") {
        this.#finishTool(
          message.toolCallId,
          message.toolName,
          { content: message.content, details: message.details },
          message.isError,
          timestamp,
        );
      }
    } else if (entry.type === "compaction") {
      this.#upsert({
        id: `entry:${entry.id}:compaction`,
        kind: "compaction",
        timestamp,
        text: entry.summary,
      });
    } else if (entry.type === "branch_summary") {
      this.#upsert({
        id: `entry:${entry.id}:branch-summary`,
        kind: "compaction",
        timestamp,
        text: entry.summary,
      });
    }
  }

  #nextId(prefix: string): string {
    let id: string;
    do {
      this.#sequence += 1;
      id = `${prefix}:${this.#sequence}`;
    } while (this.#records.has(id));
    return id;
  }

  #upsert(record: TranscriptRecord): void {
    const existing = this.#records.get(record.id);
    if (existing) {
      this.#totalBytes -= byteLength(existing.text);
      this.#records.set(record.id, { ...record });
    } else {
      this.#records.set(record.id, { ...record });
      this.#order.push(record.id);
    }
    this.#totalBytes += byteLength(record.text);
    this.#revision += 1;
    this.#trim();
  }

  #trim(): void {
    while (this.#order.length > this.#maxRecords || this.#totalBytes > this.#maxBytes) {
      const id = this.#order.shift();
      if (id === undefined) break;
      const record = this.#records.get(id);
      if (record) this.#totalBytes -= byteLength(record.text);
      this.#records.delete(id);
    }
  }

  #notifyIfChanged(previousRevision: number): void {
    if (this.#revision === previousRevision) return;
    for (const listener of [...this.#listeners]) {
      try {
        listener(this.snapshot());
      } catch {
        this.#listeners.delete(listener);
      }
    }
  }
}
