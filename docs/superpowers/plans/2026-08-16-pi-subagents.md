# Pi Subagents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an SDK-only Pi extension that gives the stock Superpowers SDD workflow isolated, resumable subagents with a persistent roster and switchable live TUI transcripts.

**Architecture:** The extension creates independent in-process Pi `AgentSession` objects using a child-specific `SessionManager`, filtered `DefaultResourceLoader`, and shared child `ModelRuntime`. Pure domain, registry, transcript, and child-run units feed an `AgentManager`; model-facing tools and TUI components are adapters around that manager.

**Tech Stack:** TypeScript 5.9, Node.js 22.19+, Pi SDK 0.83+, TypeBox, Pi TUI, Vitest 4, GitHub Actions.

## Global Constraints

- Use Pi's in-process SDK exclusively; do not add subprocess execution, RPC, a backend abstraction, or a transport interface.
- Work with the upstream `subagent-driven-development` skill unchanged; do not bundle, copy, override, or fork Superpowers.
- Fresh children receive no controller messages, compaction summaries, tool results, attachments, expanded skill bodies, copied system prompt, or automatic parent summary.
- Child resources are Pi's normal coding prompt, discovered `AGENTS.md` and `CLAUDE.md`, discovered skills, and built-in `read`, `bash`, `edit`, and `write` tools.
- Configure every child `DefaultResourceLoader` with `noExtensions: true`, `noPromptTemplates: true`, `noThemes: true`, `systemPromptOverride: () => undefined`, and `appendSystemPromptOverride: () => []`.
- Require canonical `provider/model` on every fresh dispatch, optionally followed by a valid Pi thinking suffix; reject bare IDs, fuzzy names, aliases, unavailable auth, and silent fallback.
- Resume with the original model, thinking level, cwd, resources, agent ID, and recorded child leaf.
- Default the child cwd to the controller cwd; any override must remain inside the canonical trusted Git root, or inside the canonical controller cwd when not in Git.
- Child extensions, custom agent definitions, role profiles, inherited custom tools, direct child messaging, automatic worktrees, and project-wide cross-session history are out of scope.
- Store child sessions under `~/.pi/agent/subagents/<parent-session-id>/` and parent registry state in non-context custom entries of type `pi-subagents`.
- Permit at most four active children per controller session.
- Return only the terminal assistant message to controller context, with a UTF-8-safe 50 KiB cap; retain full Pi-persisted child data locally.
- Persist and atomically claim each run's nested usage exactly once through a `usage_claimed` registry event.
- Bound each live transcript cache to 2,000 normalized records and 2 MiB of rendered text; streaming updates replace prior records.
- Dispose settled `AgentSession` instances; read completed transcripts from JSONL and recreate a live session only for resume.
- Block parent tree navigation and forking while children are active; after allowed tree navigation, rebuild the roster from the new active parent branch.
- On shutdown, reject dispatches, abort active children, mark them interrupted, unsubscribe, dispose, and clear UI resources; never auto-restart stale work.
- TUI state is local-only: widget updates, viewer data, and notifications must never call `pi.sendMessage()` or otherwise enter controller model context.
- The compact widget shows at most five ordered rows and refreshes elapsed time once per second only while work is active.
- The full viewer is read-only in v1 and supports roster switching, scrolling, transcript/context/usage tabs, thinking toggle, abort, remove, and close.
- Package metadata uses MIT, Node.js `>=22.19.0`, a `pi.extensions` entry for `./src/index.ts`, and `"*"` peer ranges for Pi packages and TypeBox.
- Add no runtime dependency unless a task demonstrates that the standard library and Pi peer packages cannot provide the required behavior.
- Follow TDD for every behavior task: observe the focused test fail for the intended reason before writing production code.

## File and responsibility map

| File | Responsibility |
|---|---|
| `package.json` | Pi package manifest, peer/dev dependencies, scripts, Node floor |
| `tsconfig.json` | Strict no-emit TypeScript configuration |
| `src/types.ts` | Stable domain types, lifecycle states, registry events, results, transcript records |
| `src/result.ts` | Status classification, final-text extraction, usage arithmetic, UTF-8 truncation, result formatting |
| `src/registry.ts` | Fold/append versioned custom events for the active controller branch |
| `src/model-spec.ts` | Exact canonical model/thinking parsing and authenticated lookup |
| `src/cwd.ts` | Canonical trusted-root discovery and cwd containment |
| `src/session-factory.ts` | Create/reopen filtered persistent child `AgentSession` instances and manifests |
| `src/transcript.ts` | Normalize live SDK events, enforce bounds, and replay persisted child branches |
| `src/child-run.ts` | Supervise one prompt invocation, per-run usage aggregation, cancellation, transcript, and outcome |
| `src/agent-manager.ts` | Admission, identities, run/start/wait/resume/abort/remove, recovery, branching, shutdown |
| `src/tools.ts` | TypeBox schemas, six tool registrations, result details, Superpowers prompt guidance |
| `src/index.ts` | Extension wiring and Pi lifecycle hooks only |
| `src/ui/agent-widget.ts` | Five-row compact widget rendering and timer lifecycle |
| `src/ui/agent-viewer.ts` | Responsive roster/detail overlay and keyboard handling |
| `src/ui/controller.ts` | Install/remove widget, notifications, `/agents`, and `Alt+A` integration |
| `test/helpers/fake-provider.ts` | Deterministic Pi provider and captured request contexts |
| `test/helpers/fakes.ts` | Fake child sessions, clock, registry events, and identity-theme helpers |
| `test/**/*.test.ts` | Focused unit and deterministic SDK integration coverage |
| `README.md` | Installation, tools, SDD mapping, context/security model, UI, limitations |
| `.github/workflows/ci.yml` | Node 22/24 typecheck and tests |

---

### Task 1: Package foundation and result primitives

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `LICENSE`
- Create: `src/types.ts`
- Create: `src/result.ts`
- Create: `test/result.test.ts`
- Create: `package-lock.json` via `npm install`

**Interfaces:**
- Consumes: Pi's exported `Usage`, `AgentMessage`, and `ThinkingLevel` types.
- Produces: `AgentState`, `ContextManifest`, `DispatchRequest`, `AgentOutcome`, `TranscriptRecord`, `hashPrompt()`, `classifyFinalResponse()`, `extractFinalAssistantText()`, `addUsage()`, `truncateUtf8()`, and `formatOutcomeForModel()` used by every later task.

- [ ] **Step 1: Create the package and compiler configuration**

Create `package.json` with this exact metadata and scripts:

```json
{
  "name": "pi-subagents",
  "version": "0.1.0",
  "description": "Visible, resumable Pi subagents designed for Superpowers workflows",
  "type": "module",
  "private": true,
  "license": "MIT",
  "keywords": ["pi-package", "pi-extension", "subagents", "superpowers"],
  "repository": {
    "type": "git",
    "url": "git+https://github.com/ryangraham/pi-subagents.git"
  },
  "engines": {
    "node": ">=22.19.0"
  },
  "pi": {
    "extensions": ["./src/index.ts"]
  },
  "files": ["src", "README.md", "LICENSE"],
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "check": "npm run typecheck && npm test"
  },
  "peerDependencies": {
    "@earendil-works/pi-agent-core": "*",
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  },
  "devDependencies": {
    "@earendil-works/pi-agent-core": "^0.83.0",
    "@earendil-works/pi-ai": "^0.83.0",
    "@earendil-works/pi-coding-agent": "^0.83.0",
    "@earendil-works/pi-tui": "^0.83.0",
    "@types/node": "^24.12.4",
    "typebox": "^1.3.7",
    "typescript": "^5.9.3",
    "vitest": "^4.1.9"
  }
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Create `.gitignore`:

```gitignore
node_modules/
coverage/
.DS_Store
*.log
```

Create the standard MIT text in `LICENSE` with `Copyright (c) 2026 Ryan Graham`.

Run:

```bash
npm install
```

Expected: dependency installation succeeds and creates `package-lock.json`. Run typecheck after source and test files exist in Step 6.

- [ ] **Step 2: Define the stable domain contracts**

Create `src/types.ts` with these exported contracts. Use `Usage` directly so nested accounting matches Pi's tool-result shape.

```typescript
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";

export const CUSTOM_ENTRY_TYPE = "pi-subagents";
export const REGISTRY_VERSION = 1 as const;
export const MAX_ACTIVE_AGENTS = 4;
export const MAX_RESULT_BYTES = 50 * 1024;
export const MAX_TRANSCRIPT_RECORDS = 2_000;
export const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;

export type AgentState =
  | "starting"
  | "working"
  | "completed"
  | "needs_context"
  | "blocked"
  | "failed"
  | "aborted"
  | "interrupted"
  | "removed";

export type RunTerminalState = Exclude<AgentState, "starting" | "working" | "removed">;

export interface DispatchRequest {
  description: string;
  prompt: string;
  model: string;
  cwd?: string;
}

export interface ResolvedModelSpec {
  provider: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
  canonical: string;
}

export interface ContextManifest {
  cwd: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  tools: string[];
  contextFiles: string[];
  skills: Array<{ name: string; path: string }>;
  parentHistoryIncluded: false;
  extensionsDisabled: true;
  promptTemplatesDisabled: true;
  themesDisabled: true;
  customSystemPromptsDisabled: true;
  agentDefinitionsDisabled: true;
  dispatchBytes: number;
  dispatchSha256: string;
}

export interface AgentOutcome {
  agentId: string;
  runId: string;
  state: RunTerminalState;
  finalText: string;
  error?: string;
  sessionFile?: string;
  childLeafId: string | null;
  usage: Usage;
  startedAt: number;
  settledAt: number;
  manifest?: ContextManifest;
}

export type TranscriptRecordKind =
  | "user"
  | "text"
  | "thinking"
  | "tool"
  | "retry"
  | "compaction"
  | "error"
  | "status";

export interface TranscriptRecord {
  id: string;
  kind: TranscriptRecordKind;
  timestamp: number;
  text: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  streaming?: boolean;
}
```

Do not define registry events yet; Task 2 adds them after their fold behavior is tested.

- [ ] **Step 3: Write failing result-primitive tests**

Create `test/result.test.ts`:

```typescript
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  classifyFinalResponse,
  extractFinalAssistantText,
  addUsage,
  formatOutcomeForModel,
  hashPrompt,
  truncateUtf8,
} from "../src/result.ts";

const usage = (input: number, output: number): Usage => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + output,
  cost: { input: input / 1000, output: output / 1000, cacheRead: 0, cacheWrite: 0, total: (input + output) / 1000 },
});

