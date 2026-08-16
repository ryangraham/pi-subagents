import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ChildRun } from "../src/child-run.ts";
import { FakeAgentSession, fakeBundle, usage } from "./helpers/fakes.ts";

function launch(session: FakeAgentSession, now: () => number = () => 200): ChildRun {
  return ChildRun.launch({
    agentId: "sa_1234abcd",
    runId: "run_1",
    prompt: "work",
    bundle: fakeBundle(session),
    startedAt: 100,
    now,
  });
}

function assistant(text: string, messageUsage: Usage, timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "fake",
    model: "worker",
    usage: messageUsage,
    stopReason: "stop",
    timestamp,
  };
}

describe("ChildRun completion", () => {
  it("captures terminal text state leaf and per-run usage", async () => {
    const session = new FakeAgentSession();
    const run = launch(session);
    session.complete("Status: DONE", usage(15, 8), "leaf_1");

    await expect(run.completion).resolves.toMatchObject({
      agentId: "sa_1234abcd",
      runId: "run_1",
      state: "completed",
      finalText: "Status: DONE",
      childLeafId: "leaf_1",
      sessionFile: "/tmp/fake-child.jsonl",
      usage: usage(15, 8),
      startedAt: 100,
      settledAt: 200,
    });
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("converts prompt rejection into a failed outcome instead of an unhandled rejection", async () => {
    const session = new FakeAgentSession();
    const run = launch(session);
    session.fail(new Error("provider down"), usage(3, 1));

    await expect(run.completion).resolves.toMatchObject({
      state: "failed",
      error: "provider down",
      usage: usage(3, 1),
    });
  });

  it("keeps completion nonrejecting for a pathological non-Error rejection", async () => {
    const session = new FakeAgentSession();
    const run = launch(session);
    const rejection: { toString(): string } = {
      toString(): string {
        throw rejection;
      },
    };
    session.fail(rejection, usage(2, 1));

    await expect(run.completion).resolves.toMatchObject({
      state: "failed",
      error: "Unknown child failure",
      usage: usage(2, 1),
    });
  });

  it("converts a resolved provider-error message into a failed outcome", async () => {
    const session = new FakeAgentSession();
    const run = launch(session);
    session.completeError("quota exceeded", usage(4, 2));

    await expect(run.completion).resolves.toMatchObject({
      state: "failed",
      error: "quota exceeded",
      usage: usage(4, 2),
    });
  });

  it.each([
    ["NEEDS_CONTEXT", "needs_context"],
    ["BLOCKED", "blocked"],
  ] as const)("maps Status: %s to %s", async (status, state) => {
    const session = new FakeAgentSession();
    const run = launch(session);
    session.complete(`Status: ${status}`, usage(1, 1));

    await expect(run.completion).resolves.toMatchObject({ state });
  });

  it("sums assistant tool-result and compaction usage for only this run", async () => {
    const session = new FakeAgentSession();
    const run = launch(session);
    session.emitAssistant("calling tool", usage(1, 2), "toolUse");
    session.emitToolResult(usage(3, 4));
    session.emitCompaction({ ...usage(5, 6), reasoning: 2, cacheWrite1h: 3 });
    session.complete("Status: DONE", usage(7, 8));

    const outcome = await run.completion;
    expect(outcome.usage).toMatchObject({
      input: 16,
      output: 20,
      totalTokens: 36,
      reasoning: 2,
      cacheWrite1h: 3,
    });
    expect(outcome.usage.cost.total).toBeCloseTo(0.036);
  });
});

describe("ChildRun transcript lifecycle", () => {
  it("seeds a resumed transcript from its branch and appends the new prompt once", async () => {
    const entries: SessionEntry[] = [
      {
        type: "message",
        id: "old_user",
        parentId: null,
        timestamp: "2026-08-16T00:00:00.000Z",
        message: { role: "user", content: "old prompt", timestamp: 1 },
      },
      {
        type: "message",
        id: "old_leaf",
        parentId: "old_user",
        timestamp: "2026-08-16T00:00:01.000Z",
        message: assistant("old answer", usage(1, 1), 2),
      },
    ];
    const session = new FakeAgentSession(entries, "old_leaf");
    const run = launch(session);

    expect(run.transcript.snapshot().filter((record) => record.kind === "user")).toEqual([
      expect.objectContaining({ text: "old prompt" }),
      expect.objectContaining({ text: "work", timestamp: 100 }),
    ]);
    expect(session.prompt).toHaveBeenCalledOnce();
    expect(session.prompt).toHaveBeenCalledWith("work");

    session.complete("Status: DONE", usage(1, 1));
    await run.completion;
  });

  it("forwards live events then removes session and transcript listeners on completion", async () => {
    const session = new FakeAgentSession();
    const run = launch(session);
    const invalidated = vi.fn();
    run.transcript.subscribe(invalidated);
    session.emit({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 2,
      delayMs: 10,
      errorMessage: "temporary",
    });

    expect(run.transcript.snapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "retry", text: expect.stringContaining("temporary") }),
      ]),
    );
    expect(invalidated).toHaveBeenCalled();

    session.complete("Status: DONE", usage(1, 1));
    await run.completion;
    const settledSnapshot = run.transcript.snapshot();
    const calls = invalidated.mock.calls.length;
    session.emit({ type: "agent_settled" });

    expect(session.listenerCount).toBe(0);
    expect(run.transcript.snapshot()).toEqual(settledSnapshot);
    expect(invalidated).toHaveBeenCalledTimes(calls);
  });

  it("disposes idempotently", async () => {
    const session = new FakeAgentSession();
    const run = launch(session);
    session.complete("Status: DONE", usage(1, 1));
    await run.completion;

    run.dispose();
    run.dispose();
    expect(session.dispose).toHaveBeenCalledOnce();
  });
});

