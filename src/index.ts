import {
  getAgentDir,
  ModelRuntime,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { AgentManager } from "./agent-manager.ts";
import { AgentRegistry } from "./registry.ts";
import { SessionFactory } from "./session-factory.ts";
import { registerSubagentTools } from "./tools.ts";
import { CUSTOM_ENTRY_TYPE } from "./types.ts";
import { installAgentUi, type AgentUiController } from "./ui/controller.ts";

export interface SubagentsExtensionDependencies {
  createModelRuntime(): Promise<ModelRuntime>;
  createSessionFactory(agentDir: string, runtime: ModelRuntime): SessionFactory;
}

const productionDependencies: SubagentsExtensionDependencies = {
  createModelRuntime: () => ModelRuntime.create({ allowModelNetwork: false }),
  createSessionFactory: (agentDir, runtime) => new SessionFactory(agentDir, runtime),
};

interface SessionRuntime {
  manager: AgentManager;
  modelRuntime: ModelRuntime;
  sessionFactory: SessionFactory;
  ui: AgentUiController;
}

export function createSubagentsExtension(
  dependencies: SubagentsExtensionDependencies = productionDependencies,
): (pi: ExtensionAPI) => void {
  return function piSubagents(pi: ExtensionAPI): void {
    let current: SessionRuntime | undefined;

    const rebuildBranch = async (
      ctx: ExtensionContext,
      sessionFactory: SessionFactory,
    ): Promise<AgentManager> => {
      const registry = AgentRegistry.fromEntries(
        ctx.sessionManager.getBranch(),
        (event) => pi.appendEntry(CUSTOM_ENTRY_TYPE, event),
      );
      const manager = new AgentManager({ factory: sessionFactory, registry });
      manager.recoverStale();
      return manager;
    };

    registerSubagentTools(pi, () => {
      if (!current) throw new Error("Subagent runtime is not initialized");
      return current.manager;
    });
    pi.registerCommand("agents", {
      description: "Open the subagent viewer",
      handler: async (_args, ctx) => current?.ui.open(ctx),
    });
    pi.registerShortcut(Key.alt("a"), {
      description: "Open the subagent viewer",
      handler: async (ctx) => current?.ui.open(ctx),
    });

    const disposeRuntime = async (runtime: SessionRuntime): Promise<void> => {
      try {
        await runtime.manager.shutdown();
      } finally {
        runtime.ui.dispose();
        if (current === runtime) current = undefined;
      }
    };

    const installRuntime = async (
      ctx: ExtensionContext,
      modelRuntime: ModelRuntime,
      sessionFactory: SessionFactory,
    ): Promise<SessionRuntime> => {
      const manager = await rebuildBranch(ctx, sessionFactory);
      try {
        return {
          manager,
          modelRuntime,
          sessionFactory,
          ui: installAgentUi(ctx, manager),
        };
      } catch (error) {
        await manager.shutdown();
        throw error;
      }
    };

    pi.on("session_start", async (_event, ctx) => {
      if (current) await disposeRuntime(current);
      const modelRuntime = await dependencies.createModelRuntime();
      const sessionFactory = dependencies.createSessionFactory(getAgentDir(), modelRuntime);
      current = await installRuntime(ctx, modelRuntime, sessionFactory);
    });

    const guardNavigation = (ctx: ExtensionContext): { cancel: true } | undefined => {
      if (!current?.manager.hasActive()) return undefined;
      if (ctx.hasUI) {
        ctx.ui.notify("Wait for or abort active subagents before branching", "warning");
      }
      return { cancel: true };
    };

    pi.on("session_before_tree", (_event, ctx) => guardNavigation(ctx));
    pi.on("session_before_fork", (_event, ctx) => guardNavigation(ctx));

    pi.on("session_tree", async (_event, ctx) => {
      if (!current) return;
      const previous = current;
      await disposeRuntime(previous);
      current = await installRuntime(ctx, previous.modelRuntime, previous.sessionFactory);
    });

    pi.on("session_shutdown", async () => {
      const closing = current;
      if (closing) await disposeRuntime(closing);
    });
  };
}

export default createSubagentsExtension();