describe("hashPrompt", () => {
  it("returns a stable SHA-256 digest", () => {
    expect(hashPrompt("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("classifyFinalResponse", () => {
  it.each([
    ["**Status:** DONE", "completed"],
    ["- Status: DONE_WITH_CONCERNS", "completed"],
    ["Status: NEEDS_CONTEXT", "needs_context"],
    ["status: needs_context", "needs_context"],
    ["Status: BLOCKED", "blocked"],
  ] as const)("maps %s", (text, expected) => {
    expect(classifyFinalResponse(text)).toBe(expected);
  });

  it("defaults a normal answer to completed", () => {
    expect(classifyFinalResponse("### Spec Compliance\nReview says BLOCKED is not present\n✅ Approved")).toBe("completed");
  });
});

describe("extractFinalAssistantText", () => {
  it("concatenates text blocks from the terminal assistant message", () => {
    const assistant = (content: Array<{ type: "text"; text: string } | { type: "thinking"; thinking: string }>): AgentMessage => ({
      role: "assistant",
      content,
      api: "anthropic-messages",
      provider: "fake",
      model: "worker",
      usage: usage(1, 1),
      stopReason: "stop",
      timestamp: 1,
    });
    const messages: AgentMessage[] = [
      assistant([{ type: "text", text: "old" }]),
      { role: "user", content: "next", timestamp: 2 },
      assistant([{ type: "thinking", thinking: "hidden" }, { type: "text", text: "one" }, { type: "text", text: "two" }]),
    ];
    expect(extractFinalAssistantText(messages)).toBe("one\ntwo");
  });
});

describe("addUsage", () => {
  it("adds token and cost fields for one run", () => {
    expect(addUsage(usage(10, 3), usage(5, 5))).toEqual(usage(15, 8));
  });
});

describe("truncateUtf8", () => {
  it("never splits a multibyte code point", () => {
    expect(truncateUtf8("ab🙂cd", 5)).toEqual({ text: "ab", truncated: true, omittedBytes: 6 });
  });
});

describe("formatOutcomeForModel", () => {
  it("adds identity and status without returning transcript history", () => {
    expect(formatOutcomeForModel("sa_ab12cd34", "completed", "Status: DONE", "/tmp/child.jsonl")).toBe(
      "agent_id: sa_ab12cd34\nstatus: completed\n\nStatus: DONE",
    );
  });

  it("adds the local session reference only when truncation occurs", () => {
    const oversized = formatOutcomeForModel("sa_ab12cd34", "completed", "x".repeat(MAX_RESULT_BYTES + 1), "/tmp/child.jsonl");
    expect(oversized).toContain("[Output truncated: 1 bytes omitted. Full output: /tmp/child.jsonl]");
    expect(formatOutcomeForModel("sa_ab12cd34", "completed", "short", "/tmp/child.jsonl")).not.toContain("/tmp/child.jsonl");
    expect(formatOutcomeForModel("sa_ab12cd34", "failed", "x".repeat(MAX_RESULT_BYTES + 1))).toContain(
      "[Output truncated: 1 bytes omitted.]",
    );
  });
});
```

Import `MAX_RESULT_BYTES` from `src/types.ts` in this test file.

- [ ] **Step 4: Run the focused test and observe RED**

Run:

```bash
npm test -- test/result.test.ts
```

Expected: FAIL because `src/result.ts` does not exist.

- [ ] **Step 5: Implement the minimal result primitives**

Create `src/result.ts`. The status parser must only inspect a line labeled `Status`, not arbitrary mentions of `BLOCKED` in review prose.

```typescript
import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { AgentState, RunTerminalState } from "./types.ts";
import { MAX_RESULT_BYTES } from "./types.ts";

const STATUS_LINE = /^\s*(?:[-*]\s*)?(?:\*\*)?status(?:\*\*)?\s*:\s*(?:\*\*)?(DONE_WITH_CONCERNS|DONE|NEEDS_CONTEXT|BLOCKED)(?:\*\*)?\s*$/im;

export function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

export function classifyFinalResponse(text: string): Extract<AgentState, "completed" | "needs_context" | "blocked"> {
  const value = STATUS_LINE.exec(text)?.[1]?.toUpperCase();
  if (value === "NEEDS_CONTEXT") return "needs_context";
  if (value === "BLOCKED") return "blocked";
  return "completed";
}

export function extractFinalAssistantText(messages: readonly AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    return message.content
      .filter((block): block is Extract<(typeof message.content)[number], { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

export const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function addUsage(left: Usage, right: Usage): Usage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    totalTokens: left.totalTokens + right.totalTokens,
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    },
  };
}

export interface TruncatedText {
  text: string;
  truncated: boolean;
  omittedBytes: number;
}

export function truncateUtf8(text: string, maxBytes = MAX_RESULT_BYTES): TruncatedText {
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= maxBytes) return { text, truncated: false, omittedBytes: 0 };
  const chunks: string[] = [];
  let keptBytes = 0;
  for (const codePoint of text) {
    const size = Buffer.byteLength(codePoint, "utf8");
    if (keptBytes + size > maxBytes) break;
    chunks.push(codePoint);
    keptBytes += size;
  }
  return { text: chunks.join(""), truncated: true, omittedBytes: totalBytes - keptBytes };
}

export function formatOutcomeForModel(agentId: string, state: RunTerminalState, finalText: string, sessionFile?: string): string {
  const result = truncateUtf8(finalText);
  const location = sessionFile ? ` Full output: ${sessionFile}` : "";
  const notice = result.truncated
    ? `\n\n[Output truncated: ${result.omittedBytes} bytes omitted.${location}]`
    : "";
  return `agent_id: ${agentId}\nstatus: ${state}\n\n${result.text}${notice}`;
}
```

- [ ] **Step 6: Run focused and full checks**

Run:

```bash
npm test -- test/result.test.ts
npm run check
```

Expected: all result tests pass; typecheck and full test suite exit 0.

- [ ] **Step 7: Commit the foundation**

```bash
git add package.json package-lock.json tsconfig.json .gitignore LICENSE src/types.ts src/result.ts test/result.test.ts
git commit -m "chore: scaffold pi subagents package"
```

---

### Task 2: Durable branch-aware registry

**Files:**
- Modify: `src/types.ts`
- Create: `src/registry.ts`
- Create: `test/registry.test.ts`

**Interfaces:**
- Consumes: `AgentState`, `ContextManifest`, `Usage`, and Pi `SessionEntry`.
- Produces: `RegistryEvent`, `AgentRecord`, `AgentRegistry.fromEntries()`, `AgentRegistry.append()`, `AgentRegistry.claimUsage()`, `AgentRegistry.markStaleInterrupted()`, and `AgentRegistry.remove()`.

- [ ] **Step 1: Add exact registry contracts to `src/types.ts`**

Append these types:

```typescript
export interface AgentRunRecord {
  runId: string;
  index: number;
  promptSha256: string;
  startedAt: number;
  settledAt?: number;
  usage?: Usage;
  usageClaimed: boolean;
  childLeafId?: string | null;
}

export interface AgentRecord {
  id: string;
  description: string;
  cwd: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
  state: AgentState;
  sessionFile?: string;
  childLeafId?: string | null;
  manifest?: ContextManifest;
  error?: string;
  createdAt: number;
  updatedAt: number;
  runs: AgentRunRecord[];
}

interface RegistryEventBase {
  version: typeof REGISTRY_VERSION;
  agentId: string;
  at: number;
}

interface TerminalRegistryPayload {
  /** Present only when a fresh setup settles before its `started` event. */
  run?: AgentRunRecord;
  sessionFile?: string;
  childLeafId: string | null;
  manifest?: ContextManifest;
  error?: string;
  usage?: Usage;
}

export type RegistryEvent =
  | (RegistryEventBase & { kind: "created"; record: AgentRecord })
  | (RegistryEventBase & { kind: "started" | "resumed"; run: AgentRunRecord; state: "working"; sessionFile?: string; childLeafId: string | null; manifest?: ContextManifest })
  | (RegistryEventBase & TerminalRegistryPayload & { kind: "settled"; runId: string; state: "completed" | "needs_context" | "blocked" | "failed" })
  | (RegistryEventBase & TerminalRegistryPayload & { kind: "aborted"; runId: string; state: "aborted" })
  | (RegistryEventBase & TerminalRegistryPayload & { kind: "interrupted"; runId: string | null; state: "interrupted" })
  | (RegistryEventBase & { kind: "usage_claimed"; runId: string })
  | (RegistryEventBase & { kind: "removed" });
```

`started` and `resumed` carry session/leaf/manifest metadata so the context tab is useful while a child works. Terminal events deliberately contain no final assistant text: child JSONL is the only authoritative full transcript/result body (the parent tool result still persists its required capped terminal text), while lifecycle entries store identity, state, usage, branch pointer, error metadata, and manifest.

- [ ] **Step 2: Write failing fold and usage-claim tests**

Create `test/registry.test.ts` with a fixture that builds valid `created`, `started`, `settled`, and `usage_claimed` events. Assert all of these behaviors by name:

```typescript
it("folds only pi-subagents custom entries from the supplied active branch", () => {
  const registry = AgentRegistry.fromEntries([foreignEntry, createdEntry, startedEntry, settledEntry], append);
  expect(registry.list()).toHaveLength(1);
  expect(registry.get("sa_1234abcd")?.state).toBe("completed");
});

it("claims terminal usage once and persists usage_claimed", () => {
  const registry = AgentRegistry.fromEvents([created, started, settled], append);
  expect(registry.claimUsage("sa_1234abcd", "run_1")).toEqual(runUsage);
  expect(registry.claimUsage("sa_1234abcd", "run_1")).toBeUndefined();
  expect(append).toHaveBeenCalledWith(expect.objectContaining({ kind: "usage_claimed", runId: "run_1" }));
});

it("marks stale working agents interrupted during reconstruction", () => {
  const registry = AgentRegistry.fromEvents([created, started], append);
  registry.markStaleInterrupted(5000);
  expect(registry.get("sa_1234abcd")?.state).toBe("interrupted");
});

it("keeps another parent branch invisible when entries are not supplied", () => {
  const registry = AgentRegistry.fromEntries([createdEntry], append);
  expect(registry.get("sa_deadbeef")).toBeUndefined();
});
```

Use complete fixtures rather than casting partial objects. A `createdRecord()` helper in the test may fill every required field. In this same test file, add cases proving `settled` before `started` throws `Invalid registry transition`, `usage_claimed` for an unknown run throws, removed is final, active agents cannot be removed, terminal events persist manifest/leaf/session/error/usage without final text, a reconstructed persisted usage claim cannot be claimed again, a persistence callback failure rolls the in-memory fold back, and stale recovery interrupts a `starting` record with no run by persisting `runId: null`.

- [ ] **Step 3: Run registry tests and observe RED**

Run:

```bash
npm test -- test/registry.test.ts
```

Expected: FAIL because `src/registry.ts` does not exist.

- [ ] **Step 4: Implement pure event folding and append-through persistence**

Create `src/registry.ts` with this public shape:

```typescript
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentRecord, AgentRunRecord, RegistryEvent } from "./types.ts";
import { CUSTOM_ENTRY_TYPE, REGISTRY_VERSION } from "./types.ts";

export type AppendRegistryEvent = (event: RegistryEvent) => void;

function withoutError(record: AgentRecord): AgentRecord {
  const copy = structuredClone(record);
  delete copy.error;
  return copy;
}

export class AgentRegistry {
  private records = new Map<string, AgentRecord>();

  private constructor(
    events: readonly RegistryEvent[],
    private readonly persist: AppendRegistryEvent,
  ) {
    for (const event of events) this.apply(event);
  }

  static fromEntries(entries: readonly SessionEntry[], persist: AppendRegistryEvent): AgentRegistry {
    const events = entries.flatMap((entry) => {
      if (entry.type !== "custom" || entry.customType !== CUSTOM_ENTRY_TYPE) return [];
      const value = entry.data as RegistryEvent | undefined;
      return value?.version === REGISTRY_VERSION ? [value] : [];
    });
    return new AgentRegistry(events, persist);
  }

  static fromEvents(events: readonly RegistryEvent[], persist: AppendRegistryEvent): AgentRegistry {
    return new AgentRegistry(events, persist);
  }

  get(agentId: string): AgentRecord | undefined {
    const record = this.records.get(agentId);
    return record ? structuredClone(record) : undefined;
  }

  list(): AgentRecord[] {
    return [...this.records.values()]
      .filter((record) => record.state !== "removed")
      .map((record) => structuredClone(record));
  }

  append(event: RegistryEvent): void {
    const before = new Map(this.records);
    try {
      this.apply(event);
      this.persist(event);
    } catch (error) {
      this.records = before;
      throw error;
    }
  }

  claimUsage(agentId: string, runId: string, at = Date.now()): AgentRecord["runs"][number]["usage"] | undefined {
    const record = this.require(agentId);
    const run = record.runs.find((value) => value.runId === runId);
    if (!run?.usage || run.usageClaimed) return undefined;
    this.append({ version: REGISTRY_VERSION, kind: "usage_claimed", agentId, runId, at });
    return structuredClone(run.usage);
  }

  markStaleInterrupted(
    at: number,
    resolveLeaf: (record: AgentRecord) => string | null = (record) => record.childLeafId ?? null,
  ): void {
    for (const record of this.records.values()) {
      if (record.state !== "working" && record.state !== "starting") continue;
      const run = record.runs.at(-1);
      this.append({
        version: REGISTRY_VERSION,
        kind: "interrupted",
        state: "interrupted",
        agentId: record.id,
        runId: run?.runId ?? null,
        childLeafId: resolveLeaf(structuredClone(record)),
        error: "Controller stopped while child was active",
        at,
      });
    }
  }

  remove(agentId: string, at = Date.now()): void {
    const record = this.require(agentId);
    if (record.state === "starting" || record.state === "working") throw new Error(`Cannot remove active agent ${agentId}`);
    this.append({ version: REGISTRY_VERSION, kind: "removed", agentId, at });
  }

  private require(agentId: string): AgentRecord {
    const record = this.records.get(agentId);
    if (!record) throw new Error(`Unknown subagent: ${agentId}`);
    return record;
  }

  private apply(event: RegistryEvent): void {
    if (event.kind === "created") {
      if (this.records.has(event.agentId)) throw new Error(`Duplicate subagent: ${event.agentId}`);
      if (event.record.id !== event.agentId || event.record.state !== "starting" || event.record.runs.length !== 0) {
        throw new Error(`Invalid created event for ${event.agentId}`);
      }
      this.records.set(event.agentId, structuredClone(event.record));
      return;
    }

    const record = this.require(event.agentId);
    if (record.state === "removed") throw new Error(`Agent is removed: ${event.agentId}`);

    if (event.kind === "started" || event.kind === "resumed") {
      const allowed = event.kind === "started"
        ? record.state === "starting"
        : !["starting", "working"].includes(record.state);
      if (!allowed || record.runs.some((run) => run.runId === event.run.runId)) {
        throw new Error(`Invalid registry transition: ${record.state} -> ${event.kind}`);
      }
      this.records.set(event.agentId, {
        ...withoutError(record),
        state: "working",
        updatedAt: event.at,
        childLeafId: event.childLeafId,
        runs: [...record.runs, structuredClone(event.run)],
        ...(event.sessionFile ? { sessionFile: event.sessionFile } : {}),
        ...(event.manifest ? {
          manifest: structuredClone(event.manifest),
          cwd: event.manifest.cwd,
          model: event.manifest.model,
          thinkingLevel: event.manifest.thinkingLevel,
        } : {}),
      });
      return;
    }

    if (event.kind === "usage_claimed") {
      const runIndex = record.runs.findIndex((run) => run.runId === event.runId);
      const run = record.runs[runIndex];
      if (!run?.usage) throw new Error(`Unknown or unsettled run: ${event.runId}`);
      if (run.usageClaimed) return;
      const runs = record.runs.map((value, index) => index === runIndex ? { ...value, usageClaimed: true } : value);
      this.records.set(event.agentId, { ...record, updatedAt: event.at, runs });
      return;
    }

    if (event.kind === "removed") {
      if (record.state === "starting" || record.state === "working") {
        throw new Error(`Cannot remove active agent ${event.agentId}`);
      }
      this.records.set(event.agentId, { ...record, state: "removed", updatedAt: event.at });
      return;
    }

    if (record.state === "starting" && (event.kind !== "interrupted" || event.runId !== null)) {
      if (!event.run || event.run.runId !== event.runId || !["failed", "aborted", "interrupted"].includes(event.state)) {
        throw new Error(`Invalid registry transition: starting -> ${event.kind}`);
      }
      const run: AgentRunRecord = {
        ...structuredClone(event.run),
        settledAt: event.at,
        childLeafId: event.childLeafId,
        ...(event.usage ? { usage: structuredClone(event.usage) } : {}),
      };
      this.records.set(event.agentId, {
        ...withoutError(record),
        state: event.state,
        updatedAt: event.at,
        childLeafId: event.childLeafId,
        runs: [...record.runs, run],
        ...(event.sessionFile ? { sessionFile: event.sessionFile } : {}),
        ...(event.manifest ? {
          manifest: structuredClone(event.manifest),
          cwd: event.manifest.cwd,
          model: event.manifest.model,
          thinkingLevel: event.manifest.thinkingLevel,
        } : {}),
        ...(event.error ? { error: event.error } : {}),
      });
      return;
    }

    if (event.kind === "interrupted" && event.runId === null) {
      if (record.state !== "starting") throw new Error(`Invalid registry transition: ${record.state} -> interrupted`);
      this.records.set(event.agentId, {
        ...record,
        state: "interrupted",
        updatedAt: event.at,
        childLeafId: event.childLeafId,
        ...(event.error ? { error: event.error } : {}),
      });
      return;
    }
    if (record.state !== "working") {
      throw new Error(`Invalid registry transition: ${record.state} -> ${event.kind}`);
    }
    const runIndex = record.runs.findIndex((run) => run.runId === event.runId);
    if (runIndex < 0) throw new Error(`Unknown run: ${event.runId}`);
    const runs = record.runs.map((run, index) => index === runIndex
      ? {
          ...run,
          settledAt: event.at,
          childLeafId: event.childLeafId,
          ...(event.usage ? { usage: structuredClone(event.usage) } : {}),
        }
      : run);
    const next: AgentRecord = {
      ...withoutError(record),
      state: event.state,
      updatedAt: event.at,
      childLeafId: event.childLeafId,
      runs,
      ...(event.sessionFile ? { sessionFile: event.sessionFile } : {}),
      ...(event.manifest ? {
        manifest: structuredClone(event.manifest),
        cwd: event.manifest.cwd,
        model: event.manifest.model,
        thinkingLevel: event.manifest.thinkingLevel,
      } : {}),
    };
    if (event.error !== undefined) next.error = event.error;
    this.records.set(event.agentId, next);
  }
}
```

- [ ] **Step 5: Run the complete registry suite and verify GREEN**

```bash
npm test -- test/registry.test.ts
```

Expected: folding, branch filtering, transitions, removal, persistence, and exactly-once usage cases pass.

- [ ] **Step 6: Run registry and full checks**

```bash
npm test -- test/registry.test.ts
npm run check
```

Expected: registry tests and full checks pass.

- [ ] **Step 7: Commit the durable registry**

```bash
git add src/types.ts src/registry.ts test/registry.test.ts
git commit -m "feat: add durable subagent registry"
```

---

### Task 3: Exact model, trusted cwd, and filtered SDK session factory

**Files:**
- Create: `src/model-spec.ts`
- Create: `src/cwd.ts`
- Create: `src/session-factory.ts`
- Create: `test/model-spec.test.ts`
- Create: `test/cwd.test.ts`
- Create: `test/session-factory.test.ts`
- Create: `test/helpers/fake-provider.ts`

**Interfaces:**
- Consumes: `DispatchRequest`, `ResolvedModelSpec`, `ContextManifest`, `ModelRuntime`, `SessionManager`, `SettingsManager`, `DefaultResourceLoader`.
- Produces: `resolveExactModelSpec(spec, runtime)`, `resolveTrustedCwd(parentCwd, requestedCwd)`, `SessionFactory.createFresh()`, `SessionFactory.reopen()`, and `ChildSessionBundle`.

- [ ] **Step 1: Write exact-model parsing tests**

Create `test/model-spec.test.ts` around a fake runtime exposing models `fake/worker`, `other/worker`, and `openrouter/vendor/model:exact`:

```typescript
it("requires canonical provider/model", async () => {
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

it("matches a model id containing a colon before treating the suffix as thinking", async () => {
  await expect(resolveExactModelSpec("openrouter/vendor/model:exact", runtime)).resolves.toMatchObject({
    provider: "openrouter",
    modelId: "vendor/model:exact",
    canonical: "openrouter/vendor/model:exact",
  });
});

it("rejects unavailable auth without fallback", async () => {
  await expect(resolveExactModelSpec("other/worker", runtime)).rejects.toThrow("Model is unavailable or unauthenticated: other/worker");
});
```

- [ ] **Step 2: Run model tests and observe RED**

```bash
npm test -- test/model-spec.test.ts
```

Expected: FAIL because `src/model-spec.ts` does not exist.

- [ ] **Step 3: Implement exact model resolution**

Create `src/model-spec.ts`. Match the complete canonical string first so model IDs containing colons are preserved. Only then split a recognized thinking suffix from the last colon.

```typescript
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ResolvedModelSpec } from "./types.ts";

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export interface ExactModelResolution extends ResolvedModelSpec {
  model: Model<any>;
}

export async function resolveExactModelSpec(spec: string, runtime: ModelRuntime): Promise<ExactModelResolution> {
  if (!spec.includes("/")) throw new Error(`Use canonical provider/model syntax: ${spec}`);
  const available = await runtime.getAvailable();
  const exact = (reference: string) => available.find((model) => `${model.provider}/${model.id}` === reference);

  const complete = exact(spec);
  if (complete) return { provider: complete.provider, modelId: complete.id, canonical: spec, model: complete };

  const colon = spec.lastIndexOf(":");
  if (colon > spec.indexOf("/")) {
    const suffix = spec.slice(colon + 1) as ThinkingLevel;
    if (THINKING_LEVELS.has(suffix)) {
      const reference = spec.slice(0, colon);
      const model = exact(reference);
      if (model) return { provider: model.provider, modelId: model.id, thinkingLevel: suffix, canonical: `${reference}:${suffix}`, model };
    }
  }

  throw new Error(`Model is unavailable or unauthenticated: ${spec}`);
}
```

- [ ] **Step 4: Write cwd containment tests**

Create `test/cwd.test.ts` using temporary directories and a temporary Git repository. Cover:

```typescript
it("defaults to the canonical controller cwd", async () => {
  await expect(resolveTrustedCwd(projectDir)).resolves.toBe(await realpath(projectDir));
});

it("accepts a nested directory in the same git worktree", async () => {
  await expect(resolveTrustedCwd(projectDir, nestedDir)).resolves.toBe(await realpath(nestedDir));
});

it("rejects a sibling directory", async () => {
  await expect(resolveTrustedCwd(projectDir, siblingDir)).rejects.toThrow("outside trusted root");
});

it("rejects a symlink that escapes the trusted root", async () => {
  await expect(resolveTrustedCwd(projectDir, escapeLink)).rejects.toThrow("outside trusted root");
});

it("uses controller cwd as the boundary outside git", async () => {
  await expect(resolveTrustedCwd(nonGitDir, nestedNonGitDir)).resolves.toBe(await realpath(nestedNonGitDir));
});
```

Also cover a relative nested override, a sibling whose name merely shares the root prefix, a nonexistent path, and a regular file; the last three must reject.

- [ ] **Step 5: Run cwd tests and observe RED**

```bash
npm test -- test/cwd.test.ts
```

Expected: FAIL because `src/cwd.ts` does not exist.

- [ ] **Step 6: Implement canonical cwd validation**

Create `src/cwd.ts` using `node:fs/promises` `realpath()` and `stat()`, `node:path` `resolve()`, `relative()`, `isAbsolute()`, and `node:child_process` `execFile()` via `promisify()`. Export:

```typescript
export async function resolveTrustedCwd(parentCwd: string, requestedCwd?: string): Promise<string>;
```

Resolve relative overrides against `parentCwd`. Determine the trust root with `execFile("git", ["-C", canonicalParent, "rev-parse", "--show-toplevel"])`; on a nonzero Git result, use the canonical parent cwd. Reject when the candidate is not a directory or when `relative(root, candidate)` equals `..`, starts with `..${sep}`, or is absolute.

- [ ] **Step 7: Build a deterministic fake provider helper**

Create `test/helpers/fake-provider.ts` using `InMemoryCredentialStore`, `ModelRuntime`, and `createAssistantMessageEventStream()`. Export:

```typescript
export interface FakeResponse {
  text: string;
  delayMs?: number;
  usage?: Partial<Usage>;
}

export interface FakeProviderHarness {
  runtime: ModelRuntime;
  model: Model<any>;
  contexts: Context[];
}

export async function createFakeProvider(responses: FakeResponse[]): Promise<FakeProviderHarness>;
```

Register `fake/worker` through `runtime.registerProvider()` with `reasoning: false`, zero cost, a 128,000-token context window, and a `streamSimple` function. For each request, capture a deep copy of `Context`, then push `start`, `text_start`, `text_delta`, `text_end`, and `done` events carrying a complete assistant message. Await `runtime.setRuntimeApiKey("fake", "test-key")`. Fail when the response queue is exhausted so tests cannot pass with an accidental extra model call.

- [ ] **Step 8: Write the filtered-session factory test**

Create `test/session-factory.test.ts`. In a temp fixture:

- write project `AGENTS.md` containing `PROJECT_CHILD_RULE`;
- write project `CLAUDE.md` containing `CLAUDE_CHILD_RULE`;
- write project `SYSTEM.md` containing `FORBIDDEN_SYSTEM_OVERRIDE`;
- write a global skill at `join(agentDir, "skills", "example", "SKILL.md")` with frontmatter `name: example` and `description: Example child skill`;
- write a global extension that throws during load;
- write `join(agentDir, "agents", "forbidden.md")` containing `FORBIDDEN_AGENT_DEFINITION`;
- create a parent secret string but never pass it in the child dispatch;
- write an artifact containing `ARTIFACT_NOT_INLINED` and put only its path in the dispatch prompt.

Use these assertions in the test:

```typescript
expect(bundle.manifest.contextFiles).toEqual(expect.arrayContaining([
  expect.stringEndingWith("AGENTS.md"),
  expect.stringEndingWith("CLAUDE.md"),
]));
expect(bundle.manifest.skills.map((skill) => skill.name)).toContain("example");
expect(bundle.manifest).toMatchObject({
  parentHistoryIncluded: false,
  extensionsDisabled: true,
  promptTemplatesDisabled: true,
  themesDisabled: true,
  customSystemPromptsDisabled: true,
  agentDefinitionsDisabled: true,
});
expect(bundle.session.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);
await bundle.session.prompt(freshInput.request.prompt);
expect(fake.contexts[0]?.tools?.map((tool) => tool.name)).toEqual(["read", "bash", "edit", "write"]);
expect(fake.contexts[0]?.systemPrompt).toContain("PROJECT_CHILD_RULE");
expect(fake.contexts[0]?.systemPrompt).toContain("CLAUDE_CHILD_RULE");
expect(fake.contexts[0]?.systemPrompt).not.toContain("FORBIDDEN_SYSTEM_OVERRIDE");
expect(fake.contexts[0]?.systemPrompt).not.toContain("FORBIDDEN_AGENT_DEFINITION");
expect(JSON.stringify(fake.contexts[0]?.messages)).not.toContain("PARENT_SECRET");
expect(JSON.stringify(fake.contexts[0]?.messages)).not.toContain("ARTIFACT_NOT_INLINED");
await expect(factory.createFresh({
  ...freshInput,
  request: { ...freshInput.request, model: "fake/worker:high" },
})).rejects.toThrow("Thinking level high is unsupported by fake/worker");
const noSessionRecord = structuredClone(validRecord);
delete noSessionRecord.sessionFile;
await expect(factory.reopen({ ...reopenInput, record: noSessionRecord })).rejects.toThrow(
  "Cannot resume subagent without a persisted session, child leaf, and context manifest",
);
const noManifestRecord = structuredClone(validRecord);
delete noManifestRecord.manifest;
await expect(factory.reopen({ ...reopenInput, record: noManifestRecord })).rejects.toThrow(
  "Cannot resume subagent without a persisted session, child leaf, and context manifest",
);
```

- [ ] **Step 9: Run the session-factory test and observe RED**

```bash
npm test -- test/session-factory.test.ts
```

Expected: FAIL because `src/session-factory.ts` does not exist.

- [ ] **Step 10: Implement `SessionFactory`**

Create `src/session-factory.ts` with:

```typescript
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

export class SessionFactory {
  constructor(
    private readonly agentDir: string,
    private readonly modelRuntime: ModelRuntime,
  ) {}

  async createFresh(input: FreshSessionInput): Promise<ChildSessionBundle>;
  async reopen(input: ReopenSessionInput): Promise<ChildSessionBundle>;
}
```

Both methods must reject `projectTrusted === false` and call `resolveTrustedCwd(parentCwd, request.cwd)` for fresh or `resolveTrustedCwd(parentCwd, record.cwd)` for reopen, rechecking containment after symlink resolution. `reopen()` must also reject a record without `sessionFile`, `childLeafId`, or `manifest`, because there is no safe child context or preserved thinking level to resume. Use `SettingsManager.create(cwd, agentDir, { projectTrusted: true })`; create and reload the filtered resource loader; use `SessionManager.create(cwd, join(agentDir, "subagents", parentSessionId))` for fresh sessions and `SessionManager.open(record.sessionFile)` for resume. Before creating a resumed `AgentSession`, call `sessionManager.branch(record.childLeafId)`. Resolve `request.model` on fresh and `record.model` on reopen through `resolveExactModelSpec()`, then pass that exact model to `createAgentSession()` and reject a nonempty `modelFallbackMessage`. For a fresh dispatch, use the requested thinking suffix when present and otherwise retain the newly loaded child setting. For reopen, explicitly apply `record.manifest.thinkingLevel` so later settings changes cannot alter the agent's reasoning level.

Once `createAgentSession()` returns, wrap all remaining setup in `try/catch` and `await session.dispose()` before rethrowing any setup error. Compare `session.thinkingLevel` with that intended level; on a mismatch, throw ``new Error(`Thinking level ${intendedThinking} is unsupported by ${resolved.provider}/${resolved.modelId}`)`` rather than accepting Pi's clamp. Build the manifest with all six literal policy flags from `ContextManifest`, plus data from `loader.getAgentsFiles()`, `loader.getSkills()`, `session.getActiveToolNames()`, the canonical resolved model, actual `session.thinkingLevel`, and `hashPrompt()` of the dispatch or resume prompt. Set the child session name to the agent description.

- [ ] **Step 11: Run all session-factory checks**

```bash
npm test -- test/model-spec.test.ts test/cwd.test.ts test/session-factory.test.ts
npm run check
```

Expected: focused tests and full checks pass.

- [ ] **Step 12: Commit isolated SDK sessions**

```bash
git add src/model-spec.ts src/cwd.ts src/session-factory.ts test/model-spec.test.ts test/cwd.test.ts test/session-factory.test.ts test/helpers/fake-provider.ts
git commit -m "feat: create isolated sdk child sessions"
```

---

### Task 4: Bounded live and persisted transcript model

**Files:**
- Create: `src/transcript.ts`
- Create: `test/transcript.test.ts`

**Interfaces:**
- Consumes: typed `AgentSessionEvent`, `SessionEntry`, `TranscriptRecord`, and transcript limits.
- Produces: `TranscriptStore.appendUserPrompt()`, `TranscriptStore.apply(event)`, `TranscriptStore.snapshot()`, `TranscriptStore.replay(entries, leafId)`, and subscription callbacks used by `ChildRun` and UI.

- [ ] **Step 1: Write failing event-normalization tests**

Create `test/transcript.test.ts` with complete SDK event fixtures and these cases:

```typescript
it("records one user prompt without exposing it as assistant text", () => {
  const store = new TranscriptStore();
  store.appendUserPrompt("implement task 1", 10);
  expect(store.snapshot()).toEqual([
    expect.objectContaining({ kind: "user", timestamp: 10, text: "implement task 1" }),
  ]);
});


it("replaces streaming text records instead of appending every delta", () => {
  const store = new TranscriptStore();
  store.apply(textDeltaEvent("hel"));
  store.apply(textDeltaEvent("hello"));
  expect(store.snapshot().filter((record) => record.kind === "text")).toEqual([
    expect.objectContaining({ text: "hello", streaming: true }),
  ]);
});

it("correlates tool start, update, and end by toolCallId", () => {
  const store = new TranscriptStore();
  store.apply(toolStartEvent);
  store.apply(toolUpdateEvent);
  store.apply(toolEndEvent);
  expect(store.snapshot().filter((record) => record.kind === "tool")).toEqual([
    expect.objectContaining({ toolCallId: "call_1", toolName: "bash", streaming: false, isError: false }),
  ]);
});

it("bounds records and rendered bytes while retaining newest data", () => {
  const store = new TranscriptStore({ maxRecords: 3, maxBytes: 12 });
  for (const text of ["aaaa", "bbbb", "cccc", "dddd"]) store.apply(statusEvent(text));
  expect(store.snapshot().map((record) => record.text)).toEqual(["bbbb", "cccc", "dddd"]);
});

it("replays user messages from only the requested persisted child branch", () => {
  const records = TranscriptStore.replay(branchedEntries, "branch_b_leaf");
  expect(records).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "user", text: "branch b task" })]));
  expect(records.map((record) => record.text)).not.toContain("branch a answer");
});
```

In the same test file, add named cases proving thinking is separate from text, failed tool results retain `isError: true`, oversized tool args/results are collapsed to an 8 KiB rendered summary while full JSONL remains untouched, provider errors become error records, retry and compaction events become readable records, `dispose()` removes listeners and ignores later mutation calls, throwing listeners are removed without breaking event normalization, and every snapshot is a defensive copy.

- [ ] **Step 2: Run transcript tests and observe RED**

```bash
npm test -- test/transcript.test.ts
```

Expected: FAIL because `src/transcript.ts` does not exist.

- [ ] **Step 3: Implement normalized records and bounds**

Create `src/transcript.ts` around a `Map<string, TranscriptRecord>` plus an order array. Use stable live keys:

- assistant content: ``message:${event.message.timestamp}:${event.assistantMessageEvent.contentIndex}``;
- tool execution: ``tool:${event.toolCallId}``;
- retry/compaction/status: generated monotonic IDs.

Handle these events explicitly: `message_update`, `message_end` (assistant/tool-result only; user prompts are appended explicitly to avoid duplicates), `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `auto_retry_start`, `auto_retry_end`, `compaction_start`, `compaction_end`, and `agent_settled`. Format tool args and result text compactly with JSON serialization guarded against circular values; cap each rendered tool record at 8 KiB with a local `[… tool detail collapsed …]` marker and never rewrite persisted JSONL. Never retain more than the configured record and byte limits. Notify listeners behind `try/catch` and remove any listener that throws.

