import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type Usage,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface FakeResponse {
  text: string;
  delayMs?: number;
  usage?: Partial<Usage>;
}

export interface FakeProviderHarness {
  runtime: ModelRuntime;
  model: Model<Api>;
  contexts: Context[];
}

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function completeUsage(partial: Partial<Usage> | undefined): Usage {
  return {
    ...ZERO_USAGE,
    ...partial,
    cost: { ...ZERO_USAGE.cost, ...partial?.cost },
  };
}

function captureContext(context: Context): Context {
  const tools = context.tools?.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: structuredClone(tool.parameters),
    ...(tool.constrainedSampling === undefined
      ? {}
      : { constrainedSampling: structuredClone(tool.constrainedSampling) }),
  }));
  return {
    messages: structuredClone(context.messages),
    ...(context.systemPrompt === undefined ? {} : { systemPrompt: context.systemPrompt }),
    ...(tools === undefined ? {} : { tools }),
  };
}

function assistant(text: string, usage: Usage): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "fake",
    model: "worker",
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

export async function createFakeProvider(responses: FakeResponse[]): Promise<FakeProviderHarness> {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("fake", async () => ({ type: "api_key", key: "test-key" }));
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    allowModelNetwork: false,
  });
  const contexts: Context[] = [];
  const queue = [...responses];

  runtime.registerProvider("fake", {
    api: "openai-completions",
    baseUrl: "https://fake.invalid/v1",
    models: [
      {
        id: "worker",
        name: "Fake Worker",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
    ],
    streamSimple: (_model, context) => {
      const response = queue.shift();
      if (!response) throw new Error("Fake provider response queue exhausted");
      contexts.push(captureContext(context));

      const stream = createAssistantMessageEventStream();
      const emit = (): void => {
        const usage = completeUsage(response.usage);
        const empty = assistant("", ZERO_USAGE);
        const message = assistant(response.text, usage);
        stream.push({ type: "start", partial: { ...empty, content: [] } });
        stream.push({ type: "text_start", contentIndex: 0, partial: empty });
        stream.push({ type: "text_delta", contentIndex: 0, delta: response.text, partial: message });
        stream.push({ type: "text_end", contentIndex: 0, content: response.text, partial: message });
        stream.push({ type: "done", reason: "stop", message });
      };

      if ((response.delayMs ?? 0) > 0) setTimeout(emit, response.delayMs);
      else emit();
      return stream;
    },
  });

  const model = runtime.getModel("fake", "worker");
  if (!model) throw new Error("Fake provider model was not registered");

  return { runtime, model, contexts };
}
