import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { TranscriptStore } from "../src/transcript.ts";
import type { TranscriptRecord } from "../src/types.ts";

const usage = (): Usage => ({
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const assistant = (
  content: AssistantMessage["content"],
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage => ({
  role: "assistant",
  content,
  api: "openai-completions",
  provider: "fake",
  model: "worker",
  usage: usage(),
  stopReason: "stop",
  timestamp: 100,
  ...overrides,
});

const textDeltaEvent = (text: string): AgentSessionEvent => {
  const message = assistant([{ type: "text", text }]);
  return {
    type: "message_update",
    message,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial: message },
  };
};

const thinkingDeltaEvent = (thinking: string): AgentSessionEvent => {
  const message = assistant([
    { type: "text", text: "" },
    { type: "thinking", thinking },
  ]);
  return {
    type: "message_update",
    message,
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: thinking, partial: message },
  };
};

const statusEvent = (text: string): AgentSessionEvent => ({
  type: "auto_retry_start",
  attempt: 1,
  maxAttempts: 3,
  delayMs: 100,
  errorMessage: text,
});

const toolStartEvent: AgentSessionEvent = {
  type: "tool_execution_start",
  toolCallId: "call_1",
  toolName: "bash",
  args: { command: "printf hello" },
};

const toolUpdateEvent: AgentSessionEvent = {
  type: "tool_execution_update",
  toolCallId: "call_1",
  toolName: "bash",
  args: { command: "printf hello" },
  partialResult: { content: [{ type: "text", text: "hel" }], details: {} },
};

const toolEndEvent: AgentSessionEvent = {
  type: "tool_execution_end",
  toolCallId: "call_1",
  toolName: "bash",
  result: { content: [{ type: "text", text: "hello" }], details: {} },
  isError: false,
};

const sessionEntry = <T extends SessionEntry>(entry: T): T => entry;

const branchedEntries: SessionEntry[] = [
  sessionEntry({
    type: "message",
    id: "root_user",
    parentId: null,
    timestamp: "2026-08-16T00:00:00.000Z",
    message: { role: "user", content: "root task", timestamp: 1 },
  }),
  sessionEntry({
    type: "message",
    id: "root_answer",
    parentId: "root_user",
    timestamp: "2026-08-16T00:00:01.000Z",
    message: assistant([{ type: "text", text: "root answer" }], { timestamp: 2 }),
  }),
  sessionEntry({
    type: "message",
    id: "branch_a_user",
    parentId: "root_answer",
    timestamp: "2026-08-16T00:00:02.000Z",
    message: { role: "user", content: "branch a task", timestamp: 3 },
  }),
  sessionEntry({
    type: "message",
    id: "branch_a_leaf",
    parentId: "branch_a_user",
    timestamp: "2026-08-16T00:00:03.000Z",
    message: assistant([{ type: "text", text: "branch a answer" }], { timestamp: 4 }),
  }),
  sessionEntry({
    type: "message",
    id: "branch_b_user",
    parentId: "root_answer",
    timestamp: "2026-08-16T00:00:04.000Z",
    message: { role: "user", content: [{ type: "text", text: "branch b task" }], timestamp: 5 },
  }),
  sessionEntry({
    type: "message",
    id: "branch_b_answer",
    parentId: "branch_b_user",
    timestamp: "2026-08-16T00:00:05.000Z",
    message: assistant(
      [
        { type: "thinking", thinking: "branch b thought" },
        { type: "text", text: "branch b answer" },
        { type: "toolCall", id: "call_b", name: "bash", arguments: { command: "pwd" } },
      ],
      { timestamp: 6 },
    ),
  }),
  sessionEntry({
    type: "message",
    id: "branch_b_tool",
    parentId: "branch_b_answer",
    timestamp: "2026-08-16T00:00:06.000Z",
    message: {
      role: "toolResult",
      toolCallId: "call_b",
      toolName: "bash",
      content: [{ type: "text", text: "/repo" }],
      isError: false,
      timestamp: 7,
    } satisfies ToolResultMessage,
  }),
  sessionEntry({
    type: "compaction",
    id: "branch_b_compaction",
    parentId: "branch_b_tool",
    timestamp: "2026-08-16T00:00:07.000Z",
    summary: "branch b compacted summary",
    firstKeptEntryId: "branch_b_user",
    tokensBefore: 1_000,
  }),
  sessionEntry({
    type: "branch_summary",
    id: "branch_b_leaf",
    parentId: "branch_b_compaction",
    timestamp: "2026-08-16T00:00:08.000Z",
    fromId: "branch_b_user",
    summary: "branch b branch summary",
  }),
];

describe("TranscriptStore live normalization", () => {
  it("records one user prompt without exposing it as assistant text", () => {
    const store = new TranscriptStore();
    store.appendUserPrompt("implement task 1", 10);

    expect(store.snapshot()).toEqual([
      expect.objectContaining({ kind: "user", timestamp: 10, text: "implement task 1" }),
    ]);
  });

  it("replaces streaming text records instead of appending every delta", () => {
    const store = new TranscriptStore();
    store.apply(textDeltaEvent("hel"));
    store.apply(textDeltaEvent("hello"));

    expect(store.snapshot().filter((record) => record.kind === "text")).toEqual([
      expect.objectContaining({ text: "hello", streaming: true }),
    ]);
  });

  it("marks terminal assistant text complete and keeps thinking separate", () => {
    const store = new TranscriptStore();
    store.apply(textDeltaEvent("answer"));
    store.apply(thinkingDeltaEvent("hidden reasoning"));
    store.apply({
      type: "message_end",
      message: assistant([
        { type: "text", text: "answer" },
        { type: "thinking", thinking: "hidden reasoning" },
      ]),
    });

    expect(store.snapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "text", text: "answer", streaming: false }),
        expect.objectContaining({ kind: "thinking", text: "hidden reasoning", streaming: false }),
      ]),
    );
  });

  it("correlates tool start update and end by toolCallId", () => {
    const store = new TranscriptStore();
    store.apply(toolStartEvent);
    store.apply(toolUpdateEvent);
    store.apply(toolEndEvent);
    store.apply({
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "bash",
        content: [{ type: "text", text: "hello" }],
        details: {},
        isError: false,
        timestamp: 101,
      },
    });

    expect(store.snapshot().filter((record) => record.kind === "tool")).toEqual([
      expect.objectContaining({
        toolCallId: "call_1",
        toolName: "bash",
        text: expect.stringMatching(/printf hello[\s\S]*hello/),
        streaming: false,
        isError: false,
      }),
    ]);
  });

  it("retains failed tool state", () => {
    const store = new TranscriptStore();
    store.apply(toolStartEvent);
    store.apply({ ...toolEndEvent, isError: true });

    expect(store.snapshot()).toEqual([expect.objectContaining({ kind: "tool", isError: true })]);
  });

  it("renders and caps tool result details without mutating source data", () => {
    const store = new TranscriptStore();
    const details = { blob: "z".repeat(20_000) };
    store.apply(toolStartEvent);
    store.apply({
      ...toolEndEvent,
      result: { content: [{ type: "text", text: "ok" }], details },
    });
    const record = store.snapshot()[0];

    expect(record?.text).toContain("details:");
    expect(record?.text).toContain("[… tool detail collapsed …]");
    expect(Buffer.byteLength(record?.text ?? "", "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(details.blob).toHaveLength(20_000);
  });

  it("collapses oversized and circular tool detail without mutating source data", () => {
    const store = new TranscriptStore();
    const huge = "x".repeat(20_000);
    const circular: Record<string, unknown> = { huge };
    circular.self = circular;
    const event: AgentSessionEvent = {
      type: "tool_execution_start",
      toolCallId: "call_large",
      toolName: "read",
      args: circular,
    };

    store.apply(event);
    store.apply({
      type: "tool_execution_end",
      toolCallId: "call_large",
      toolName: "read",
      result: { content: [{ type: "text", text: "final result remains visible" }], details: {} },
      isError: false,
    });
    const record = store.snapshot()[0];

    expect(Buffer.byteLength(record?.text ?? "", "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(record?.text).toContain("[… tool detail collapsed …]");
    expect(record?.text).toContain("final result remains visible");
    expect(circular.huge).toBe(huge);
    expect(circular.self).toBe(circular);
  });

  it("turns provider errors retry compaction and settlement into readable records", () => {
    const store = new TranscriptStore();
    store.apply({
      type: "message_end",
      message: assistant([], { stopReason: "error", errorMessage: "provider down" }),
    });
    store.apply(statusEvent("retrying provider down"));
    store.apply({ type: "auto_retry_end", success: false, attempt: 1, finalError: "still down" });
    store.apply({ type: "compaction_start", reason: "threshold" });
    store.apply({
      type: "compaction_end",
      reason: "threshold",
      result: {
        summary: "compacted old turns",
        firstKeptEntryId: "entry_1",
        tokensBefore: 1_000,
      },
      aborted: false,
      willRetry: false,
    });
    store.apply({ type: "agent_settled" });

    expect(store.snapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "error", text: "provider down" }),
        expect.objectContaining({ kind: "retry", text: expect.stringContaining("retrying provider down") }),
        expect.objectContaining({ kind: "retry", text: expect.stringContaining("still down") }),
        expect.objectContaining({ kind: "compaction", text: expect.stringContaining("threshold") }),
        expect.objectContaining({ kind: "compaction", text: expect.stringContaining("compacted old turns") }),
        expect.objectContaining({ kind: "status", text: "settled" }),
      ]),
    );
  });
});