Public shape:

```typescript
export interface TranscriptOptions {
  maxRecords?: number;
  maxBytes?: number;
  initialRecords?: readonly TranscriptRecord[];
}

export class TranscriptStore {
  constructor(options?: TranscriptOptions);
  appendUserPrompt(prompt: string, timestamp: number): void;
  apply(event: AgentSessionEvent): void;
  snapshot(): TranscriptRecord[];
  subscribe(listener: () => void): () => void;
  dispose(): void;
  static replay(entries: readonly SessionEntry[], leafId: string | null): TranscriptRecord[];
}
```

`replay()` must build an ID map, walk `parentId` from the requested child leaf to the root, reverse that raw path, and translate its user, assistant, tool-result, compaction, and branch-summary entries without creating a live `AgentSession`. Do not use compaction-aware `buildContextEntries()` here: the viewer shows the full persisted branch, including messages summarized out of the child's current model context.

- [ ] **Step 4: Run the focused transcript suite and verify GREEN**

```bash
npm test -- test/transcript.test.ts
```

Expected: all normalization, bounds, replay, thinking, error, retry, compaction, disposal, and defensive-copy cases pass.

- [ ] **Step 5: Run transcript and full checks**

```bash
npm test -- test/transcript.test.ts
npm run check
```

Expected: transcript tests and full checks pass.

