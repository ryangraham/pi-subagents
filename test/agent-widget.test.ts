import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentWidget, type AgentWidgetSource } from "../src/ui/agent-widget.ts";
import type { AgentRecord, AgentState } from "../src/types.ts";

const testTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

function stripAnsi(text: string): string {
  return text.replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, "");
}

function agent(
  id: string,
  state: AgentState,
  overrides: Partial<AgentRecord> = {},
): AgentRecord {
  return {
    id,
    description: `${state} agent`,
    cwd: "/repo",
    model: "fake/worker",
    state,
    createdAt: 10_000,
    updatedAt: 50_000,
    runs: [
      {
        runId: `run_${id.slice(-8)}`,
        index: 1,
        promptSha256: "a".repeat(64),
        startedAt: 20_000,
        settledAt: 50_000,
        usageClaimed: false,
      },
    ],
    ...overrides,
  };
}

class Source implements AgentWidgetSource {
  private records: AgentRecord[];
  private readonly listeners = new Set<(records: AgentRecord[]) => void>();

  constructor(records: AgentRecord[]) {
    this.records = structuredClone(records);
  }

  list(): AgentRecord[] {
    return structuredClone(this.records);
  }

  subscribe(listener: (records: AgentRecord[]) => void): () => void {
    this.listeners.add(listener);
    listener(this.list());
    return () => this.listeners.delete(listener);
  }

  update(records: AgentRecord[]): void {
    this.records = structuredClone(records);
    for (const listener of [...this.listeners]) listener(this.list());
  }
}

function sourceWith(records: AgentRecord[]): Source {
  return new Source(records);
}

afterEach(() => vi.useRealTimers());

describe("AgentWidget", () => {
  it("orders needs-input working then recent terminal agents", () => {
    const completed = agent("sa_ccccc003", "completed", { updatedAt: 119_000 });
    const working = agent("sa_bbbbb002", "working", {
      updatedAt: 118_000,
      runs: [
        {
          runId: "run_working",
          index: 1,
          promptSha256: "b".repeat(64),
          startedAt: 110_000,
          usageClaimed: false,
        },
      ],
    });
    const needsContext = agent("sa_aaaaa001", "needs_context", { updatedAt: 100_000 });
    const widget = new AgentWidget(
      sourceWith([completed, working, needsContext]),
      testTheme,
      () => 120_000,
    );

    expect(widget.render(100).slice(1).map(stripAnsi)).toEqual([
      expect.stringContaining("needs context"),
      expect.stringContaining("working"),
      expect.stringContaining("completed"),
    ]);
    widget.dispose();
  });

  it("shows at most five rows plus overflow", () => {
    const records = Array.from({ length: 7 }, (_, index) =>
      agent(`sa_${(index + 1).toString(16).padStart(8, "0")}`, "completed", {
        updatedAt: 100_000 - index,
      }),
    );
    const widget = new AgentWidget(sourceWith(records), testTheme, () => 120_000);
    const lines = widget.render(100);

    expect(lines).toHaveLength(7);
    expect(stripAnsi(lines.at(-1) ?? "")).toContain("+2 more");
    widget.dispose();
  });

  it("never renders wider than the supplied width", () => {
    const longDescription = agent("sa_1234abcd", "working", {
      description: "A very long description that cannot fit in the compact widget row",
      model: "anthropic/claude-sonnet-4-20250514:high",
      runs: [
        {
          runId: "run_long",
          index: 1,
          promptSha256: "c".repeat(64),
          startedAt: 1,
          usageClaimed: false,
        },
      ],
    });
    const widget = new AgentWidget(sourceWith([longDescription]), testTheme, () => 120_000);
    const lines = widget.render(32);

    expect(lines.every((line) => visibleWidth(line) <= 32)).toBe(true);
    widget.dispose();
  });

  it("renders nothing before the first visible agent", () => {
    const widget = new AgentWidget(sourceWith([]), testTheme, () => 120_000);
    expect(widget.render(80)).toEqual([]);
    widget.dispose();
  });

  it("shows compact ids model families and state words independently of color", () => {
    const widget = new AgentWidget(
      sourceWith([
        agent("sa_1234abcd", "working", {
          model: "anthropic/claude-sonnet-4-20250514:high",
          runs: [
            {
              runId: "run_model",
              index: 1,
              promptSha256: "d".repeat(64),
              startedAt: 110_000,
              usageClaimed: false,
            },
          ],
        }),
      ]),
      testTheme,
      () => 120_000,
    );
    const text = stripAnsi(widget.render(120)[1] ?? "");

    expect(text).toContain("● working");
    expect(text).toContain("1234a");
    expect(text).not.toContain("sa_1234a");
    expect(text).toContain("sonnet:high");
    widget.dispose();
  });

  it("uses latest-run elapsed and terminal durations", () => {
    const active = agent("sa_aaaaa001", "working", {
      runs: [
        {
          runId: "run_active",
          index: 2,
          promptSha256: "e".repeat(64),
          startedAt: 50_000,
          usageClaimed: false,
        },
      ],
    });
    const terminal = agent("sa_bbbbb002", "completed", {
      runs: [
        {
          runId: "run_terminal",
          index: 2,
          promptSha256: "f".repeat(64),
          startedAt: 10_000,
          settledAt: 48_000,
          usageClaimed: false,
        },
      ],
    });
    const widget = new AgentWidget(sourceWith([active, terminal]), testTheme, () => 120_000);
    const lines = widget.render(120).map(stripAnsi);

    expect(lines.find((line) => line.includes("aaaaa"))).toContain("1m 10s");
    expect(lines.find((line) => line.includes("bbbbb"))).toContain("38s");
    widget.dispose();
  });

  it("runs elapsed refresh only while active and disposes subscriptions and timers", () => {
    vi.useFakeTimers();
    const source = sourceWith([
      agent("sa_1234abcd", "working", {
        runs: [
          {
            runId: "run_active",
            index: 1,
            promptSha256: "a".repeat(64),
            startedAt: 1,
            usageClaimed: false,
          },
        ],
      }),
    ]);
    const requestRender = vi.fn();
    const widget = new AgentWidget(source, testTheme, () => Date.now(), requestRender);
    requestRender.mockClear();

    vi.advanceTimersByTime(1_000);
    expect(requestRender).toHaveBeenCalledOnce();
    source.update([agent("sa_1234abcd", "completed")]);
    requestRender.mockClear();
    vi.advanceTimersByTime(2_000);
    expect(requestRender).not.toHaveBeenCalled();

    widget.dispose();
    source.update([agent("sa_1234abcd", "working")]);
    vi.advanceTimersByTime(2_000);
    expect(requestRender).not.toHaveBeenCalled();
  });
});
