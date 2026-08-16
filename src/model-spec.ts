import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ResolvedModelSpec } from "./types.ts";

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export interface ExactModelResolution extends ResolvedModelSpec {
  model: Model<Api>;
}

export async function resolveExactModelSpec(spec: string, runtime: ModelRuntime): Promise<ExactModelResolution> {
  if (!spec.includes("/")) throw new Error(`Use canonical provider/model syntax: ${spec}`);

  const available = await runtime.getAvailable();
  const exact = (reference: string): Model<Api> | undefined =>
    available.find((model) => `${model.provider}/${model.id}` === reference);

  const complete = exact(spec);
  if (complete) {
    return { provider: complete.provider, modelId: complete.id, canonical: spec, model: complete };
  }

  const colon = spec.lastIndexOf(":");
  if (colon > spec.indexOf("/")) {
    const suffix = spec.slice(colon + 1) as ThinkingLevel;
    if (THINKING_LEVELS.has(suffix)) {
      const reference = spec.slice(0, colon);
      const model = exact(reference);
      if (model) {
        return {
          provider: model.provider,
          modelId: model.id,
          thinkingLevel: suffix,
          canonical: `${reference}:${suffix}`,
          model,
        };
      }
    }
  }

  throw new Error(`Model is unavailable or unauthenticated: ${spec}`);
}