- [ ] **Step 6: Commit transcript normalization**

```bash
git add src/transcript.ts test/transcript.test.ts
git commit -m "feat: normalize subagent transcripts"
```

---

### Task 5: Supervise one child run

**Files:**
- Create: `src/child-run.ts`
- Create: `test/child-run.test.ts`
- Create: `test/helpers/fakes.ts`

**Interfaces:**
- Consumes: `ChildSessionBundle`, `TranscriptStore`, result primitives, `AgentSession` methods and events.
- Produces: `ChildRun.launch()`, nonrejecting `ChildRun.completion`, `ChildRun.wait(signal, abortOnCancel)`, and reason-aware `ChildRun.abort(terminalState)` for `AgentManager`.

- [ ] **Step 1: Create a controllable fake child session**

Create `test/helpers/fakes.ts` with a `FakeAgentSession` implementing only the structural methods used by `ChildRun`: `prompt()`, `abort()`, `subscribe()`, `dispose()`, `getLastAssistantText()`, `sessionFile`, `sessionId`, `thinkingLevel`, `getActiveToolNames()`, `sessionManager.getLeafId()`, and `sessionManager.getEntries()`. Its prompt promise is controlled by test methods `complete(text, usage)`, `completeError(errorMessage, usage)`, and `fail(error, usage)`; all emit the same typed `message_end` events that a real SDK session emits, while `completeError()` resolves the prompt with assistant `stopReason: "error"`.

Also export `ZERO_USAGE`, `usage(input, output)`, `fixedManifest`, and `fakeBundle(session)`.

- [ ] **Step 2: Write failing run-supervision tests**

Create `test/child-run.test.ts`:

