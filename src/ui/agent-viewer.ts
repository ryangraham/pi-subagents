import type {
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
  matchesKey,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { AgentManager } from "../agent-manager.ts";
import type {
  AgentRecord,
  AgentState,
  ContextManifest,
  TranscriptRecord,
} from "../types.ts";

const SPLIT_MIN_WIDTH = 100;
const ROSTER_WIDTH = 32;
const ROSTER_WINDOW = 20;
const DETAIL_WINDOW = 20;
const DETAIL_PAGE = 18;
const ACTIVE_STATES = new Set<AgentState>(["starting", "working"]);
const NEEDS_INPUT_STATES = new Set<AgentState>(["needs_context", "blocked"]);

export type ViewerTab = "transcript" | "context" | "usage";
export type ViewerLayout = "split" | "stacked";

export interface AgentViewerOptions {
  manager: AgentManager;
  theme: Theme;
  keybindings: KeybindingsManager;
  requestRender: () => void;
  onClose: () => void;
  onAbort: (agentId: string) => void;
  onRemove: (agentId: string) => void;
}

function groupIndex(record: AgentRecord): number {
  if (NEEDS_INPUT_STATES.has(record.state)) return 0;
  if (ACTIVE_STATES.has(record.state)) return 1;
  return 2;
}

function groupName(record: AgentRecord): string {
  if (NEEDS_INPUT_STATES.has(record.state)) return "Needs input";
  if (ACTIVE_STATES.has(record.state)) return "Working";
  return "Completed";
}

function stateLabel(state: AgentState): string {
  return state === "needs_context" ? "needs context" : state;
}

function latestActivity(record: AgentRecord): number {
  const run = record.runs.at(-1);
  return ACTIVE_STATES.has(record.state)
    ? run?.startedAt ?? record.updatedAt
    : run?.settledAt ?? record.updatedAt;
}

function orderRoster(records: readonly AgentRecord[]): AgentRecord[] {
  return structuredClone([...records]).sort((left, right) => {
    const byGroup = groupIndex(left) - groupIndex(right);
    if (byGroup !== 0) return byGroup;
    const byActivity = latestActivity(right) - latestActivity(left);
    return byActivity !== 0 ? byActivity : left.id.localeCompare(right.id);
  });
}

function fit(line: string, width: number): string {
  if (width <= 0) return "";
  return sliceByColumn(truncateToWidth(line, width), 0, width);
}

function pad(line: string, width: number): string {
  const fitted = fit(line, width);
  return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

function wrapLine(line: string, width: number): string[] {
  if (width <= 0) return [];
  const wrapped = wrapTextWithAnsi(line, width);
  return (wrapped.length > 0 ? wrapped : [""]).map((value) => fit(value, width));
}

function transcriptLabel(record: TranscriptRecord): string {
  switch (record.kind) {
    case "user":
      return "you";
    case "text":
      return "assistant";
    case "thinking":
      return "thinking";
    case "tool":
      return record.toolName ? `tool ${record.toolName}` : "tool";
    case "retry":
      return "retry";
    case "compaction":
      return "compaction";
    case "error":
      return "error";
    case "status":
      return "status";
  }
}

function transcriptLogicalLines(
  records: readonly TranscriptRecord[],
  showThinking: boolean,
  theme: Theme,
): string[] {
  const lines: string[] = [];
  for (const record of records) {
    if (!showThinking && record.kind === "thinking") continue;
    const label = transcriptLabel(record);
    const color = record.kind === "error" || record.isError
      ? "error"
      : record.kind === "thinking"
        ? "dim"
        : record.kind === "user"
          ? "accent"
          : "muted";
    const renderedLabel = theme.fg(color, label);
    let text = record.text || "(empty)";
    if (record.kind === "tool") {
      const firstLine = text.split("\n", 1)[0] ?? "";
      const points = [...firstLine];
      const summary = points.length > 240 ? points.slice(0, 239).join("") : firstLine;
      const collapsed = text.includes("\n") || points.length > 240;
      text = `${summary}${collapsed ? " … [collapsed]" : ""}`;
    }
    const textLines = text.split("\n");
    lines.push(`${renderedLabel}  ${textLines[0] ?? ""}`);
    const indent = " ".repeat(label.length + 2);
    for (const continuation of textLines.slice(1)) lines.push(`${indent}${continuation}`);
  }
  return lines.length > 0 ? lines : [theme.fg("muted", "No transcript records")];
}

function contextLines(manifest: ContextManifest | undefined): string[] {
  if (!manifest) return ["Context manifest", "No context manifest recorded"];
  return [
    "Context manifest",
    `cwd: ${manifest.cwd}`,
    `model: ${manifest.model}`,
    `thinking: ${manifest.thinkingLevel}`,
    "context files:",
    ...(manifest.contextFiles.length > 0
      ? manifest.contextFiles.map((path) => `  ${path}`)
      : ["  none"]),
    "skills:",
    ...(manifest.skills.length > 0
      ? manifest.skills.map((skill) => `  ${skill.name}: ${skill.path}`)
      : ["  none"]),
    `tools: ${manifest.tools.join(", ") || "none"}`,
    "policy:",
    `  parent history included: ${manifest.parentHistoryIncluded ? "yes" : "no"}`,
    `  extensions disabled: ${manifest.extensionsDisabled ? "yes" : "no"}`,
    `  prompt templates disabled: ${manifest.promptTemplatesDisabled ? "yes" : "no"}`,
    `  themes disabled: ${manifest.themesDisabled ? "yes" : "no"}`,
    `  custom system prompts disabled: ${manifest.customSystemPromptsDisabled ? "yes" : "no"}`,
    `  agent definitions disabled: ${manifest.agentDefinitionsDisabled ? "yes" : "no"}`,
    `dispatch: ${manifest.dispatchBytes} bytes · sha256 ${manifest.dispatchSha256}`,
  ];
}

function usageLines(record: AgentRecord): string[] {
  const lines = ["Run usage"];
  if (record.runs.length === 0) return [...lines, "No runs recorded"];
  for (const run of record.runs) {
    lines.push(`run ${run.index} · ${run.runId} · ${run.usageClaimed ? "claimed" : "unclaimed"}`);
    if (!run.usage) {
      lines.push("  No usage recorded");
      continue;
    }
    lines.push(
      `  ${run.usage.totalTokens} tokens · ${run.usage.input} input · ${run.usage.output} output`,
      `  cache: ${run.usage.cacheRead} read · ${run.usage.cacheWrite} write`,
    );
    if (run.usage.cacheWrite1h !== undefined) {
      lines.push(`  cache 1h write: ${run.usage.cacheWrite1h}`);
    }
    if (run.usage.reasoning !== undefined) lines.push(`  reasoning: ${run.usage.reasoning}`);
    lines.push(`  cost: $${run.usage.cost.total.toFixed(6)}`);
  }
  return lines;
}

export class AgentViewer implements Component {
  private records: AgentRecord[];
  private selectedId: string | undefined;
  private rosterStart = 0;
  private tab: ViewerTab = "transcript";
  private detailScroll = 0;
  private detailLineCount = 0;
  private showThinking = false;
  private transcript: TranscriptRecord[] = [];
  private loadingTranscript = false;
  private transcriptError: string | undefined;
  private rosterUnsubscribe: (() => void) | undefined;
  private transcriptUnsubscribe: (() => void) | undefined;
  private loadGeneration = 0;
  private disposed = false;

  private constructor(private readonly options: AgentViewerOptions) {
    this.records = orderRoster(options.manager.list());
    this.selectedId = this.records[0]?.id;
    this.rosterUnsubscribe = options.manager.subscribe((records) => this.updateRoster(records));
  }

  static async create(options: AgentViewerOptions): Promise<AgentViewer> {
    const viewer = new AgentViewer(options);
    await viewer.loadSelectedTranscript();
    return viewer;
  }

  layoutForWidth(width: number): ViewerLayout {
    return width < SPLIT_MIN_WIDTH ? "stacked" : "split";
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    if (safeWidth === 0) return [];
    if (this.layoutForWidth(safeWidth) === "stacked") {
      const roster = this.renderRoster(safeWidth);
      const detail = this.renderDetail(safeWidth);
      return [
        ...roster,
        fit(this.options.theme.fg("borderMuted", "─".repeat(safeWidth)), safeWidth),
        ...detail,
      ].map((line) => fit(line, safeWidth));
    }

    const detailWidth = safeWidth - ROSTER_WIDTH - 1;
    const roster = this.renderRoster(ROSTER_WIDTH);
    const detail = this.renderDetail(detailWidth);
    const count = Math.max(roster.length, detail.length);
    const lines: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const left = pad(roster[index] ?? "", ROSTER_WIDTH);
      const separator = this.options.theme.fg("borderMuted", "│");
      lines.push(fit(`${left}${separator}${detail[index] ?? ""}`, safeWidth));
    }
    return lines;
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (this.options.keybindings.matches(data, "tui.select.cancel")) {
      this.options.onClose();
      return;
    }
    if (this.options.keybindings.matches(data, "tui.select.up")) {
      this.moveSelection(-1);
      return;
    }
    if (this.options.keybindings.matches(data, "tui.select.down")) {
      this.moveSelection(1);
      return;
    }
    if (this.options.keybindings.matches(data, "tui.input.tab")) {
      const tabs: ViewerTab[] = ["transcript", "context", "usage"];
      this.tab = tabs[(tabs.indexOf(this.tab) + 1) % tabs.length]!;
      this.detailScroll = 0;
      this.detailLineCount = 0;
      this.options.requestRender();
      return;
    }
    if (this.options.keybindings.matches(data, "app.thinking.toggle")) {
      this.showThinking = !this.showThinking;
      this.detailScroll = 0;
      this.detailLineCount = 0;
      this.options.requestRender();
      return;
    }
    if (this.options.keybindings.matches(data, "tui.select.pageUp")) {
      this.detailScroll = Math.max(0, this.detailScroll - DETAIL_PAGE);
      this.options.requestRender();
      return;
    }
    if (this.options.keybindings.matches(data, "tui.select.pageDown")) {
      const maximum = Math.max(0, this.detailLineCount - DETAIL_WINDOW);
      this.detailScroll = Math.min(maximum, this.detailScroll + DETAIL_PAGE);
      this.options.requestRender();
      return;
    }

    const selected = this.selectedRecord();
    if (!selected) return;
    if (matchesKey(data, "a") && ACTIVE_STATES.has(selected.state)) {
      this.options.onAbort(selected.id);
      return;
    }
    if (matchesKey(data, "x") && !ACTIVE_STATES.has(selected.state)) {
      this.options.onRemove(selected.id);
    }
  }

  invalidate(): void {
    if (!this.disposed) this.options.requestRender();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loadGeneration += 1;
    this.rosterUnsubscribe?.();
    this.rosterUnsubscribe = undefined;
    this.transcriptUnsubscribe?.();
    this.transcriptUnsubscribe = undefined;
  }

  private selectedRecord(): AgentRecord | undefined {
    return this.records.find((record) => record.id === this.selectedId);
  }

  private updateRoster(nextRecords: AgentRecord[]): void {
    if (this.disposed) return;
    const oldRecords = this.records;
    const oldId = this.selectedId;
    const oldIndex = Math.max(0, oldRecords.findIndex((record) => record.id === oldId));
    const oldState = oldRecords.find((record) => record.id === oldId)?.state;
    this.records = orderRoster(nextRecords);
    if (!oldId || !this.records.some((record) => record.id === oldId)) {
      this.selectedId = this.records[Math.min(oldIndex, Math.max(0, this.records.length - 1))]?.id;
    }
    this.ensureRosterVisibility();
    const selectedState = this.selectedRecord()?.state;
    const selectionChanged = oldId !== this.selectedId;
    const selectedStateChanged = oldState !== undefined &&
      selectedState !== undefined &&
      oldState !== selectedState;
    if (selectionChanged || selectedStateChanged) {
      this.detailScroll = 0;
      this.detailLineCount = 0;
      void this.loadSelectedTranscript();
    }
    this.options.requestRender();
  }

  private moveSelection(offset: number): void {
    if (this.records.length === 0) return;
    const current = Math.max(0, this.records.findIndex((record) => record.id === this.selectedId));
    const next = Math.max(0, Math.min(this.records.length - 1, current + offset));
    if (next === current) return;
    this.selectedId = this.records[next]!.id;
    this.detailScroll = 0;
    this.detailLineCount = 0;
    this.ensureRosterVisibility();
    void this.loadSelectedTranscript();
    this.options.requestRender();
  }

  private ensureRosterVisibility(): void {
    const selectedIndex = this.records.findIndex((record) => record.id === this.selectedId);
    if (selectedIndex < 0) {
      this.rosterStart = 0;
      return;
    }
    if (selectedIndex < this.rosterStart) this.rosterStart = selectedIndex;
    if (selectedIndex >= this.rosterStart + ROSTER_WINDOW) {
      this.rosterStart = selectedIndex - ROSTER_WINDOW + 1;
    }
    this.rosterStart = Math.max(
      0,
      Math.min(this.rosterStart, Math.max(0, this.records.length - ROSTER_WINDOW)),
    );
  }

  private async loadSelectedTranscript(): Promise<void> {
    const generation = ++this.loadGeneration;
    this.transcriptUnsubscribe?.();
    this.transcriptUnsubscribe = undefined;
    const agentId = this.selectedId;
    if (!agentId) {
      this.transcript = [];
      this.loadingTranscript = false;
      this.transcriptError = undefined;
      return;
    }

    this.loadingTranscript = true;
    this.transcriptError = undefined;
    this.transcript = [];
    this.detailLineCount = 0;
    this.options.requestRender();
    try {
      const records = await this.options.manager.loadTranscript(agentId);
      if (this.disposed || generation !== this.loadGeneration || this.selectedId !== agentId) return;
      this.transcript = structuredClone(records);
      this.loadingTranscript = false;
      const selected = this.selectedRecord();
      if (selected && ACTIVE_STATES.has(selected.state)) {
        const unsubscribe = this.options.manager.subscribeTranscript(agentId, (updated) => {
          if (this.disposed || generation !== this.loadGeneration || this.selectedId !== agentId) return;
          this.transcript = structuredClone(updated);
          this.loadingTranscript = false;
          this.transcriptError = undefined;
          this.options.requestRender();
        });
        if (this.disposed || generation !== this.loadGeneration || this.selectedId !== agentId) {
          unsubscribe();
        } else {
          this.transcriptUnsubscribe = unsubscribe;
        }
      }
      this.options.requestRender();
    } catch (error) {
      if (this.disposed || generation !== this.loadGeneration || this.selectedId !== agentId) return;
      this.loadingTranscript = false;
      this.transcriptError = error instanceof Error ? error.message : String(error);
      this.options.requestRender();
    }
  }

  private renderRoster(width: number): string[] {
    const lines = [this.options.theme.bold(this.options.theme.fg("accent", "Agents"))];
    if (this.records.length === 0) {
      lines.push(this.options.theme.fg("muted", "No subagents"));
      return lines.map((line) => fit(line, width));
    }
    const visible = this.records.slice(this.rosterStart, this.rosterStart + ROSTER_WINDOW);
    let previousGroup: string | undefined;
    for (const record of visible) {
      const group = groupName(record);
      if (group !== previousGroup) {
        lines.push(this.options.theme.bold(this.options.theme.fg("muted", group)));
        previousGroup = group;
      }
      const marker = record.id === this.selectedId ? "›" : " ";
      lines.push(`${marker} ${record.id} ${stateLabel(record.state)} ${record.description}`);
    }
    if (this.rosterStart > 0) lines.splice(1, 0, this.options.theme.fg("dim", `↑ ${this.rosterStart} more`));
    const below = this.records.length - (this.rosterStart + visible.length);
    if (below > 0) lines.push(this.options.theme.fg("dim", `↓ ${below} more`));
    return lines.map((line) => fit(line, width));
  }

  private renderDetail(width: number): string[] {
    const selected = this.selectedRecord();
    if (!selected) {
      this.detailLineCount = 1;
      return [
        this.options.theme.bold("Agent detail"),
        this.options.theme.fg("muted", "No agent selected"),
        this.options.theme.fg("dim", "Esc close"),
      ].map((line) => fit(line, width));
    }

    const title = this.options.theme.bold(`${selected.id} · ${stateLabel(selected.state)} · ${selected.description}`);
    const tabs: ViewerTab[] = ["transcript", "context", "usage"];
    const tabLine = tabs
      .map((tab) => tab === this.tab ? this.options.theme.fg("accent", `[${tab}]`) : tab)
      .join("  ");
    let logical: string[];
    if (this.tab === "context") {
      logical = contextLines(selected.manifest);
    } else if (this.tab === "usage") {
      logical = usageLines(selected);
    } else if (this.loadingTranscript) {
      logical = ["Loading transcript…"];
    } else if (this.transcriptError) {
      logical = [this.options.theme.fg("error", `Transcript error: ${this.transcriptError}`)];
    } else {
      logical = transcriptLogicalLines(this.transcript, this.showThinking, this.options.theme);
    }

    const wrapped = logical.flatMap((line) => wrapLine(line, width));
    this.detailLineCount = wrapped.length;
    this.detailScroll = Math.min(this.detailScroll, Math.max(0, wrapped.length - DETAIL_WINDOW));
    const viewport = wrapped.slice(this.detailScroll, this.detailScroll + DETAIL_WINDOW);
    const controls = ACTIVE_STATES.has(selected.state)
      ? "↑↓ select · pgup/pgdn scroll · tab view · ctrl+t thinking · a abort · esc close"
      : "↑↓ select · pgup/pgdn scroll · tab view · ctrl+t thinking · x remove · esc close";
    return [title, tabLine, ...viewport, this.options.theme.fg("dim", controls)]
      .map((line) => fit(line, width));
  }
}
