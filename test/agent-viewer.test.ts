import type {
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/agent-manager.ts";
import { AgentViewer } from "../src/ui/agent-viewer.ts";
import type { AgentRecord, AgentState, TranscriptRecord } from "../src/types.ts";
import { fixedManifest, usage } from "./helpers/fakes.ts";

const testTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  inverse: (text: string) => text,
} as Theme;

function stripAnsi(text: string): string {
  return text.replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, "");
}

function keyFor(action: string): string {
  return `<${action}>`;
}

const keybindings = {
  matches: (data: string, action: string) => data === keyFor(action),
} as KeybindingsManager;

function transcript(
  id: string,
  kind: TranscriptRecord["kind"],
  text: string,
  overrides: Partial<TranscriptRecord> = {},
): TranscriptRecord {
  return {
    id,
    kind,
    timestamp: 1_000,
    text,
    streaming: false,
    ...overrides,
  };
}

function record(
  id: string,
  state: AgentState,
  overrides: Partial<AgentRecord> = {},
): AgentRecord {
  const terminal = state !== "starting" && state !== "working";
  return {
    id,
    description: `${state} task`,
    cwd: "/repo",
    model: "fake/worker",
    state,
    manifest: structuredClone(fixedManifest),
    createdAt: 100,
    updatedAt: terminal ? 900 : 800,
    runs: terminal
      ? [
          {
            runId: `run_${id.slice(-8)}`,
            index: 1,
            promptSha256: "a".repeat(64),
            startedAt: 100,
            settledAt: 900,
            usage: usage(12, 3),
            usageClaimed: true,
          },
        ]
      : [
          {
            runId: `run_old_${id.slice(-4)}`,
            index: 1,
            promptSha256: "a".repeat(64),
            startedAt: 100,
            settledAt: 400,
            usage: usage(8, 2),
            usageClaimed: true,
          },
          {
            runId: `run_${id.slice(-8)}`,
            index: 2,
            promptSha256: "b".repeat(64),
            startedAt: 800,
            usageClaimed: false,
          },
        ],
    ...overrides,
  };
}

const working = record("sa_11111111", "working", { description: "Implement task 1" });
const completed = record("sa_22222222", "completed", { description: "Review task 1" });

class FakeViewerManager {
  records: AgentRecord[];
  readonly transcripts = new Map<string, TranscriptRecord[]>();
  readonly rosterListeners = new Set<(records: AgentRecord[]) => void>();
  readonly transcriptListeners = new Map<string, Set<(records: TranscriptRecord[]) => void>>();
  readonly rosterUnsubscribes: ReturnType<typeof vi.fn>[] = [];
  readonly transcriptUnsubscribes: ReturnType<typeof vi.fn>[] = [];
  readonly loadTranscript = vi.fn(async (agentId: string) =>
    structuredClone(this.transcripts.get(agentId) ?? []),
  );

  constructor(records: AgentRecord[]) {
    this.records = structuredClone(records);
    this.transcripts.set(working.id, [
      transcript("working-user", "user", "implement task 1"),
      transcript("working-text", "text", "working transcript"),
      transcript("working-thought", "thinking", "private chain of thought"),
    ]);
    this.transcripts.set(completed.id, [
      transcript("completed-text", "text", "completed transcript"),
    ]);
  }

  list(): AgentRecord[] {
    return structuredClone(this.records);
  }

  subscribe(listener: (records: AgentRecord[]) => void): () => void {
    this.rosterListeners.add(listener);
    listener(this.list());
    const unsubscribe = vi.fn(() => this.rosterListeners.delete(listener));
    this.rosterUnsubscribes.push(unsubscribe);
    return unsubscribe;
  }

  async load(agentId: string): Promise<TranscriptRecord[]> {
    return this.loadTranscript(agentId);
  }

  subscribeTranscript(
    agentId: string,
    listener: (records: TranscriptRecord[]) => void,
  ): () => void {
    const active = this.records.find((candidate) => candidate.id === agentId);
    if (active?.state !== "working") return () => undefined;
    const listeners = this.transcriptListeners.get(agentId) ?? new Set();
    listeners.add(listener);
    this.transcriptListeners.set(agentId, listeners);
    listener(structuredClone(this.transcripts.get(agentId) ?? []));
    const unsubscribe = vi.fn(() => listeners.delete(listener));
    this.transcriptUnsubscribes.push(unsubscribe);
    return unsubscribe;
  }

  updateRecords(records: AgentRecord[]): void {
    this.records = structuredClone(records);
    for (const listener of [...this.rosterListeners]) listener(this.list());
  }