```typescript
it("captures terminal text, state, leaf, and per-run usage", async () => {
  const session = new FakeAgentSession();
  const run = ChildRun.launch({ agentId: "sa_1234abcd", runId: "run_1", prompt: "work", bundle: fakeBundle(session), startedAt: 100 });
  session.complete("Status: DONE", usage(15, 8), "leaf_1");
  await expect(run.completion).resolves.toMatchObject({
    agentId: "sa_1234abcd",
    runId: "run_1",
    state: "completed",
    finalText: "Status: DONE",
    childLeafId: "leaf_1",
    usage: usage(15, 8),
  });
});

it("converts prompt rejection into a failed outcome instead of an unhandled rejection", async () => {
  const session = new FakeAgentSession();
  const run = ChildRun.launch({ agentId: "sa_1234abcd", runId: "run_1", prompt: "work", bundle: fakeBundle(session), startedAt: 100 });
  session.fail(new Error("provider down"), usage(3, 1));
  await expect(run.completion).resolves.toMatchObject({ state: "failed", error: "provider down" });
});

it("cancelling a foreground wait aborts the child", async () => {
  const controller = new AbortController();
  const session = new FakeAgentSession();
  const run = ChildRun.launch({ agentId: "sa_1234abcd", runId: "run_1", prompt: "work", bundle: fakeBundle(session), startedAt: 100 });
  const waiting = run.wait(controller.signal, true);
  controller.abort();
  await waiting;
  expect(session.abort).toHaveBeenCalledOnce();
});

it("cancelling a background wait detaches without aborting", async () => {
  const controller = new AbortController();
  const session = new FakeAgentSession();
  const run = ChildRun.launch({ agentId: "sa_1234abcd", runId: "run_1", prompt: "work", bundle: fakeBundle(session), startedAt: 100 });
  const waiting = run.wait(controller.signal, false);
  controller.abort();
  await expect(waiting).rejects.toThrow("Waiting cancelled");
  expect(session.abort).not.toHaveBeenCalled();
});
```

In the same test file, add named cases proving a resumed run seeds the bounded transcript from its recorded branch and appends the new user prompt exactly once, plus cases for `NEEDS_CONTEXT`, `BLOCKED`, resolved provider-error messages, already-aborted wait signals, user abort, shutdown interruption, transcript event forwarding, listener removal, idempotent `dispose()`, and usage retained by failed or aborted runs.

- [ ] **Step 3: Run tests and observe RED**

```bash
npm test -- test/child-run.test.ts
```

Expected: FAIL because `src/child-run.ts` does not exist.

- [ ] **Step 4: Implement `ChildRun` with immediate rejection supervision**

Create `src/child-run.ts`. `launch()` seeds a bounded `TranscriptStore` with `TranscriptStore.replay(bundle.session.sessionManager.getEntries(), bundle.session.sessionManager.getLeafId())`, appends the new user prompt exactly once at `input.startedAt`, subscribes transcript and usage listeners before calling `session.prompt()`, initializes a zeroed per-run accumulator, and assigns a caught completion promise synchronously:

```typescript
export interface LaunchChildRunInput {
  agentId: string;
  runId: string;
  prompt: string;
  bundle: ChildSessionBundle;
  startedAt: number;
  now?: () => number;
}

export class ChildRun {
  readonly completion: Promise<AgentOutcome>;
  readonly transcript: TranscriptStore;

  static launch(input: LaunchChildRunInput): ChildRun {
    return new ChildRun(input);
  }

  wait(signal: AbortSignal | undefined, abortOnCancel: boolean): Promise<AgentOutcome>;
  abort(terminalState?: "aborted" | "interrupted"): Promise<void>;
  dispose(): void;
}
```

The completion path must always resolve an `AgentOutcome`; it must not reject. On prompt rejection or a final assistant message whose `stopReason` is `"error"`, use `failed`, except an explicit abort uses `aborted` or `interrupted` according to the recorded abort reason. Preserve assistant `errorMessage` in `outcome.error` when present. Initialize the run accumulator from `ZERO_USAGE`; on each `message_end`, add assistant `message.usage` or optional tool-result `message.usage`, and on `compaction_end`, add optional `result.usage`. Use `addUsage()` for every addition so token and cost categories remain exact. Use the injected `now` function (defaulting to `Date.now`) for `settledAt`, and capture the final child leaf and session path before disposal.

`wait()` races completion against an abort listener. With `abortOnCancel: true`, call `abort("aborted")` and then return the terminal aborted outcome. With `false`, remove only that waiter's listener and reject `Waiting cancelled` while `completion` keeps running. `abort("interrupted")` records that requested terminal state before invoking `session.abort()`, allowing shutdown to distinguish interruption from a user abort; the first abort reason wins and repeated abort calls are idempotent.

- [ ] **Step 5: Run the complete child-run suite and verify GREEN**

```bash
npm test -- test/child-run.test.ts
```

Expected: all completion, semantic status, cancellation, interruption, usage, transcript, and cleanup cases pass.

- [ ] **Step 6: Run child-run and full checks**

```bash
npm test -- test/child-run.test.ts
npm run check
```

Expected: child-run tests and full checks pass.

- [ ] **Step 7: Commit child-run supervision**

```bash
git add src/child-run.ts test/child-run.test.ts test/helpers/fakes.ts
git commit -m "feat: supervise sdk child runs"
```

---

### Task 6: Fresh run, background start/wait, and exactly-once accounting

**Files:**
- Modify: `src/types.ts`
- Create: `src/agent-manager.ts`
- Create: `test/agent-manager-run.test.ts`
- Modify: `test/helpers/fakes.ts`

**Interfaces:**
- Consumes: `SessionFactory.createFresh()`, `AgentRegistry`, `ChildRun`, `DispatchRequest`, and a parent execution scope.
- Produces: `AgentManager.start()`, `AgentManager.run()`, `AgentManager.wait()`, `AgentManager.list()`, roster/transcript subscriptions, and `AgentManager.hasActive()`.

- [ ] **Step 1: Define manager scope and result contracts**

Add to `src/types.ts`:

```typescript
export interface ControllerScope {
  parentSessionId: string;
  cwd: string;
  projectTrusted: boolean;
  mode: "tui" | "rpc" | "json" | "print";
}

export interface StartResult {
  agentId: string;
  runId: string;
  state: "working";
}

export interface ClaimedOutcome {
  outcome: AgentOutcome;
  claimedUsage?: Usage;
}
```

- [ ] **Step 2: Write failing manager tests**

Create `test/agent-manager-run.test.ts` with injected deterministic ID, run ID, and clock functions:

```typescript
it("starts in the background and returns before completion", async () => {
  const { manager, session } = fixture();
  await expect(manager.start(request, scope)).resolves.toEqual({ agentId: "sa_00000001", runId: "run_00000001", state: "working" });
  expect(session.isPending()).toBe(true);
});

it("run waits and aborts on caller cancellation", async () => {
  const { manager, session } = fixture();
  const controller = new AbortController();
  const result = manager.run(request, scope, controller.signal);
  controller.abort();
  await expect(result).resolves.toMatchObject({ outcome: { state: "aborted" } });
  expect(session.abort).toHaveBeenCalledOnce();
});

it("wait returns the final response and claims usage once", async () => {
  const { manager, session } = fixture();
  const started = await manager.start(request, scope);
  session.complete("Status: DONE", usage(10, 4), "leaf_1");
  const first = await manager.wait(started.agentId);
  const second = await manager.wait(started.agentId);
  expect(first.claimedUsage).toEqual(usage(10, 4));
  expect(second.claimedUsage).toBeUndefined();
});

it("enforces four active children atomically", async () => {
  const { manager } = fixtureWithPendingSessions(5);
  await Promise.all([0, 1, 2, 3].map((index) => manager.start({ ...request, description: `agent ${index}` }, scope)));
  await expect(manager.start({ ...request, description: "agent 4" }, scope)).rejects.toThrow("Active subagent limit reached (4)");
});
```

In the same file, add named cases proving a foreground signal received during deferred factory setup records abort and prevents prompting, agent/run ID generation retries collisions against the current branch and fails after 100 repeated collisions, simultaneous starts cannot pass a one-slot limit, concurrent waits claim usage once, background child rejection settles without a waiter, a registry-persistence failure in the managed completion has a synchronous rejection observer, completed live sessions dispose immediately, post-disposal waits reconstruct terminal text from the recorded child leaf, roster subscribers receive an immediate defensive snapshot plus later snapshots and can unsubscribe, and selected-agent transcript subscribers receive bounded live updates without copying them into roster state, and a throwing subscriber is removed without breaking lifecycle persistence.

- [ ] **Step 3: Run tests and observe RED**

```bash
npm test -- test/agent-manager-run.test.ts
```

Expected: FAIL because `src/agent-manager.ts` does not exist.

- [ ] **Step 4: Implement manager admission and background completion**

Create `src/agent-manager.ts` with constructor injection so tests never need paid models:

```typescript
export class SubagentOperationError extends Error {
  constructor(
    readonly agentId: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SubagentOperationError";
  }
}

export interface AgentManagerDependencies {
  factory: Pick<SessionFactory, "createFresh" | "reopen">;
  registry: AgentRegistry;
  createAgentId?: () => string;
  createRunId?: () => string;
  now?: () => number;
  maxActive?: number;
}

export class AgentManager {
  constructor(dependencies: AgentManagerDependencies);
  start(request: DispatchRequest, scope: ControllerScope): Promise<StartResult>;
  run(request: DispatchRequest, scope: ControllerScope, signal?: AbortSignal): Promise<ClaimedOutcome>;
  wait(agentId: string, signal?: AbortSignal): Promise<ClaimedOutcome>;
  list(): AgentRecord[];
  get(agentId: string): AgentRecord | undefined;
  hasActive(): boolean;
  subscribe(listener: (records: AgentRecord[]) => void): () => void;
  subscribeTranscript(agentId: string, listener: (records: TranscriptRecord[]) => void): () => void;
}
```

Generate agent IDs with `sa_` plus eight cryptographically random lowercase hex characters in production and collision-check them against the registry. Generate run IDs as `run_` plus eight random lowercase hexadecimal characters and collision-check them against all run records in the current registry. Bound both ID retry loops at 100 attempts and throw an extension-invariant error if exhausted. Increment a synchronous `reservedSlots` counter before the first `await` in `start()` and decrement it only after the run enters the active map or creation fails; admission checks use `active.size + reservedSlots`. Track each asynchronous factory initialization in a `pendingSetups` map keyed by agent ID, including its completion promise and optional requested terminal reason, so abort and shutdown can await it.

Generate the ID and run record first, using `hashPrompt(request.prompt)` for `AgentRunRecord.promptSha256`. Append `created`, then call `factory.createFresh()`. On success, append `started` with the run, bundle session path, current child leaf, and manifest before launching `ChildRun` with the manager's injected `now`; this makes context metadata visible while the child works. If creation fails before `started`, append `settled` directly from `starting` with the run payload and state `failed`, preserve the agent ID in `SubagentOperationError`, release the slot, and throw that error. Wrap a successful `ChildRun` completion in a managed completion promise that persists the matching `settled`, `aborted`, or `interrupted` event with `at: outcome.settledAt`, uses `finally` to remove and dispose the live run without retaining its final text in a settled cache, and notifies subscribers even if terminal registry persistence fails. Attach a rejection observer to that managed completion synchronously before returning from start so an invariant or registry persistence failure cannot become an unhandled background rejection; explicit waiters still receive a `SubagentOperationError` carrying the ID. Put both the run and that managed completion in the active map; every waiter awaits the managed completion so usage cannot be claimed before the terminal registry event exists. Expose `subscribeTranscript()` by subscribing directly to an active `ChildRun.transcript`, immediately passing its current defensive snapshot and then later defensive snapshots and returning a no-op unsubscribe for settled IDs. `subscribe()` immediately calls its listener with a defensive roster snapshot. Invoke subscribers behind `try/catch`, removing a listener that throws so UI code cannot reject lifecycle promises. Emit another defensive-copy roster snapshot after each durable `created`, `started`/`resumed`, terminal, usage-claim, and removal transition.

`run()` calls the same private fresh-start path and waits with `abortOnCancel: true`. It installs its signal before awaiting factory setup; if cancellation arrives during setup, record a pending user-abort and resolve with the eventual aborted outcome without ever prompting the child. `wait()` uses `abortOnCancel: false`; when no live run exists and the record has a session file/leaf, open the child `SessionManager`, call Pi's exported `buildSessionContext(sessionManager.getEntries(), record.childLeafId)`, and pass that context's messages to `extractFinalAssistantText()`. A terminal setup failure with no child session reconstructs an outcome from registry error/state/usage metadata with empty final text and optional manifest/session fields. Both call `registry.claimUsage(agentId, runId, now())` after the terminal outcome is available.

- [ ] **Step 5: Run the complete manager-run suite and verify GREEN**

```bash
npm test -- test/agent-manager-run.test.ts
```

Expected: admission, run/start/wait, failure, disposal, reconstruction, subscription, and exactly-once accounting cases pass.

- [ ] **Step 6: Run manager-run and full checks**

```bash
npm test -- test/agent-manager-run.test.ts
npm run check
```

