import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentRecord, AgentState } from "../types.ts";

const MAX_ROWS = 5;
const ACTIVE_STATES = new Set<AgentState>(["starting", "working"]);
const NEEDS_INPUT_STATES = new Set<AgentState>(["needs_context", "blocked"]);
const THINKING_SUFFIXES = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export interface AgentWidgetSource {
  list(): AgentRecord[];
  subscribe(listener: (records: AgentRecord[]) => void): () => void;
}

interface StatePresentation {
  icon: string;
  label: string;
  color: "accent" | "muted" | "warning" | "success" | "error";
}

const STATE_PRESENTATION: Record<AgentState, StatePresentation> = {
  starting: { icon: "○", label: "starting", color: "muted" },
  working: { icon: "●", label: "working", color: "accent" },
  needs_context: { icon: "!", label: "needs context", color: "warning" },
  blocked: { icon: "!", label: "blocked", color: "warning" },
  completed: { icon: "✓", label: "completed", color: "success" },
  failed: { icon: "✗", label: "failed", color: "error" },
  aborted: { icon: "■", label: "aborted", color: "muted" },
  interrupted: { icon: "◐", label: "interrupted", color: "warning" },
  removed: { icon: "■", label: "removed", color: "muted" },
};

function formatDuration(milliseconds: number): string {
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

export function shortenModel(canonical: string): string {
  let reference = canonical;
  let thinking = "";
  const colon = canonical.lastIndexOf(":");
  if (colon > canonical.indexOf("/") && THINKING_SUFFIXES.has(canonical.slice(colon + 1))) {
    reference = canonical.slice(0, colon);
    thinking = canonical.slice(colon);
  }
  let model = reference.slice(reference.indexOf("/") + 1).split("/").at(-1) ?? reference;
  model = model.replace(/-\d{8}$/, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
  for (const family of ["sonnet", "opus", "haiku"] as const) {
    if (model.toLowerCase().includes(family)) return `${family}${thinking}`;
  }
  model = model.replace(/^claude-/, "");
  return `${model}${thinking}`;
}

function latestActivity(record: AgentRecord): number {
  const run = record.runs.at(-1);
  if (ACTIVE_STATES.has(record.state)) return run?.startedAt ?? record.updatedAt;
  return run?.settledAt ?? record.updatedAt;
}

function priority(record: AgentRecord): number {
  if (NEEDS_INPUT_STATES.has(record.state)) return 0;
  if (ACTIVE_STATES.has(record.state)) return 1;
  return 2;
}

export class AgentWidget implements Component {
  private records: AgentRecord[];
  private unsubscribe: (() => void) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;

  constructor(
    private readonly source: AgentWidgetSource,
    private readonly theme: Theme,
    private readonly now: () => number = Date.now,
    private readonly requestRender: () => void = () => undefined,
  ) {
    this.records = source.list();
    this.unsubscribe = source.subscribe((records) => {
      if (this.disposed) return;
      this.records = structuredClone(records);
      this.syncTimer();
      this.requestRender();
    });
    this.syncTimer();
  }

  render(width: number): string[] {
    if (this.records.length === 0) return [];
    const active = this.records.filter((record) => ACTIVE_STATES.has(record.state)).length;
    const needsInput = this.records.filter((record) => NEEDS_INPUT_STATES.has(record.state)).length;
    const done = this.records.length - active - needsInput;
    const counts = [
      active > 0 ? `${active} working` : undefined,
      needsInput > 0 ? `${needsInput} needs input` : undefined,
      done > 0 ? `${done} done` : undefined,
    ].filter((value): value is string => value !== undefined);
    const header = this.theme.bold(this.theme.fg("accent", "subagents")) +
      `  ${counts.join(" · ")}  ${this.theme.fg("dim", "alt+a")}`;

    const sorted = [...this.records].sort((left, right) => {
      const byPriority = priority(left) - priority(right);
      return byPriority !== 0 ? byPriority : latestActivity(right) - latestActivity(left);
    });
    const lines = [header, ...sorted.slice(0, MAX_ROWS).map((record) => this.renderRecord(record))];
    if (sorted.length > MAX_ROWS) {
      lines.push(this.theme.fg("muted", `  +${sorted.length - MAX_ROWS} more`));
    }
    return lines.map((line) => truncateToWidth(line, Math.max(0, width)));
  }

  invalidate(): void {
    this.requestRender();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.clearTimer();
  }

  private renderRecord(record: AgentRecord): string {
    const presentation = STATE_PRESENTATION[record.state];
    const state = this.theme.fg(
      presentation.color,
      `${presentation.icon} ${presentation.label}`,
    );
    const shortId = record.id.startsWith("sa_") ? record.id.slice(3, 8) : record.id.slice(0, 5);
    const run = record.runs.at(-1);
    const duration = ACTIVE_STATES.has(record.state)
      ? this.now() - (run?.startedAt ?? record.createdAt)
      : (run?.settledAt ?? record.updatedAt) - (run?.startedAt ?? record.createdAt);
    return `  ${state}  ${this.theme.fg("muted", shortId)}  ${record.description}  ${this.theme.fg("dim", shortenModel(record.model))}  ${formatDuration(duration)}`;
  }

  private syncTimer(): void {
    const needsTimer = this.records.some((record) => ACTIVE_STATES.has(record.state));
    if (!needsTimer) {
      this.clearTimer();
      return;
    }
    if (this.timer) return;
    this.timer = setInterval(() => this.requestRender(), 1_000);
    const timer = this.timer as ReturnType<typeof setInterval> & { unref?: () => void };
    timer.unref?.();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