  updateTranscript(agentId: string, records: TranscriptRecord[]): void {
    this.transcripts.set(agentId, structuredClone(records));
    for (const listener of [...(this.transcriptListeners.get(agentId) ?? [])]) {
      listener(structuredClone(records));
    }
  }
}

async function createViewer(
  records: AgentRecord[],
  options: {
    manager?: FakeViewerManager;
    onAbort?: (agentId: string) => void;
    onRemove?: (agentId: string) => void;
    onClose?: () => void;
    requestRender?: () => void;
  } = {},
): Promise<{ viewer: AgentViewer; manager: FakeViewerManager }> {
  const manager = options.manager ?? new FakeViewerManager(records);
  const viewer = await AgentViewer.create({
    manager: manager as unknown as AgentManager,
    theme: testTheme,
    keybindings,
    requestRender: options.requestRender ?? (() => undefined),
    onClose: options.onClose ?? (() => undefined),
    onAbort: options.onAbort ?? (() => undefined),
    onRemove: options.onRemove ?? (() => undefined),
  });
  return { viewer, manager };
}

async function settleLoads(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("AgentViewer", () => {
  it("switches the selected transcript with up and down", async () => {
    const { viewer } = await createViewer([working, completed]);
    expect(stripAnsi(viewer.render(120).join("\n"))).toContain("you  implement task 1");
    expect(stripAnsi(viewer.render(120).join("\n"))).toContain("working transcript");

    viewer.handleInput(keyFor("tui.select.down"));
    await settleLoads();
    expect(stripAnsi(viewer.render(120).join("\n"))).toContain("completed transcript");
    viewer.handleInput(keyFor("tui.select.up"));
    await settleLoads();
    expect(stripAnsi(viewer.render(120).join("\n"))).toContain("working transcript");
    viewer.dispose();
  });

  it("cycles transcript context and usage tabs", async () => {
    const { viewer } = await createViewer([working]);
    viewer.handleInput(keyFor("tui.input.tab"));
    const contextView = stripAnsi(viewer.render(120).join("\n"));
    expect(contextView).toContain("Context manifest");
    expect(contextView).toContain("extensions disabled");

    viewer.handleInput(keyFor("tui.input.tab"));
    const usageView = stripAnsi(viewer.render(120).join("\n"));
    expect(usageView).toContain("Run usage");
    expect(usageView).toContain("claimed");
    expect(usageView).toContain("10 tokens");
    viewer.dispose();
  });

  it("shows context and skill paths plus policy flags but never file contents", async () => {
    const withPaths = record(working.id, "working", {
      manifest: {
        ...structuredClone(fixedManifest),
        contextFiles: ["/repo/AGENTS.md", "/repo/packages/CLAUDE.md"],
        skills: [{ name: "test-driven-development", path: "/skills/tdd/SKILL.md" }],
      },
    });
    const { viewer } = await createViewer([withPaths]);
    viewer.handleInput(keyFor("tui.input.tab"));
    const text = stripAnsi(viewer.render(120).join("\n"));

    expect(text).toContain("/repo/AGENTS.md");
    expect(text).toContain("/repo/packages/CLAUDE.md");
    expect(text).toContain("test-driven-development");
    expect(text).toContain("/skills/tdd/SKILL.md");
    expect(text).toContain("parent history included: no");
    expect(text).not.toContain("secret file contents");
    viewer.dispose();
  });

  it("uses stacked layout below 100 columns and split layout at 100 columns", async () => {
    const { viewer } = await createViewer([working]);
    expect(viewer.layoutForWidth(99)).toBe("stacked");
    expect(viewer.layoutForWidth(100)).toBe("split");
    viewer.dispose();
  });

  it("requests abort and removal only for eligible selected agents", async () => {
    const onAbort = vi.fn();
    const onRemove = vi.fn();
    const { viewer } = await createViewer([working, completed], { onAbort, onRemove });

    viewer.handleInput("a");
    expect(onAbort).toHaveBeenCalledWith(working.id);
    viewer.handleInput("x");
    expect(onRemove).not.toHaveBeenCalled();
    viewer.handleInput(keyFor("tui.select.down"));
    viewer.handleInput("x");
    expect(onRemove).toHaveBeenCalledWith(completed.id);
    viewer.handleInput("a");
    expect(onAbort).toHaveBeenCalledTimes(1);
    viewer.dispose();
  });

  it("keeps a selection visible in a twenty-agent roster window", async () => {
    const records = Array.from({ length: 25 }, (_, index) =>
      record(`sa_${index.toString(16).padStart(8, "0")}`, "completed", {
        description: `terminal agent ${index}`,
        updatedAt: 10_000 - index,
        runs: [
          {
            runId: `run_${index}`,
            index: 1,
            promptSha256: "a".repeat(64),
            startedAt: 100,
            settledAt: 10_000 - index,
            usageClaimed: false,
          },
        ],
      }),
    );
    const { viewer } = await createViewer(records);
    for (let index = 0; index < 22; index += 1) {
      viewer.handleInput(keyFor("tui.select.down"));
    }
    await settleLoads();
    const selectedId = records[22]!.id;
    expect(stripAnsi(viewer.render(120).join("\n"))).toContain(`› ${selectedId}`);
    viewer.dispose();
  });

  it("scrolls detail by eighteen rows with page up and page down", async () => {
    const manager = new FakeViewerManager([working]);
    manager.transcripts.set(
      working.id,
      Array.from({ length: 55 }, (_, index) => transcript(`line-${index}`, "text", `line ${index}`)),
    );
    const { viewer } = await createViewer([working], { manager });
    expect(stripAnsi(viewer.render(120).join("\n"))).toContain("line 0");

    viewer.handleInput(keyFor("tui.select.pageDown"));
    const down = stripAnsi(viewer.render(120).join("\n"));
    expect(down).toContain("line 18");
    expect(down).not.toContain("assistant  line 0\n");
    viewer.handleInput(keyFor("tui.select.pageUp"));
    expect(stripAnsi(viewer.render(120).join("\n"))).toContain("line 0");
    viewer.dispose();
  });

  it("uses the configured thinking toggle and hides thinking by default", async () => {
    const { viewer } = await createViewer([working]);
    expect(stripAnsi(viewer.render(120).join("\n"))).not.toContain("private chain of thought");

    viewer.handleInput(keyFor("app.thinking.toggle"));
    expect(stripAnsi(viewer.render(120).join("\n"))).toContain("private chain of thought");
    viewer.handleInput(keyFor("app.thinking.toggle"));
    expect(stripAnsi(viewer.render(120).join("\n"))).not.toContain("private chain of thought");
    viewer.dispose();
  });

  it("closes on the configured cancel binding", async () => {
    const onClose = vi.fn();
    const { viewer } = await createViewer([working], { onClose });
    viewer.handleInput(keyFor("tui.select.cancel"));
    expect(onClose).toHaveBeenCalledOnce();
    viewer.dispose();
  });

  it("never renders a line wider than the supplied width", async () => {
    const long = record(working.id, "working", {
      description: "a very long description ".repeat(20),
    });
    const manager = new FakeViewerManager([long]);
    manager.transcripts.set(working.id, [
      transcript("long", "text", "an-unbroken-transcript-token-".repeat(30)),
    ]);
    const { viewer } = await createViewer([long], { manager });

    for (const width of [24, 40, 99, 100, 140]) {
      expect(viewer.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
    }
    viewer.dispose();
  });

  it("renders an empty roster without loading a transcript", async () => {
    const manager = new FakeViewerManager([]);
    const { viewer } = await createViewer([], { manager });
    const text = stripAnsi(viewer.render(80).join("\n"));
    expect(text).toContain("No subagents");
    expect(manager.loadTranscript).not.toHaveBeenCalled();
    viewer.handleInput("a");
    viewer.handleInput("x");
    viewer.dispose();
  });

  it("keeps selection on the same stable id when roster activity order changes", async () => {
    const first = record("sa_aaaaaaaa", "completed", { updatedAt: 2_000 });
    const second = record("sa_bbbbbbbb", "completed", { updatedAt: 1_000 });
    const manager = new FakeViewerManager([first, second]);
    manager.transcripts.set(first.id, [transcript("first", "text", "first transcript")]);
    manager.transcripts.set(second.id, [transcript("second", "text", "second transcript")]);
    const { viewer } = await createViewer([first, second], { manager });
    viewer.handleInput(keyFor("tui.select.down"));
    await settleLoads();

    manager.updateRecords([
      { ...first, updatedAt: 2_000 },
      { ...second, updatedAt: 3_000, runs: [{ ...second.runs[0]!, settledAt: 3_000 }] },
    ]);
    const text = stripAnsi(viewer.render(120).join("\n"));
    expect(text).toContain("sa_bbbbbbbb · completed");
    expect(text).toContain("second transcript");
    viewer.dispose();
  });

  it("attaches live updates when selected setup advances from starting to working", async () => {
    const starting = record("sa_44444444", "starting", { runs: [] });
    const manager = new FakeViewerManager([starting]);
    const { viewer } = await createViewer([starting], { manager });
    expect(manager.transcriptUnsubscribes).toHaveLength(0);

    const active = record(starting.id, "working", {
      description: starting.description,
      runs: [
        {
          runId: "run_started",
          index: 1,
          promptSha256: "d".repeat(64),
          startedAt: 2_000,
          usageClaimed: false,
        },
      ],
      updatedAt: 2_000,
    });
    manager.transcripts.set(starting.id, [transcript("started", "text", "setup became live")]);
    manager.updateRecords([active]);
    await settleLoads();
    manager.updateTranscript(starting.id, [transcript("live-start", "text", "live after setup")]);

    expect(stripAnsi(viewer.render(120).join("\n"))).toContain("live after setup");
    expect(manager.transcriptUnsubscribes).toHaveLength(1);
    viewer.dispose();
  });

  it("attaches live updates when the selected terminal agent becomes active", async () => {
    const terminal = record("sa_33333333", "completed");
    const manager = new FakeViewerManager([terminal]);
    manager.transcripts.set(terminal.id, [transcript("old", "text", "old terminal output")]);
    const { viewer } = await createViewer([terminal], { manager });
    expect(manager.transcriptUnsubscribes).toHaveLength(0);

    const resumed = record(terminal.id, "working", {
      description: terminal.description,
      runs: [
        ...terminal.runs,
        {
          runId: "run_resumed",
          index: 2,
          promptSha256: "c".repeat(64),
          startedAt: 2_000,
          usageClaimed: false,
        },
      ],
      updatedAt: 2_000,
    });
    manager.transcripts.set(terminal.id, [transcript("resume", "text", "resume started")]);
    manager.updateRecords([resumed]);
    await settleLoads();
    manager.updateTranscript(terminal.id, [transcript("live-resume", "text", "live resume output")]);

    expect(stripAnsi(viewer.render(120).join("\n"))).toContain("live resume output");
    expect(manager.transcriptUnsubscribes).toHaveLength(1);
    viewer.dispose();
  });

  it("shows live selected-agent transcript updates without reselection", async () => {
    const requestRender = vi.fn();
    const { viewer, manager } = await createViewer([working], { requestRender });
    requestRender.mockClear();
    manager.updateTranscript(working.id, [
      transcript("working-user", "user", "implement task 1"),
      transcript("live", "text", "new live output"),
    ]);

    expect(stripAnsi(viewer.render(120).join("\n"))).toContain("new live output");
    expect(requestRender).toHaveBeenCalled();
    viewer.dispose();
  });

  it("ignores stale asynchronous transcript loads after reselection", async () => {
    const manager = new FakeViewerManager([working, completed]);
    let resolveCompleted!: (records: TranscriptRecord[]) => void;
    const completedLoad = new Promise<TranscriptRecord[]>((resolve) => {
      resolveCompleted = resolve;
    });
    manager.loadTranscript.mockImplementation(async (agentId: string) => {
      if (agentId === completed.id) return completedLoad;
      return structuredClone(manager.transcripts.get(agentId) ?? []);
    });
    const { viewer } = await createViewer([working, completed], { manager });

    viewer.handleInput(keyFor("tui.select.down"));
    expect(stripAnsi(viewer.render(120).join("\n"))).toContain("Loading transcript");
    viewer.handleInput(keyFor("tui.select.up"));
    await settleLoads();
    resolveCompleted([transcript("stale", "text", "stale completed output")]);
    await settleLoads();

    const text = stripAnsi(viewer.render(120).join("\n"));
    expect(text).toContain("working transcript");
    expect(text).not.toContain("stale completed output");
    viewer.dispose();
  });

  it("disposes roster and selected transcript subscriptions", async () => {
    const requestRender = vi.fn();
    const { viewer, manager } = await createViewer([working], { requestRender });
    expect(manager.rosterUnsubscribes).toHaveLength(1);
    expect(manager.transcriptUnsubscribes).toHaveLength(1);

    viewer.dispose();
    expect(manager.rosterUnsubscribes[0]).toHaveBeenCalledOnce();
    expect(manager.transcriptUnsubscribes[0]).toHaveBeenCalledOnce();
    requestRender.mockClear();
    manager.updateRecords([completed]);
    manager.updateTranscript(working.id, [transcript("late", "text", "late")]);
    expect(requestRender).not.toHaveBeenCalled();
  });
});