Expected: manager-run tests and full checks pass.

- [ ] **Step 7: Commit foreground and background management**

```bash
git add src/types.ts src/agent-manager.ts test/agent-manager-run.test.ts test/helpers/fakes.ts
git commit -m "feat: manage foreground and background agents"
```

---

### Task 7: Resume, child branching, abort, remove, stale recovery, and shutdown

**Files:**
- Modify: `src/agent-manager.ts`
- Modify: `src/child-run.ts`
- Modify: `test/child-run.test.ts`
- Create: `test/agent-manager-lifecycle.test.ts`
- Modify: `test/helpers/fakes.ts`

**Interfaces:**
- Consumes: the manager from Task 6, `SessionFactory.reopen()`, persisted child leaf IDs.
- Produces: `AgentManager.resume()`, `abort()`, `remove()`, `recoverStale()`, `shutdown()`, and `loadTranscript()`.

- [ ] **Step 1: Write failing resume and branch tests**

Create `test/agent-manager-lifecycle.test.ts`, importing `expectTypeOf` from Vitest with the runtime assertions:

```typescript
it("resumes the same id from its recorded child leaf", async () => {
  const { manager, factory, resumedSession } = completedFixture({ childLeafId: "leaf_before_review" });
  const result = manager.resume("sa_00000001", "Fix the findings", trustedScope);
  resumedSession.complete("Status: DONE", usage(7, 2), "leaf_after_fix");
  await expect(result).resolves.toMatchObject({ outcome: { agentId: "sa_00000001", childLeafId: "leaf_after_fix" } });
  expect(factory.reopen).toHaveBeenCalledWith(expect.objectContaining({
    record: expect.objectContaining({ childLeafId: "leaf_before_review" }),
    prompt: "Fix the findings",
  }));
});

it("rejects model, cwd, and resource mutation by exposing only id and prompt", () => {
  expectTypeOf<Parameters<AgentManager["resume"]>[1]>().toEqualTypeOf<string>();
});

it("aborts a live child idempotently", async () => {
  const { manager, session, agentId } = activeFixture();
  await manager.abort(agentId);
  await manager.abort(agentId);
  expect(session.abort).toHaveBeenCalledOnce();
});

it("blocks removal while active and hides a terminal agent after removal", async () => {
  const { manager, session, agentId } = activeFixture();
  await expect(manager.remove(agentId)).rejects.toThrow("Cannot remove active agent");
  session.complete("done", usage(1, 1), "leaf_done");
  await manager.wait(agentId);
  await manager.remove(agentId);
  expect(manager.list()).toEqual([]);
});
```

In the same file, add named cases proving aborting a still-pending setup persists `aborted` without prompting, simultaneous resumes reserve the ID synchronously so exactly one is accepted, removal is blocked during resume setup, resume preserves model/thinking/cwd/session/ID, removed IDs cannot resume, the recorded child leaf wins over a later sibling branch, foreground resume cancellation aborts, stale work interrupts once using the newest descendant of the recorded child leaf rather than a sibling leaf, shutdown rejects later starts, a factory resolution racing with shutdown is disposed and never prompted, four children interrupt in parallel, shutdown cleans every child before aggregating a cleanup failure, shutdown is idempotent, a setup failure without JSONL yields a synthetic error transcript, and replay excludes another child branch.

- [ ] **Step 2: Run lifecycle tests and observe RED**

```bash
npm test -- test/agent-manager-lifecycle.test.ts
```

Expected: FAIL because lifecycle methods are absent.

- [ ] **Step 3: Implement resume, abort, remove, and transcript replay**

Add these methods:

```typescript
resume(agentId: string, prompt: string, scope: ControllerScope, signal?: AbortSignal): Promise<ClaimedOutcome>;
abort(agentId: string): Promise<AgentRecord>;
remove(agentId: string): Promise<void>;
loadTranscript(agentId: string): Promise<TranscriptRecord[]>;
recoverStale(): void;
shutdown(): Promise<void>;
```

`resume()` rejects active, setup-reserved, and removed IDs, synchronously reserves both the global slot and agent ID before its first await, installs foreground cancellation before its first await, and calls `factory.reopen()` with the registry record and prompt before appending `resumed` with the reopened session path, child leaf, and manifest. It then launches a new run under the same ID and waits with foreground cancellation. If reopen fails, append `resumed` with the record's existing session path, child leaf, and manifest followed by terminal `failed`, release the reservation, and throw `SubagentOperationError` with the stable ID. Release the per-agent reservation only after the run is active or its setup has reached a durable terminal state. `remove()` treats setup-reserved IDs as active and calls `registry.remove(agentId, now())`. It must never call `createFresh()`.

`loadTranscript()` returns the live store snapshot when active; for a setup failure with no session file, return one synthetic `error` record from registry metadata; otherwise open the recorded session file with `SessionManager.open()`, call `getEntries()`, and replay from the record's child leaf. It must not create an `AgentSession`.

`recoverStale()` calls `registry.markStaleInterrupted(now(), resolver)` before accepting work. The resolver opens each available child session file with `SessionManager.open()`, scans raw entries whose `Date.parse(entry.timestamp)` is at or after the latest run's `startedAt`, and returns the newest leaf whose parent chain descends from the recorded child leaf—not a historical or later sibling branch. If no descendant exists or the file is unreadable, it falls back to the recorded leaf. This preserves the last persisted partial branch after a controller crash without crossing controller branches. `shutdown()` sets a closing flag, calls `run.abort("interrupted")` for every active run with `Promise.allSettled`, awaits both `pendingSetups` and active completion continuations so each lifecycle persists exactly one `interrupted` event, disposes each run, clears the active map, and notifies subscribers. `abort()` also records `"aborted"` on a matching pending setup and awaits its managed setup completion. A fresh factory promise that settles after a pending abort or the closing flag is set must append the requested `aborted`/`interrupted` event directly from `starting`, carrying the run and any resolved bundle metadata. A resume setup appends `resumed` with preserved/resolved metadata before its terminal event. When a factory resolved, dispose the unopened bundle and never call `session.prompt()`. Shutdown interruption wins only when no user-abort reason was already recorded. Do not misclassify either cancellation race as `failed`. Always finish cleanup for every child via `allSettled`; if any abort/completion persistence failed, reject the cached shutdown promise with one `AggregateError` only after cleanup. Cache and return that one shutdown promise so concurrent or later calls are idempotent and await the same result.

- [ ] **Step 4: Run the complete lifecycle suite and verify GREEN**

```bash
npm test -- test/child-run.test.ts test/agent-manager-lifecycle.test.ts
```

Expected: resume, child branching, abort, removal, stale recovery, replay, and shutdown cases pass.

- [ ] **Step 5: Run lifecycle and full checks**

```bash
npm test -- test/child-run.test.ts test/agent-manager-lifecycle.test.ts
npm run check
```

Expected: child-run, lifecycle, and full checks pass.

- [ ] **Step 6: Commit resume and recovery behavior**

```bash
git add src/agent-manager.ts src/child-run.ts test/child-run.test.ts test/agent-manager-lifecycle.test.ts test/helpers/fakes.ts
git commit -m "feat: resume and recover subagents"
```

---

### Task 8: Model-facing tools and Pi lifecycle wiring

**Files:**
- Create: `src/tools.ts`
- Create: `src/index.ts`
- Create: `test/tools.test.ts`
- Create: `test/index.test.ts`

**Interfaces:**
- Consumes: all `AgentManager` methods, Pi `ExtensionAPI`, TypeBox, `ControllerScope`, and Pi tool-result usage.
- Produces: six registered tools, infrastructure-error marking, current-session runtime initialization, navigation guards, and shutdown hook.

- [ ] **Step 1: Write failing tool-registration tests**

Create a fake `ExtensionAPI` that records tools and handlers. In `test/tools.test.ts`, assert:

```typescript
expect(registeredTools.map((tool) => tool.name)).toEqual([
  "subagent_run",
  "subagent_start",
  "subagent_wait",
  "subagent_resume",
  "subagent_abort",
  "subagent_list",
]);
expect(tool("subagent_run").promptGuidelines).toEqual(expect.arrayContaining([
  expect.stringContaining("fix rounds 1-3"),
  expect.stringContaining("fresh subagent_run"),
  expect.stringContaining("Never copy controller conversation history"),
]));
```

Invoke each captured `execute()` against a fake manager and verify exact argument mapping. Validate the schemas against a multiline description and assert rejection. With fake timers, assert `subagent_list` includes active elapsed duration and terminal ISO settlement time but no transcript text. Assert `subagent_start` rejects `ctx.mode` equal to `print` or `json`, while `subagent_run` remains available. Assert terminal `details` include manifest/session/leaf/usage metadata but omit `finalText` and transcript records. Assert provider/setup failures set `infrastructureError: true` and are marked `isError`, while `needs_context`, `blocked`, user-aborted, and successful results are not.

- [ ] **Step 2: Run tool tests and observe RED**

```bash
npm test -- test/tools.test.ts
```

Expected: FAIL because `src/tools.ts` does not exist.

- [ ] **Step 3: Implement strict schemas and tool results**

Create `src/tools.ts` with strict schemas:

```typescript
const DispatchParameters = Type.Object({
  description: Type.String({ minLength: 1, maxLength: 120, pattern: "^(?=.*\\S)[^\\r\\n]+$" }),
  prompt: Type.String({ minLength: 1 }),
  model: Type.String({ minLength: 3 }),
  cwd: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });

const AgentIdParameters = Type.Object({
  agentId: Type.String({ pattern: "^sa_[0-9a-f]{8}$" }),
}, { additionalProperties: false });

const ResumeParameters = Type.Object({
  agentId: Type.String({ pattern: "^sa_[0-9a-f]{8}$" }),
  prompt: Type.String({ minLength: 1 }),
}, { additionalProperties: false });
```

Export:

```typescript
const EmptyParameters = Type.Object({}, { additionalProperties: false });

export type SubagentToolName =
  | "subagent_run"
  | "subagent_start"
  | "subagent_wait"
  | "subagent_resume"
  | "subagent_abort"
  | "subagent_list";

export interface SubagentToolDetails {
  operation: SubagentToolName;
  agentId?: string;
  state?: AgentState;
  outcome?: Omit<AgentOutcome, "finalText">;
  records?: AgentRecord[];
  error?: string;
  infrastructureError?: boolean;
}

export function registerSubagentTools(pi: ExtensionAPI, getManager: () => AgentManager): void;
```

Use these exact labels and capability snippets:

```typescript
const TOOL_METADATA = {
  subagent_run: ["Subagent Run", "Create a fresh isolated subagent and wait for its final response"],
  subagent_start: ["Subagent Start", "Create a fresh isolated background subagent and return its ID"],
  subagent_wait: ["Subagent Wait", "Wait for a background subagent without aborting it if waiting is cancelled"],
  subagent_resume: ["Subagent Resume", "Resume a settled subagent with its original context, model, cwd, and identity"],
  subagent_abort: ["Subagent Abort", "Abort a running subagent by ID"],
  subagent_list: ["Subagent List", "List current-session subagent IDs and states without transcript text"],
} as const;

const SDD_GUIDELINES = [
  "Use subagent_run for each fresh Superpowers implementer, task reviewer, re-reviewer, and final reviewer.",
  "Use subagent_resume with the original implementer ID for Superpowers fix rounds 1-3; use a fresh subagent_run with an explicitly more capable canonical provider/model for fix rounds 4-5.",
  "Never copy controller conversation history into a subagent prompt; pass task briefs, reports, plans, and review packages by file path.",
  "Never run multiple Superpowers implementation agents concurrently.",
  "Every subagent_start must eventually be paired with subagent_wait or subagent_abort so its final result and usage are collected.",
];
```

Use `DispatchParameters` for run/start, `AgentIdParameters` for wait/abort, `ResumeParameters` for resume, and `EmptyParameters` for list. Details may contain context manifests, model, usage, session path, child leaf, timings, and terminal state as structured local metadata, but never final text or transcript records; Pi excludes details from model context. `subagent_start` returns the string `agent_id: ${result.agentId}\nstatus: working`. `subagent_list` returns one line per visible record beginning `${record.id} | ${record.state} | ${record.description} | ${record.model} | runs:${record.runs.length}` and appends `elapsed:${formatDuration(now - (latestRun?.startedAt ?? record.createdAt))}` for active records or `settled:${new Date(latestRun?.settledAt ?? record.updatedAt).toISOString()}` for terminal records. It returns `No subagents in this controller branch` for an empty roster. Use `formatOutcomeForModel()` for terminal results, passing `outcome.finalText || outcome.error || ""` as its body; that helper applies the 50 KiB cap and conditionally appends the exact truncation notice defined in Task 1. Return claimed child usage in the tool result's `usage`. Infrastructure failures return structured details with `infrastructureError: true`; register one `tool_result` hook that marks only those subagent results `isError: true` without discarding content, details, or usage.

