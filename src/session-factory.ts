import { join } from "node:path";
import {
  AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { resolveTrustedCwd } from "./cwd.ts";
import { resolveExactModelSpec, type ExactModelResolution } from "./model-spec.ts";
import { hashPrompt } from "./result.ts";
import type { AgentRecord, ContextManifest, DispatchRequest, ResolvedModelSpec } from "./types.ts";

export interface ChildSessionBundle {
  session: AgentSession;
  manifest: ContextManifest;
  resolvedModel: ResolvedModelSpec;
}

export interface FreshSessionInput {
  parentSessionId: string;
  parentCwd: string;
  request: DispatchRequest;
  projectTrusted: boolean;
}

export interface ReopenSessionInput {
  parentCwd: string;
  record: AgentRecord;
  prompt: string;
  projectTrusted: boolean;
}

interface CreateBundleInput {
  cwd: string;
  description: string;
  prompt: string;
  resolved: ExactModelResolution;
  intendedThinking: ContextManifest["thinkingLevel"] | undefined;
  sessionManager: SessionManager;
}

export class SessionFactory {
  constructor(
    private readonly agentDir: string,
    private readonly modelRuntime: ModelRuntime,
  ) {}

  async createFresh(input: FreshSessionInput): Promise<ChildSessionBundle> {
    this.requireTrusted(input.projectTrusted);
    const cwd = await resolveTrustedCwd(input.parentCwd, input.request.cwd);
    const resolved = await resolveExactModelSpec(input.request.model, this.modelRuntime);
    const sessionManager = SessionManager.create(cwd, join(this.agentDir, "subagents", input.parentSessionId));

    return this.createBundle({
      cwd,
      description: input.request.description,
      prompt: input.request.prompt,
      resolved,
      intendedThinking: resolved.thinkingLevel,
      sessionManager,
    });
  }

  async reopen(input: ReopenSessionInput): Promise<ChildSessionBundle> {
    this.requireTrusted(input.projectTrusted);
    if (!input.record.sessionFile || !input.record.childLeafId || !input.record.manifest) {
      throw new Error("Cannot resume subagent without a persisted session, child leaf, and context manifest");
    }

    const cwd = await resolveTrustedCwd(input.parentCwd, input.record.cwd);
    const resolved = await resolveExactModelSpec(input.record.model, this.modelRuntime);
    const sessionManager = SessionManager.open(input.record.sessionFile);
    sessionManager.branch(input.record.childLeafId);

    return this.createBundle({
      cwd,
      description: input.record.description,
      prompt: input.prompt,
      resolved,
      intendedThinking: input.record.manifest.thinkingLevel,
      sessionManager,
    });
  }

  private requireTrusted(projectTrusted: boolean): void {
    if (!projectTrusted) throw new Error("Subagent dispatch requires a trusted project");
  }

  private async createBundle(input: CreateBundleInput): Promise<ChildSessionBundle> {
    const settingsManager = SettingsManager.create(input.cwd, this.agentDir, { projectTrusted: true });
    const loader = new DefaultResourceLoader({
      cwd: input.cwd,
      agentDir: this.agentDir,
      settingsManager,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      systemPromptOverride: () => undefined,
      appendSystemPromptOverride: () => [],
    });
    await loader.reload();

    const { session, modelFallbackMessage } = await createAgentSession({
      cwd: input.cwd,
      agentDir: this.agentDir,
      modelRuntime: this.modelRuntime,
      model: input.resolved.model,
      ...(input.intendedThinking === undefined ? {} : { thinkingLevel: input.intendedThinking }),
      resourceLoader: loader,
      sessionManager: input.sessionManager,
      settingsManager,
    });

    try {
      if (modelFallbackMessage) throw new Error(`Model fallback is forbidden: ${modelFallbackMessage}`);
      const intendedThinking = input.intendedThinking ?? session.thinkingLevel;
      if (session.thinkingLevel !== intendedThinking) {
        throw new Error(
          `Thinking level ${intendedThinking} is unsupported by ${input.resolved.provider}/${input.resolved.modelId}`,
        );
      }

      session.setSessionName(input.description);
      const manifest: ContextManifest = {
        cwd: input.cwd,
        model: input.resolved.canonical,
        thinkingLevel: session.thinkingLevel,
        tools: session.getActiveToolNames(),
        contextFiles: loader.getAgentsFiles().agentsFiles.map((file) => file.path),
        skills: loader.getSkills().skills.map((skill) => ({ name: skill.name, path: skill.filePath })),
        parentHistoryIncluded: false,
        extensionsDisabled: true,
        promptTemplatesDisabled: true,
        themesDisabled: true,
        customSystemPromptsDisabled: true,
        agentDefinitionsDisabled: true,
        dispatchBytes: Buffer.byteLength(input.prompt, "utf8"),
        dispatchSha256: hashPrompt(input.prompt),
      };
      const { model: _model, ...resolvedModel } = input.resolved;
      return { session, manifest, resolvedModel };
    } catch (error) {
      session.dispose();
      throw error;
    }
  }
}
