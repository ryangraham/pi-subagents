import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ChildSessionBundle } from "./session-factory.ts";
import { addUsage, classifyFinalResponse, extractFinalAssistantText, ZERO_USAGE } from "./result.ts";
import { TranscriptStore } from "./transcript.ts";
import type { AgentOutcome, RunTerminalState } from "./types.ts";

export interface LaunchChildRunInput {
  agentId: string;
  runId: string;
  prompt: string;
  bundle: ChildSessionBundle;
  startedAt: number;
  now?: () => number;
}

type AbortTerminalState = "aborted" | "interrupted";

function describeError(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "Unknown child failure";
  }
}

export class ChildRun {
  readonly completion: Promise<AgentOutcome>;
  readonly transcript: TranscriptStore;

  readonly #agentId: string;
  readonly #runId: string;
  readonly #startedAt: number;
  readonly #bundle: ChildSessionBundle;
  readonly #now: () => number;
  #usage: Usage = structuredClone(ZERO_USAGE);
  #finalAssistant: AssistantMessage | undefined;
  #requestedTerminalState: AbortTerminalState | undefined;
  #abortPromise: Promise<void> | undefined;
  #unsubscribe: (() => void) | undefined;
  #settled = false;
  #disposed = false;
  #initialSessionFile: string | undefined;

  static launch(input: LaunchChildRunInput): ChildRun {
    return new ChildRun(input);
  }

  private constructor(input: LaunchChildRunInput) {
    this.#agentId = input.agentId;
    this.#runId = input.runId;
    this.#startedAt = input.startedAt;
    this.#bundle = input.bundle;
    this.#now = input.now ?? Date.now;
    this.#initialSessionFile = this.#readSessionFile();

    const sessionManager = input.bundle.session.sessionManager;
    this.transcript = new TranscriptStore({
      initialRecords: TranscriptStore.replay(
        sessionManager.getEntries(),
        sessionManager.getLeafId(),
      ),
    });
    this.transcript.appendUserPrompt(input.prompt, input.startedAt);
    this.#unsubscribe = input.bundle.session.subscribe((event) => this.#onEvent(event));

    // Invoking this async method synchronously installs the prompt rejection handler
    // before launch() can return a background run to its caller.
    this.completion = this.#complete(input.prompt);
  }

  wait(signal: AbortSignal | undefined, abortOnCancel: boolean): Promise<AgentOutcome> {
    if (!signal) return this.completion;
    if (signal.aborted) return this.#cancelWait(abortOnCancel);

    return new Promise<AgentOutcome>((resolve, reject) => {
      let finished = false;
      const cleanup = (): void => signal.removeEventListener("abort", onAbort);
      const onAbort = (): void => {
        if (finished) return;
        finished = true;
        cleanup();
        if (!abortOnCancel) {
          reject(new Error("Waiting cancelled"));
          return;
        }
        void this.abort("aborted")
          .then(() => this.completion)
          .then(resolve, reject);
      };

      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      void this.completion.then((outcome) => {
        if (finished) return;
        finished = true;
        cleanup();
        resolve(outcome);
      });
    });
  }

  abort(terminalState: AbortTerminalState = "aborted"): Promise<void> {
    if (this.#settled || this.#disposed) return Promise.resolve();
    this.#requestedTerminalState ??= terminalState;
    if (!this.#abortPromise) {
      try {
        this.#abortPromise = Promise.resolve(this.#bundle.session.abort());
      } catch (error) {
        this.#abortPromise = Promise.reject(error);
      }
    }
    return this.#abortPromise;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    try {
      this.#unsubscribe?.();
    } catch {
      // Disposal must be best effort and idempotent.
    }
    this.#unsubscribe = undefined;
    this.transcript.dispose();
    try {
      this.#bundle.session.dispose();
    } catch {
      // A disposal failure must not reject the nonrejecting completion promise.
    }
  }

  async #cancelWait(abortOnCancel: boolean): Promise<AgentOutcome> {
    if (!abortOnCancel) throw new Error("Waiting cancelled");
    await this.abort("aborted");
    return this.completion;
  }

  async #complete(prompt: string): Promise<AgentOutcome> {
    try {
      let promptError: unknown;
      try {
        await this.#bundle.session.prompt(prompt);
      } catch (error) {
        promptError = error;
      }
      const outcome = this.#buildOutcome(promptError);
      this.#settled = true;
      return outcome;
    } catch (error) {
      this.#settled = true;
      return this.#emergencyOutcome(error);
    } finally {
      this.dispose();
    }
  }

  #onEvent(event: AgentSessionEvent): void {
    this.transcript.apply(event);
    if (event.type === "message_end") {
      if (event.message.role === "assistant") {
        this.#finalAssistant = event.message;
        this.#usage = addUsage(this.#usage, event.message.usage);
      } else if (event.message.role === "toolResult" && event.message.usage) {
        this.#usage = addUsage(this.#usage, event.message.usage);
      }
    } else if (event.type === "compaction_end" && event.result?.usage) {
      this.#usage = addUsage(this.#usage, event.result.usage);
    }
  }

  #buildOutcome(promptError: unknown): AgentOutcome {
    const finalText = this.#currentRunFinalText();
    let state: RunTerminalState;
    let error: string | undefined;

    if (this.#requestedTerminalState) {
      state = this.#requestedTerminalState;
      error = this.#finalAssistant?.errorMessage;
    } else if (promptError !== undefined) {
      state = "failed";
      error = describeError(promptError);
    } else if (
      this.#finalAssistant?.stopReason === "error" ||
      this.#finalAssistant?.stopReason === "aborted"
    ) {
      state = "failed";
      error = this.#finalAssistant.errorMessage ?? `Child stopped: ${this.#finalAssistant.stopReason}`;
    } else {
      state = classifyFinalResponse(finalText);
    }

    const sessionFile = this.#readSessionFile() ?? this.#initialSessionFile;
    return {
      agentId: this.#agentId,
      runId: this.#runId,
      state,
      finalText,
      ...(error === undefined ? {} : { error }),
      ...(sessionFile === undefined ? {} : { sessionFile }),
      childLeafId: this.#readLeaf(),
      usage: structuredClone(this.#usage),
      startedAt: this.#startedAt,
      settledAt: this.#readNow(),
      manifest: structuredClone(this.#bundle.manifest),
    };
  }

  #emergencyOutcome(error: unknown): AgentOutcome {
    const sessionFile = this.#readSessionFile() ?? this.#initialSessionFile;
    return {
      agentId: this.#agentId,
      runId: this.#runId,
      state: this.#requestedTerminalState ?? "failed",
      finalText: "",
      error: describeError(error),
      ...(sessionFile === undefined ? {} : { sessionFile }),
      childLeafId: this.#readLeaf(),
      usage: this.#usage,
      startedAt: this.#startedAt,
      settledAt: this.#readNow(),
      manifest: this.#bundle.manifest,
    };
  }

  #currentRunFinalText(): string {
    if (!this.#finalAssistant) return "";
    try {
      return this.#bundle.session.getLastAssistantText() ?? extractFinalAssistantText([this.#finalAssistant]);
    } catch {
      return extractFinalAssistantText([this.#finalAssistant]);
    }
  }

  #readSessionFile(): string | undefined {
    try {
      return this.#bundle.session.sessionFile;
    } catch {
      return undefined;
    }
  }

  #readLeaf(): string | null {
    try {
      return this.#bundle.session.sessionManager.getLeafId();
    } catch {
      return null;
    }
  }

  #readNow(): number {
    try {
      return this.#now();
    } catch {
      return Date.now();
    }
  }
}
