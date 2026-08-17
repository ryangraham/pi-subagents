import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agent-manager.ts";
import type { AgentRecord, AgentState } from "../types.ts";
import { AgentWidget } from "./agent-widget.ts";

const WIDGET_ID = "pi-subagents";
const NOTIFIED_STATES = new Set<AgentState>([
  "completed",
  "needs_context",
  "blocked",
  "failed",
]);

const STATE_LABELS: Partial<Record<AgentState, string>> = {
  completed: "completed",
  needs_context: "needs context",
  blocked: "blocked",
  failed: "failed",
};

function notificationType(state: AgentState): "info" | "warning" | "error" {
  if (state === "failed") return "error";
  if (state === "needs_context" || state === "blocked") return "warning";
  return "info";
}

function noopController(): AgentUiController {
  return {
    dispose: () => undefined,
    open: async () => undefined,
  };
}

export interface AgentUiController {
  dispose(): void;
  open(ctx: ExtensionContext): Promise<void>;
}

export function installAgentUi(
  ctx: ExtensionContext,
  manager: AgentManager,
): AgentUiController {
  if (!ctx.hasUI || ctx.mode !== "tui") return noopController();

  let disposed = false;
  let widget: AgentWidget | undefined;
  const previousStates = new Map(
    manager.list().map((record) => [record.id, record.state] as const),
  );
  const unsubscribe = manager.subscribe((records: AgentRecord[]) => {
    if (disposed) return;
    const visible = new Set<string>();
    for (const record of records) {
      visible.add(record.id);
      const previous = previousStates.get(record.id);
      if (previous !== record.state && NOTIFIED_STATES.has(record.state)) {
        const label = STATE_LABELS[record.state] ?? record.state;
        ctx.ui.notify(
          `${record.id.slice(3, 8)} ${label}: ${record.description}`,
          notificationType(record.state),
        );
      }
      previousStates.set(record.id, record.state);
    }
    for (const id of previousStates.keys()) {
      if (!visible.has(id)) previousStates.delete(id);
    }
  });

  ctx.ui.setWidget(
    WIDGET_ID,
    (tui, theme) => {
      widget?.dispose();
      widget = new AgentWidget(manager, theme, Date.now, () => tui.requestRender());
      return widget;
    },
    { placement: "aboveEditor" },
  );

  return {
    async open(openContext): Promise<void> {
      if (disposed) return;
      openContext.ui.notify(
        "Agent viewer is not available until the viewer component is installed",
        "info",
      );
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      widget?.dispose();
      widget = undefined;
      ctx.ui.setWidget(WIDGET_ID, undefined);
    },
  };
}