Put Superpowers mapping guidance on `subagent_run` and concise capability snippets on all tools. Do not inject a custom message.

- [ ] **Step 4: Write failing extension-lifecycle tests**

In `test/index.test.ts`, capture registered event handlers and verify:

- `session_start` builds a registry from `ctx.sessionManager.getBranch()` and calls stale recovery;
- untrusted contexts reject dispatch through the manager scope;
- `session_before_tree` and `session_before_fork` return `{ cancel: true }` when `manager.hasActive()`;
- inactive navigation returns no cancellation;
- `session_tree` disposes the inactive branch runtime and reconstructs the registry/manager from the new `ctx.sessionManager.getBranch()`;
- `session_shutdown` awaits manager shutdown;
- `session_start` after reload replaces, rather than reuses, the prior session-scoped runtime.

- [ ] **Step 5: Implement extension wiring**

Create `src/index.ts` with `createSubagentsExtension(dependencies)` as a test seam and default-export its production instance. Dependencies provide async model-runtime creation and session-factory construction; defaults use `ModelRuntime.create({ allowModelNetwork: false })` and `new SessionFactory(...)`. The returned extension factory owns session-scoped state:

```typescript
export interface SubagentsExtensionDependencies {
  createModelRuntime(): Promise<ModelRuntime>;
  createSessionFactory(agentDir: string, runtime: ModelRuntime): SessionFactory;
}

const productionDependencies: SubagentsExtensionDependencies = {
  createModelRuntime: () => ModelRuntime.create({ allowModelNetwork: false }),
  createSessionFactory: (agentDir, runtime) => new SessionFactory(agentDir, runtime),
};

export function createSubagentsExtension(
  dependencies: SubagentsExtensionDependencies = productionDependencies,
): (pi: ExtensionAPI) => void {
  return function piSubagents(pi: ExtensionAPI): void {
    let current: {
      manager: AgentManager;
      modelRuntime: ModelRuntime;
      sessionFactory: SessionFactory;
    } | undefined;

    const rebuildBranch = async (ctx: ExtensionContext, sessionFactory: SessionFactory): Promise<AgentManager> => {
      const registry = AgentRegistry.fromEntries(
        ctx.sessionManager.getBranch(),
        (entry) => pi.appendEntry(CUSTOM_ENTRY_TYPE, entry),
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

    pi.on("session_before_tree", () => current?.manager.hasActive() ? { cancel: true } : undefined);
    pi.on("session_before_fork", () => current?.manager.hasActive() ? { cancel: true } : undefined);
    pi.on("session_tree", async (_event, ctx) => {
      if (!current) return;
      await current.manager.shutdown();
      current.manager = await rebuildBranch(ctx, current.sessionFactory);
    });
    pi.on("session_shutdown", async () => {
      await current?.manager.shutdown();
      current = undefined;
    });
  };
}

export default createSubagentsExtension();
```

Add a `scopeFromContext(ctx)` helper that returns `{ parentSessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted(), mode: ctx.mode }`; every tool calls it at execution time rather than retaining the `session_start` context. Navigation cancellation calls `ctx.ui.notify("Wait for or abort active subagents before branching", "warning")` only when `ctx.hasUI` is true and returns `{ cancel: true }`.

- [ ] **Step 6: Run tool, lifecycle, and full checks**

```bash
npm test -- test/tools.test.ts test/index.test.ts
npm run check
```

Expected: tool, extension-lifecycle, and full checks pass.

- [ ] **Step 7: Commit model-facing tools**

```bash
git add src/tools.ts src/index.ts test/tools.test.ts test/index.test.ts
git commit -m "feat: expose subagent tools"
```

---

### Task 9: Compact always-visible agent widget

**Files:**
- Create: `src/ui/agent-widget.ts`
- Create: `src/ui/controller.ts`
- Create: `test/agent-widget.test.ts`
- Modify: `src/index.ts`
- Modify: `test/index.test.ts`

**Interfaces:**
- Consumes: manager snapshots/subscriptions, Pi `Theme`, TUI `Component`, and TUI render invalidation.
- Produces: `AgentWidget`, `installAgentUi()`, five-row ordering, elapsed timer, local notifications, `/agents`, and `Alt+A` wiring.

- [ ] **Step 1: Write failing pure widget tests**

Create `test/agent-widget.test.ts` with an identity-color test theme and fixed clock. Verify:

```typescript
it("orders needs-input, working, then recent terminal agents", () => {
  const widget = new AgentWidget(sourceWith([completed, working, needsContext]), testTheme, () => 120_000);
  expect(widget.render(100).slice(1).map(stripAnsi)).toEqual([
    expect.stringContaining("needs context"),
    expect.stringContaining("working"),
    expect.stringContaining("completed"),
  ]);
});

it("shows at most five rows plus overflow", () => {
  const lines = new AgentWidget(sourceWith(sevenRecords), testTheme, () => 120_000).render(100);
  expect(lines).toHaveLength(7);
  expect(stripAnsi(lines.at(-1) ?? "")).toContain("+2 more");
});

it("never renders wider than the supplied width", () => {
  const lines = new AgentWidget(sourceWith([longDescription]), testTheme, () => 120_000).render(32);
  expect(lines.every((line) => visibleWidth(line) <= 32)).toBe(true);
});
```

Also test `render()` returns `[]` before the first agent, text labels independent of color, widget IDs shown as the first five hex characters without `sa_`, model shortening, active elapsed time from the latest run's `startedAt`, and terminal duration from that run's `settledAt - startedAt`.

- [ ] **Step 2: Run widget tests and observe RED**

```bash
npm test -- test/agent-widget.test.ts
```

Expected: FAIL because the widget does not exist.

- [ ] **Step 3: Implement widget rendering and timer lifecycle**

Create `src/ui/agent-widget.ts` implementing `Component`. Constructor inputs are a narrow source interface, theme, clock, and `requestRender`. Subscribe to source changes. Start a one-second interval only when any record is `starting` or `working`, call `unref()` on Node's timer handle, and clear it immediately when none are active. `dispose()` unsubscribes and clears the interval. `invalidate()` clears render caches and reapplies current theme on next render.

Return no lines while the roster is empty. Once the first agent exists, use `truncateToWidth()` for every line and render header counts and `alt+a`, then five records ordered by state priority and descending latest-run activity (`startedAt` while active, `settledAt` when terminal, with `updatedAt` fallback), then overflow. Use the first five hexadecimal ID characters without the `sa_` prefix in compact rows. Use `○ starting`, `● working`, `! needs context`, `! blocked`, `✓ completed`, `✗ failed`, `■ aborted`, and `◐ interrupted`; always render both icon and words.

- [ ] **Step 4: Write failing UI installation and disposal tests**

Extend `test/index.test.ts` to assert that TUI `session_start` installs the `pi-subagents` widget, completion transitions notify once, `/agents` and `Alt+A` delegate to the current session's UI controller, reload and allowed `session_tree` reconstruction dispose the prior controller and install a branch-local replacement, and `session_shutdown` awaits manager shutdown before clearing the widget and timer. Assert `sendMessage` and `sendUserMessage` remain uncalled.

Run:

```bash
npm test -- test/index.test.ts
```

Expected: FAIL because `src/ui/controller.ts` and UI wiring do not exist.

- [ ] **Step 5: Implement UI installation and command wiring**

Create `src/ui/controller.ts`:

```typescript
export interface AgentUiController {
  dispose(): void;
  open(ctx: ExtensionContext): Promise<void>;
}

export function installAgentUi(ctx: ExtensionContext, manager: AgentManager): AgentUiController;
```

For TUI mode, call `ctx.ui.setWidget("pi-subagents", factory, { placement: "aboveEditor" })`. Subscribe to manager state and call `ctx.ui.notify()` only on transitions to `completed`, `needs_context`, `blocked`, or `failed`. Track previous states so reload does not replay historical notifications. In non-TUI mode, return a no-op controller with no widget, timers, manager subscription, overlay, or local notifications. In TUI mode for this task, `open()` locally notifies `Agent viewer is not available until the viewer component is installed`; it does not create a model message.

Modify `src/index.ts` so current session state also owns `ui: AgentUiController`. Install it after manager creation. During reload, tree reconstruction, and shutdown, use `try/finally` to await manager shutdown so final state/leaf events persist and still dispose the old UI controller before clearing or replacing branch state; install a fresh controller against the reconstructed branch manager. Register `/agents` and `Alt+A` once in the extension factory; both call `current?.ui.open(ctx)`.

- [ ] **Step 6: Run widget, wiring, and full checks**

```bash
npm test -- test/agent-widget.test.ts test/index.test.ts
npm run check
```

Expected: widget, extension wiring, and full checks pass.

- [ ] **Step 7: Commit the live widget**

```bash
git add src/ui/agent-widget.ts src/ui/controller.ts test/agent-widget.test.ts src/index.ts test/index.test.ts
git commit -m "feat: show live subagent widget"
```

---

### Task 10: Switchable read-only agent viewer

**Files:**
- Create: `src/ui/agent-viewer.ts`
- Create: `test/agent-viewer.test.ts`
- Modify: `src/ui/controller.ts`
- Modify: `test/index.test.ts`

**Interfaces:**
- Consumes: manager roster, `loadTranscript()`, context manifests, run usage, injected `KeybindingsManager`, Pi overlay API.
- Produces: `AgentViewer`, the real `AgentUiController.open()`, abort/remove actions, and responsive roster/detail UI behind the existing `/agents` and `Alt+A` entrypoints.

- [ ] **Step 1: Write failing viewer rendering and navigation tests**

Create `test/agent-viewer.test.ts` with a fake TUI request-render callback and keybindings manager; the `working` fixture transcript begins with a user record containing `implement task 1`. Test:

```typescript
it("switches the selected transcript with up and down", async () => {
  const viewer = await createViewer([working, completed]);
  expect(stripAnsi(viewer.render(120).join("\n"))).toContain("you  implement task 1");
  expect(stripAnsi(viewer.render(120).join("\n"))).toContain("working transcript");
  viewer.handleInput(keyFor("tui.select.down"));
  expect(stripAnsi(viewer.render(120).join("\n"))).toContain("completed transcript");
});

it("cycles transcript, context, and usage tabs", async () => {
  const viewer = await createViewer([working]);
  viewer.handleInput(keyFor("tui.input.tab"));
  const contextView = stripAnsi(viewer.render(120).join("\n"));
  expect(contextView).toContain("Context manifest");
  expect(contextView).toContain("extensions disabled");
  viewer.handleInput(keyFor("tui.input.tab"));
  const usageView = stripAnsi(viewer.render(120).join("\n"));
  expect(usageView).toContain("Run usage");
  expect(usageView).toContain("claimed");
});

it("uses stacked layout below 100 columns and split layout at 100 columns", async () => {
  const viewer = await createViewer([working]);
  expect(viewer.layoutForWidth(99)).toBe("stacked");
  expect(viewer.layoutForWidth(100)).toBe("split");
});

it("requests abort and removal through controller callbacks", async () => {
  const onAbort = vi.fn();
  const onRemove = vi.fn();
  const viewer = await createViewer([working, completed], { onAbort, onRemove });
  viewer.handleInput("a");
  expect(onAbort).toHaveBeenCalledWith(working.id);
  viewer.handleInput(keyFor("tui.select.down"));
  viewer.handleInput("x");
  expect(onRemove).toHaveBeenCalledWith(completed.id);
});
```

Assert the context tab shows context-file/skill paths and policy flags but not fixture file contents. Also test selection visibility with more than 20 roster rows, Page Up/Down scrolling, configured `app.thinking.toggle`, hidden-thinking filtering, Escape close, line-width invariants, empty roster, selection staying on the same agent ID when roster order changes, a selected active agent's `subscribeTranscript()` update appearing without reselection, and `dispose()` unsubscribing both roster and transcript listeners.

- [ ] **Step 2: Run viewer tests and observe RED**

```bash
npm test -- test/agent-viewer.test.ts
```

Expected: FAIL because `src/ui/agent-viewer.ts` does not exist.

