import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  addUsage,
  classifyFinalResponse,
  extractFinalAssistantText,
  formatOutcomeForModel,
  hashPrompt,
  truncateUtf8,
} from "../src/result.ts";
import { MAX_RESULT_BYTES } from "../src/types.ts";

const usage = (input: number, output: number): Usage => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + output,
  cost: {
    input: input / 1000,
    output: output / 1000,
    cacheRead: 0,
    cacheWrite: 0,
    total: (input + output) / 1000,
  },
});

describe("hashPrompt", () => {
  it("returns a stable SHA-256 digest", () => {
    expect(hashPrompt("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("classifyFinalResponse", () => {
  it.each([
    ["**Status:** DONE", "completed"],
    ["- Status: DONE_WITH_CONCERNS", "completed"],
    ["Status: NEEDS_CONTEXT", "needs_context"],
    ["status: needs_context", "needs_context"],
    ["Status: BLOCKED", "blocked"],
  ] as const)("maps %s", (text, expected) => {
    expect(classifyFinalResponse(text)).toBe(expected);
  });

  it("does not classify an unlabeled status word", () => {
    expect(classifyFinalResponse("### Spec Compliance\nReview says BLOCKED is not present\n✅ Approved")).toBe("completed");
  });
});

describe("extractFinalAssistantText", () => {
  it("concatenates text blocks from only the terminal assistant message", () => {
    const assistant = (
      content: Array<{ type: "text"; text: string } | { type: "thinking"; thinking: string }>,
    ): AgentMessage => ({
      role: "assistant",
      content,
      api: "anthropic-messages",
      provider: "fake",
      model: "worker",
      usage: usage(1, 1),
      stopReason: "stop",
      timestamp: 1,
    });
    const messages: AgentMessage[] = [
      assistant([{ type: "text", text: "old" }]),
      { role: "user", content: "next", timestamp: 2 },
      assistant([
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: "one" },
        { type: "text", text: "two" },
      ]),
    ];

    expect(extractFinalAssistantText(messages)).toBe("one\ntwo");
  });

  it("returns an empty string when no assistant message exists", () => {
    expect(extractFinalAssistantText([{ role: "user", content: "task", timestamp: 1 }])).toBe("");
  });
});

describe("addUsage", () => {
  it("adds token and cost fields for one run", () => {
    expect(addUsage(usage(10, 3), usage(5, 5))).toEqual(usage(15, 8));
  });

  it("adds optional cache-write and reasoning categories when either side reports them", () => {
    const left: Usage = { ...usage(1, 1), cacheWrite1h: 2, reasoning: 3 };
    const right: Usage = { ...usage(2, 2), cacheWrite1h: 5 };

    expect(addUsage(left, right)).toMatchObject({ cacheWrite1h: 7, reasoning: 3 });
  });

  it("adds cache categories independently", () => {
    const left: Usage = {
      ...usage(1, 2),
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: 10,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    };
    const right: Usage = {
      ...usage(10, 20),
      cacheRead: 30,
      cacheWrite: 40,
      totalTokens: 100,
      cost: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, total: 100 },
    };

    expect(addUsage(left, right)).toEqual({
      input: 11,
      output: 22,
      cacheRead: 33,
      cacheWrite: 44,
      totalTokens: 110,
      cost: { input: 11, output: 22, cacheRead: 33, cacheWrite: 44, total: 110 },
    });
  });
});

describe("truncateUtf8", () => {
  it("never splits a multibyte code point", () => {
    expect(truncateUtf8("ab🙂cd", 5)).toEqual({ text: "ab", truncated: true, omittedBytes: 6 });
  });

  it("leaves text within the byte budget unchanged", () => {
    expect(truncateUtf8("🙂", 4)).toEqual({ text: "🙂", truncated: false, omittedBytes: 0 });
  });
});

describe("formatOutcomeForModel", () => {
  it("adds identity and status without returning transcript history", () => {
    expect(formatOutcomeForModel("sa_ab12cd34", "completed", "Status: DONE", "/tmp/child.jsonl")).toBe(
      "agent_id: sa_ab12cd34\nstatus: completed\n\nStatus: DONE",
    );
  });

  it("adds the local session reference only when truncation occurs", () => {
    const oversized = formatOutcomeForModel(
      "sa_ab12cd34",
      "completed",
      "x".repeat(MAX_RESULT_BYTES + 1),
      "/tmp/child.jsonl",
    );

    expect(oversized).toContain("[Output truncated: 1 bytes omitted. Full output: /tmp/child.jsonl]");
    expect(formatOutcomeForModel("sa_ab12cd34", "completed", "short", "/tmp/child.jsonl")).not.toContain(
      "/tmp/child.jsonl",
    );
    expect(formatOutcomeForModel("sa_ab12cd34", "failed", "x".repeat(MAX_RESULT_BYTES + 1))).toContain(
      "[Output truncated: 1 bytes omitted.]",
    );
  });
});
