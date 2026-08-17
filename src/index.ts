import {
  getAgentDir,
  ModelRuntime,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { AgentManager } from "./agent-manager.ts";
import { AgentRegistry } from "./registry.ts";
import { SessionFactory } from "./session-factory.ts";
import { registerSubagentTools } from "./tools.ts";
import { CUSTOM_ENTRY_TYPE } from "./types.ts";

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

    pi.on("session_start", async (_event, ctx) => {
      if (current) await current.manager.shutdown();
      const modelRuntime = await dependencies.createModelRuntime();
      const sessionFactory = dependencies.createSessionFactory(getAgentDir(), modelRuntime);
      const manager = await rebuildBranch(ctx, sessionFactory);
      current = { manager, modelRuntime, sessionFactory };
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
      await current.manager.shutdown();
      current.manager = await rebuildBranch(ctx, current.sessionFactory);
    });

    pi.on("session_shutdown", async () => {
      const closing = current;
      try {
        await closing?.manager.shutdown();
      } finally {
        if (current === closing) current = undefined;
      }
    });
  };
}

export default createSubagentsExtension();