- [ ] **Step 3: Implement the responsive viewer component**

Create `src/ui/agent-viewer.ts` implementing `Component` with:

```typescript
export type ViewerTab = "transcript" | "context" | "usage";
export type ViewerLayout = "split" | "stacked";

export interface AgentViewerOptions {
  manager: AgentManager;
  theme: Theme;
  keybindings: KeybindingsManager;
  requestRender: () => void;
  onClose: () => void;
  onAbort: (agentId: string) => void;
  onRemove: (agentId: string) => void;
}

export class AgentViewer implements Component {
  static create(options: AgentViewerOptions): Promise<AgentViewer>;
  layoutForWidth(width: number): ViewerLayout;
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
  dispose(): void;
}
```

Show full stable `sa_` IDs in the viewer and keep the selected row inside a 20-row roster window as Up/Down moves. Group roster rows under Needs input, Working, and Completed labels, using the widget's latest-run activity ordering within each group. In split mode reserve 32 columns for roster and one column for separator; in stacked mode show a compact roster section followed by selected detail. Use a 20-row detail viewport, moving 18 rows when `keybindings.matches()` sees `tui.select.pageUp` or `tui.select.pageDown`; close on `tui.select.cancel`. Use `wrapTextWithAnsi()`, `sliceByColumn()`, and `truncateToWidth()` so no rendered line exceeds width.

Render user-prompt records with a `you` prefix and all other records with stable kind labels. Load transcript asynchronously when selection changes, showing `Loading transcript…` until ready. Then subscribe through `manager.subscribeTranscript()` for bounded live updates to that selected active agent. Track selection by stable agent ID rather than array index, reset detail scroll on selection/tab changes, unsubscribe on reselection or disposal, and ignore stale load/subscription callbacks if selection changes again. Render context paths/names without file contents and render each run's token/cost totals and claimed/unclaimed marker. Thinking records are hidden by default and controlled by `keybindings.matches(data, "app.thinking.toggle")`.

- [ ] **Step 4: Write the failing overlay-controller test**

Extend `test/index.test.ts` so invoking `/agents` in TUI mode expects `ctx.ui.custom()` with `overlay: true`, while print mode expects no overlay and no local notification. Capture the viewer callbacks and assert confirmed abort/remove calls the matching manager method, while a false confirmation calls neither; rejected manager mutations must become local error notifications rather than unhandled rejections. Assert controller disposal closes an open overlay and disposes its viewer. Run:

```bash
npm test -- test/index.test.ts
```

Expected: FAIL because `AgentUiController.open()` still uses the Task 9 local-notification stub.

- [ ] **Step 5: Replace the UI controller stub with the overlay flow**

In `src/ui/controller.ts`, make `open(ctx)` return immediately when `ctx.hasUI` is false; otherwise use:

```typescript
await ctx.ui.custom<void>(
  (tui, theme, keybindings, done) => AgentViewer.create({
    manager,
    theme,
    keybindings,
    requestRender: () => tui.requestRender(),
    onClose: () => done(undefined),
    onAbort: (agentId) => void confirmAbort(ctx, manager, agentId, tui),
    onRemove: (agentId) => void confirmRemove(ctx, manager, agentId, tui),
  }),
  {
    overlay: true,
    overlayOptions: { width: "95%", maxHeight: "90%", anchor: "center", margin: 1 },
  },
);
```

Track the active overlay's `done` callback and viewer instance in `AgentUiController`; `dispose()` closes the overlay, disposes the viewer, and is idempotent. Prevent a second concurrent `open()` from creating another overlay. `confirmAbort()` and `confirmRemove()` use `ctx.ui.confirm()` before mutating manager state, catch operation errors, and report them with a local error notification so the fire-and-forget callback cannot create an unhandled rejection. Removing hides the record but never deletes its child JSONL.

- [ ] **Step 6: Verify existing entrypoints open the real viewer**

```bash
npm test -- test/index.test.ts
```

Expected: `/agents` and `Alt+A` open the overlay in TUI mode, non-TUI mode makes no overlay or notification call, and neither path sends a controller message.

- [ ] **Step 7: Run viewer, wiring, and full checks**

```bash
npm test -- test/agent-viewer.test.ts test/index.test.ts
npm run check
```

Expected: viewer, entrypoint, and full checks pass.

- [ ] **Step 8: Commit the switchable viewer**

```bash
git add src/ui/agent-viewer.ts src/ui/controller.ts test/agent-viewer.test.ts test/index.test.ts
git commit -m "feat: add switchable subagent viewer"
```

---

### Task 11: Full SDK SDD and controller-context acceptance

**Files:**
- Create: `test/sdd-flow.test.ts`
- Create: `test/extension-context.test.ts`

**Interfaces:**
- Consumes: the complete extension, real SDK session factory, deterministic fake provider, and parent `SessionManager`.
- Produces: end-to-end evidence for fresh dispatch, reviewer isolation, implementer resume, context exclusion, branch persistence, and no UI-to-model leakage.

- [ ] **Step 1: Write the deterministic stock-SDD-shaped integration test**

Create `test/sdd-flow.test.ts` using the real `SessionFactory`, `AgentRegistry`, `AgentManager`, temp Git repo, and fake provider. Queue these fake terminal responses in order:

```text
**Status:** DONE
Commits created: a1b2c3d implement task
Tests: 4/4 passing
Report: /tmp/task-1-report.md
```

```text
### Spec Compliance
✅ Spec compliant
### Issues
None
### Assessment
Task quality: Approved
```

```text
**Status:** DONE
Commits created: d4e5f6a address review
Tests: 5/5 passing
Report: /tmp/task-1-report.md
```

The test must:

1. dispatch a fresh implementer with `subagent_run` semantics;
2. dispatch a distinct fresh reviewer;
3. resume the original implementer ID with review findings;
4. assert reviewer and implementer session paths differ;
5. assert the resumed implementer context includes its first turn and fix prompt;
6. assert reviewer context excludes implementer transcript;
7. assert all child contexts exclude a sentinel parent message;
8. assert only terminal response text appears in formatted controller results;
9. assert exact model and no extension tool definitions;
10. assert usage claims exist once per run.

- [ ] **Step 2: Run the complete SDD integration test**

```bash
npm test -- test/sdd-flow.test.ts
```

Expected: PASS with three fake-provider requests, two distinct agent IDs, the first ID reused on resume, three once-only usage claims, and no sentinel parent text in any captured child context.

- [ ] **Step 3: Write extension context and recovery acceptance tests**

Create `test/extension-context.test.ts` that loads `createSubagentsExtension()` with deterministic runtime/session-factory dependencies against a fake `ExtensionAPI` and real temp parent `SessionManager`. Assert:

- lifecycle custom entries never appear in `buildSessionContext().messages`, and a sentinel stored only in tool-result `details` is absent from that result's model-visible `content`;
- `subagent_list` recovers IDs after rebuilding the extension runtime from parent entries;
- parent compaction-aware branch building retains registry entries on the active path;
- `session_tree` switches to that branch's roster and hides sibling-only IDs;
- stale working records become interrupted after simulated restart;
- parent tree/fork events are blocked while a fake child is active;
- widget/viewer updates never call captured `sendMessage` or `sendUserMessage` functions.

- [ ] **Step 4: Run extension-context acceptance tests**

```bash
npm test -- test/extension-context.test.ts
```

Expected: PASS with zero model-context messages created from registry or UI state, recovered IDs on reload, one stale interruption, and both active-navigation guards returning cancellation.

- [ ] **Step 5: Run the full automated suite**

```bash
npm run check
```

Expected: typecheck and every deterministic test pass with no warnings or paid-provider calls.

- [ ] **Step 6: Commit end-to-end acceptance coverage**

```bash
git add test/sdd-flow.test.ts test/extension-context.test.ts
git commit -m "test: cover superpowers subagent workflow"
```

---

### Task 12: Documentation, CI, package smoke, and release readiness

**Files:**
- Create: `test/real-model.smoke.test.ts`
- Create: `README.md`
- Create: `.github/workflows/ci.yml`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: the release-ready extension and public Git package metadata.
- Produces: opt-in real-provider smoke coverage, complete user documentation, Node 22/24 CI, package-content verification, and manual stock-Superpowers evidence.

- [ ] **Step 1: Write the opt-in real-model smoke test**

Create `test/real-model.smoke.test.ts`. Read `PI_SUBAGENTS_SMOKE_MODEL`; use `describe.skip` when absent. When set, create a temp Git repository, dispatch `Reply with exactly: SMOKE_OK` through the real `SessionFactory`, assert terminal text contains `SMOKE_OK`, and in `finally` always call `manager.shutdown()` and remove only that test's unique temp Git directory and unique parent-session child directory.

Add this package script and run `npm install` to update the lockfile:

```json
"test:smoke": "vitest run test/real-model.smoke.test.ts"
```

- [ ] **Step 2: Verify the smoke test is inert by default**

```bash
npm run test:smoke
```

Expected: one skipped smoke suite, exit 0, and no provider request.

The credentialed command is:

```bash
PI_SUBAGENTS_SMOKE_MODEL='provider/model' npm run test:smoke
```

- [ ] **Step 3: Write complete user documentation**

Create `README.md` with these concrete sections:

1. What `pi-subagents` does.
2. Install: `pi install git:github.com/ryangraham/pi-subagents`.
3. Requirements: Pi 0.83+, Node 22.19+, installed stock Superpowers for SDD.
4. Tool table for all six tools and required canonical model syntax; models must be authenticated in the child runtime, and providers supplied only by disabled extensions are unavailable.
5. Exact SDD mapping: fresh implementer/reviewer, resume rounds 1–3, fresh capable fixer rounds 4–5.
6. Context table listing included and excluded data.
7. Result budget: UTF-8-safe 50 KiB cap, with stock implementer responses expected to remain at most 15 lines while reviewer findings retain the full cap.
8. TUI widget and `/agents` / `Alt+A` controls.
9. Persistence path and branch behavior.
10. Security statement: same OS authority, not a sandbox, cwd containment, no child extensions.
11. Headless limitation: no UI, and no background start in print/JSON.
12. Usage-accounting limitation when a started background run is never waited on.
13. Development: `npm install`, `npm run check`, optional smoke command.
14. Git-only release/install policy for v1.

Do not claim direct child interaction, worktree isolation, named profiles, or inherited extensions.

- [ ] **Step 4: Add Node 22/24 CI**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        node: [22, 24]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm run check
```

- [ ] **Step 5: Run complete package verification**

```bash
npm run check
npm pack --dry-run
```

Expected:

- typecheck exits 0;
- all non-smoke tests pass with no warnings;
- smoke test is skipped without credentials;
- package dry run includes `src/index.ts`, README, LICENSE, and package metadata;
- package dry run excludes tests, coverage, and local session data because the Task 1 `files` array contains only `src`, `README.md`, and `LICENSE`.

- [ ] **Step 6: Perform the local Pi package smoke check**

Use a temporary Pi agent directory so normal settings are untouched:

```bash
tmp_agent_dir=$(mktemp -d)
trap 'rm -rf "$tmp_agent_dir" /tmp/pi-subagents-models.txt' EXIT
PI_CODING_AGENT_DIR="$tmp_agent_dir" pi -e . --list-models >/tmp/pi-subagents-models.txt
rm -rf "$tmp_agent_dir" /tmp/pi-subagents-models.txt
trap - EXIT
```

Expected: Pi loads the package without extension diagnostics and exits successfully after listing models; both temporary paths are removed.

- [ ] **Step 7: Perform the manual stock-Superpowers workflow**

With normal authenticated Pi and stock Superpowers installed, execute one tiny plan through implementer → reviewer → resumed implementer → re-reviewer. Confirm:

- stable implementer ID across resume;
- distinct reviewer IDs;
- explicit canonical model shown for every fresh agent;
- live widget updates;
- extension reload reconstructs the branch roster and settled child transcripts;
- `Alt+A` switches transcripts;
- context tab contains expected files/skills and reports extensions disabled;
- controller transcript receives only terminal child responses.

Record this evidence in the pull-request description or release notes, not production source.

- [ ] **Step 8: Commit release-ready v0.1.0 contents**

```bash
git add package.json package-lock.json README.md .github/workflows/ci.yml test/real-model.smoke.test.ts
git commit -m "docs: prepare pi subagents v0.1.0"
```

Do not create the `v0.1.0` tag until the final whole-branch review and finishing-a-development-branch workflow approve the implementation.