describe("ChildRun cancellation", () => {
  it("cancelling a foreground wait aborts the child and returns its outcome", async () => {
    const controller = new AbortController();
    const session = new FakeAgentSession();
    const run = launch(session);
    const waiting = run.wait(controller.signal, true);
    controller.abort();

    await expect(waiting).resolves.toMatchObject({ state: "aborted" });
    expect(session.abort).toHaveBeenCalledOnce();
  });

  it("cancelling a background wait detaches without aborting", async () => {
    const controller = new AbortController();
    const session = new FakeAgentSession();
    const run = launch(session);
    const waiting = run.wait(controller.signal, false);
    controller.abort();

    await expect(waiting).rejects.toThrow("Waiting cancelled");
    expect(session.abort).not.toHaveBeenCalled();
    session.complete("Status: DONE", usage(1, 1));
    await run.completion;
  });

  it("handles already-aborted wait signals according to cancellation mode", async () => {
    const detachedController = new AbortController();
    detachedController.abort();
    const detachedSession = new FakeAgentSession();
    const detached = launch(detachedSession);

    await expect(detached.wait(detachedController.signal, false)).rejects.toThrow("Waiting cancelled");
    expect(detachedSession.abort).not.toHaveBeenCalled();
    detachedSession.complete("Status: DONE", usage(1, 1));
    await detached.completion;

    const foregroundController = new AbortController();
    foregroundController.abort();
    const foregroundSession = new FakeAgentSession();
    const foreground = launch(foregroundSession);
    await expect(foreground.wait(foregroundController.signal, true)).resolves.toMatchObject({
      state: "aborted",
    });
    expect(foregroundSession.abort).toHaveBeenCalledOnce();
  });

  it("retains usage from an explicit user abort", async () => {
    const session = new FakeAgentSession();
    session.setAbortUsage(usage(5, 2));
    const run = launch(session);

    await run.abort("aborted");
    await expect(run.completion).resolves.toMatchObject({
      state: "aborted",
      usage: usage(5, 2),
    });
  });

  it("keeps the first abort reason and distinguishes shutdown interruption", async () => {
    const session = new FakeAgentSession();
    session.setAbortUsage(usage(2, 1));
    const run = launch(session);

    const interrupted = run.abort("interrupted");
    const repeated = run.abort("aborted");
    await Promise.all([interrupted, repeated]);

    await expect(run.completion).resolves.toMatchObject({
      state: "interrupted",
      usage: usage(2, 1),
    });
    expect(session.abort).toHaveBeenCalledOnce();
  });
});
