import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveExactModelSpec } from "../src/model-spec.ts";

let runtime: ModelRuntime;

beforeAll(async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("fake", async () => ({ type: "api_key", key: "fake-key" }));
  await credentials.modify("openrouter", async () => ({ type: "api_key", key: "openrouter-key" }));
  runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    allowModelNetwork: false,
  });

  runtime.registerProvider("fake", {
    api: "openai-completions",
    baseUrl: "https://fake.invalid/v1",
    models: [
      {
        id: "worker",
        name: "Worker",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
    ],
  });
  runtime.registerProvider("other", {
    api: "openai-completions",
    baseUrl: "https://other.invalid/v1",
    models: [
      {
        id: "worker",
        name: "Unauthenticated Worker",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
    ],
  });
  runtime.registerProvider("openrouter", {
    api: "openai-completions",
    baseUrl: "https://openrouter.invalid/v1",
    models: [
      {
        id: "vendor/model:exact",
        name: "Colon Model",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
    ],
  });

});

describe("resolveExactModelSpec", () => {
  it("requires canonical provider/model syntax", async () => {
    await expect(resolveExactModelSpec("worker", runtime)).rejects.toThrow("Use canonical provider/model syntax");
  });

  it("accepts an exact canonical model with thinking", async () => {
    await expect(resolveExactModelSpec("fake/worker:high", runtime)).resolves.toMatchObject({
      provider: "fake",
      modelId: "worker",
      thinkingLevel: "high",
      canonical: "fake/worker:high",
    });
  });

  it("accepts an exact canonical model without thinking", async () => {
    await expect(resolveExactModelSpec("fake/worker", runtime)).resolves.toMatchObject({
      provider: "fake",
      modelId: "worker",
      canonical: "fake/worker",
    });
  });

  it("matches a model id containing a colon before treating the suffix as thinking", async () => {
    await expect(resolveExactModelSpec("openrouter/vendor/model:exact", runtime)).resolves.toMatchObject({
      provider: "openrouter",
      modelId: "vendor/model:exact",
      canonical: "openrouter/vendor/model:exact",
    });
  });

  it("keeps a colon-bearing model id when a thinking suffix follows it", async () => {
    await expect(resolveExactModelSpec("openrouter/vendor/model:exact:xhigh", runtime)).resolves.toMatchObject({
      provider: "openrouter",
      modelId: "vendor/model:exact",
      thinkingLevel: "xhigh",
      canonical: "openrouter/vendor/model:exact:xhigh",
    });
  });

  it("rejects unavailable authentication without fallback", async () => {
    await expect(resolveExactModelSpec("other/worker", runtime)).rejects.toThrow(
      "Model is unavailable or unauthenticated: other/worker",
    );
  });

  it("rejects fuzzy, aliased, and unsupported thinking references", async () => {
    await expect(resolveExactModelSpec("fake/work", runtime)).rejects.toThrow(
      "Model is unavailable or unauthenticated: fake/work",
    );
    await expect(resolveExactModelSpec("fake/worker:ultra", runtime)).rejects.toThrow(
      "Model is unavailable or unauthenticated: fake/worker:ultra",
    );
    await expect(resolveExactModelSpec(" fake/worker", runtime)).rejects.toThrow(
      "Model is unavailable or unauthenticated:  fake/worker",
    );
  });
});
