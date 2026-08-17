import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { AgentManager } from "../agent-manager.ts";
import type { AgentRecord, AgentState } from "../types.ts";
import { AgentViewer } from "./agent-viewer.ts";
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

function describeError(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "Unknown subagent operation failure";
  }
}

function notifyOperationError(
  ctx: ExtensionContext,
  operation: "abort" | "remove",
  agentId: string,
  error: unknown,
): void {
  try {
    ctx.ui.notify(`Failed to ${operation} ${agentId}: ${describeError(error)}`, "error");
  } catch {
    // A local notification failure must not turn a fire-and-forget UI action
    // into an unhandled rejection.
  }
}

function requestRender(tui: TUI): void {
  try {
    tui.requestRender();
  } catch {
    // The overlay may have closed while confirmation was visible.
  }
}

async function confirmAbort(
  ctx: ExtensionContext,
  manager: AgentManager,
  agentId: string,
  tui: TUI,
): Promise<void> {
  try {
    const confirmed = await ctx.ui.confirm(
      "Abort subagent?",
      `Abort ${agentId}? The child will keep its transcript and can be inspected afterward.`,
    );
    if (!confirmed) return;
    await manager.abort(agentId);
    requestRender(tui);
  } catch (error) {
    notifyOperationError(ctx, "abort", agentId, error);
  }
}

async function confirmRemove(
  ctx: ExtensionContext,
  manager: AgentManager,
  agentId: string,
  tui: TUI,
): Promise<void> {
  try {
    const confirmed = await ctx.ui.confirm(
      "Remove subagent?",
      `Remove ${agentId} from this branch's roster? Its child JSONL will be retained.`,
    );
    if (!confirmed) return;
    await manager.remove(agentId);
    requestRender(tui);
  } catch (error) {
    notifyOperationError(ctx, "remove", agentId, error);
  }
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
  let activeViewer: AgentViewer | undefined;
  let activeDone: ((value: undefined) => void) | undefined;
  let openPromise: Promise<void> | undefined;
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

  try {
    ctx.ui.setWidget(
      WIDGET_ID,
      (tui, theme) => {
        widget?.dispose();
        widget = new AgentWidget(manager, theme, Date.now, () => tui.requestRender());
        return widget;
      },
      { placement: "aboveEditor" },
    );
  } catch (error) {
    unsubscribe();
    throw error;
  }

  const controller: AgentUiController = {
    async open(openContext): Promise<void> {
      if (disposed || !openContext.hasUI || openContext.mode !== "tui") return;
      if (openPromise) {
        await openPromise;
        return;
      }

      const operation = openContext.ui.custom<void>(
        async (tui, theme, keybindings, done) => {
          activeDone = done;
          const viewer = await AgentViewer.create({
            manager,
            theme,
            keybindings,
            requestRender: () => tui.requestRender(),
            onClose: () => done(undefined),
            onAbort: (agentId) => void confirmAbort(openContext, manager, agentId, tui),
            onRemove: (agentId) => void confirmRemove(openContext, manager, agentId, tui),
          });
          if (disposed) {
            viewer.dispose();
            done(undefined);
          } else {
            activeViewer = viewer;
          }
          return viewer;
        },
        {
          overlay: true,
          overlayOptions: { width: "95%", maxHeight: "90%", anchor: "center", margin: 1 },
        },
      );
      openPromise = operation;
      try {
        await operation;
      } finally {
        if (openPromise === operation) openPromise = undefined;
        activeDone = undefined;
        const viewer = activeViewer;
        activeViewer = undefined;
        viewer?.dispose();
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      const done = activeDone;
      activeDone = undefined;
      try {
        done?.(undefined);
      } catch {
        // Continue releasing subscriptions even if the host overlay already closed.
      }
      const viewer = activeViewer;
      activeViewer = undefined;
      viewer?.dispose();
      unsubscribe();
      widget?.dispose();
      widget = undefined;
      try {
        ctx.ui.setWidget(WIDGET_ID, undefined);
      } catch {
        // Session teardown must still release local resources if the host UI
        // has already reset extension widgets.
      }
    },
  };
  return controller;
}