describe("TranscriptStore bounds and subscriptions", () => {
  it("bounds records while retaining newest data", () => {
    const store = new TranscriptStore({ maxRecords: 3, maxBytes: 100 });
    for (const text of ["aaaa", "bbbb", "cccc", "dddd"]) store.apply(statusEvent(text));

    expect(store.snapshot().map((record) => record.text)).toEqual([
      expect.stringContaining("bbbb"),
      expect.stringContaining("cccc"),
      expect.stringContaining("dddd"),
    ]);
  });

  it("uses UTF-8 bytes for byte eviction", () => {
    const store = new TranscriptStore({ maxRecords: 10, maxBytes: 8 });
    store.appendUserPrompt("🙂🙂", 1);
    store.appendUserPrompt("a", 2);

    expect(store.snapshot().map((record) => record.text)).toEqual(["a"]);
  });

  it("does not replace an initial record whose id matches the generated sequence", () => {
    const initialRecord: TranscriptRecord = {
      id: "user:1",
      kind: "user",
      timestamp: 1,
      text: "initial",
    };
    const store = new TranscriptStore({ initialRecords: [initialRecord] });
    store.appendUserPrompt("next", 2);

    expect(store.snapshot().map((record) => record.text)).toEqual(["initial", "next"]);
  });

  it("bounds initial records with the same policy", () => {
    const initialRecords: TranscriptRecord[] = [
      { id: "one", kind: "status", timestamp: 1, text: "1111" },
      { id: "two", kind: "status", timestamp: 2, text: "2222" },
      { id: "three", kind: "status", timestamp: 3, text: "3333" },
    ];

    expect(new TranscriptStore({ maxRecords: 2, maxBytes: 100, initialRecords }).snapshot()).toEqual([
      initialRecords[1],
      initialRecords[2],
    ]);
  });

  it("notifies defensive snapshots and removes a throwing listener", () => {
    const store = new TranscriptStore();
    const stable = vi.fn();
    const throwing = vi.fn(() => {
      throw new Error("viewer failed");
    });
    store.subscribe(stable);
    store.subscribe(throwing);

    expect(() => store.appendUserPrompt("one", 1)).not.toThrow();
    store.appendUserPrompt("two", 2);
    const snapshot = store.snapshot();
    snapshot[0]!.text = "mutated";

    expect(stable).toHaveBeenCalledTimes(2);
    expect(throwing).toHaveBeenCalledOnce();
    expect(store.snapshot()[0]?.text).toBe("one");
  });

  it("dispose removes listeners and ignores later mutation", () => {
    const store = new TranscriptStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.appendUserPrompt("before", 1);
    store.dispose();
    store.appendUserPrompt("after", 2);
    unsubscribe();

    expect(listener).toHaveBeenCalledOnce();
    expect(store.snapshot().map((record) => record.text)).toEqual(["before"]);
  });
});

describe("TranscriptStore persisted replay", () => {
  it("replays user messages and detail records from only the requested child branch", () => {
    const records = TranscriptStore.replay(branchedEntries, "branch_b_leaf");
    const text = records.map((record) => record.text).join("\n");

    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "user", text: "branch b task" }),
        expect.objectContaining({ kind: "thinking", text: "branch b thought" }),
        expect.objectContaining({ kind: "text", text: "branch b answer" }),
        expect.objectContaining({ kind: "tool", toolCallId: "call_b", isError: false }),
        expect.objectContaining({ kind: "compaction", text: "branch b compacted summary" }),
        expect.objectContaining({ kind: "compaction", text: "branch b branch summary" }),
      ]),
    );
    expect(text).toContain("root task");
    expect(text).not.toContain("branch a task");
    expect(text).not.toContain("branch a answer");
  });

  it("returns an empty transcript for a missing leaf", () => {
    expect(TranscriptStore.replay(branchedEntries, "missing_leaf")).toEqual([]);
  });
});
