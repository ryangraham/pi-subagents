# Pi Subagents Design

**Date:** 2026-08-16  
**Status:** Approved  
**Repository:** `https://github.com/ryangraham/pi-subagents`

## Summary

`pi-subagents` is a public Pi extension that provides visible, resumable, context-isolated subagents. Its primary use case is running Obra Superpowers' stock `subagent-driven-development` workflow without modifying or forking Superpowers.

The extension uses Pi's in-process SDK exclusively. Each subagent is an independent `AgentSession` with its own messages, system prompt, tools, model, context window, and persisted session. Subagents share the controller's trusted worktree by default, but they never inherit the controller's conversation history.

The extension provides both background-first primitives and a synchronous convenience tool for Superpowers. A compact always-visible widget shows current agents, and a full read-only viewer lets the user switch among live transcripts.

## Goals

1. Run the upstream Superpowers SDD workflow unchanged.
2. Give every fresh subagent an isolated context window with explicitly constructed task context.
3. Resume the same implementer context for SDD fix rounds 1–3.
4. Support fresh, explicitly modeled agents for reviewers and fix rounds 4–5.
5. Keep subagent transcripts out of the controller's model context.
6. Show a persistent roster and switchable live transcript viewer in Pi's TUI.
7. Persist identities and child sessions across controller compaction, reload, and resume.
8. Preserve Pi's normal project instructions and skills while disabling child extensions.
9. Account for nested model usage without double-counting.
10. Install directly as a Pi Git package.

## Non-goals

Version 1 will not include:

- subprocess execution;
- an RPC subagent backend, backend abstraction, or placeholder transport layer;
- direct user messaging into a child session;
- reusable `.pi/agents/*.md` agent definitions;
- built-in implementer, reviewer, or planner profiles;
- inherited child extensions or custom tools;
- automatic worktree creation;
- project-wide history spanning unrelated controller sessions;
- automatic forwarding of parent history or agent output;
- a fork or modified copy of Superpowers;
- npm publication;
- filesystem or process sandboxing.

## Repository and package

The extension lives in one independently installable public repository:

```text
https://github.com/ryangraham/pi-subagents
```

The local checkout is `~/dev/pi-subagents`. The default branch is `main`.

Planned package structure:

```text
pi-subagents/
├── src/
│   ├── index.ts
│   ├── agent-manager.ts
│   ├── session-factory.ts
│   ├── registry.ts
│   ├── transcript.ts
│   ├── tools.ts
│   ├── types.ts
│   └── ui/
│       ├── agent-widget.ts
│       └── agent-viewer.ts
├── test/
├── docs/superpowers/specs/
├── package.json
├── README.md
├── LICENSE
└── .github/workflows/ci.yml
```

Package metadata:

- package name: `pi-subagents`;
- initial version: `0.1.0`;
- license: MIT;
- keyword: `pi-package`;
- Pi packages and `typebox` declared as `"*"` peer dependencies;
- no runtime dependencies unless implementation demonstrates a concrete need;
- Git installation only for version 1.

Installation command:

```bash
pi install git:github.com/ryangraham/pi-subagents
```

## Architecture

### Extension entrypoint

The entrypoint constructs the extension's session-scoped services and registers:

- subagent tools;
- the `/agents` command;
- the `Alt+A` shortcut;
- the compact agent widget;
- lifecycle handlers for startup, reload, navigation, and shutdown.

The entrypoint contains wiring only. Agent execution, persistence, transcript normalization, and UI rendering remain separate units.

### AgentManager

`AgentManager` owns:

- the in-memory map of active agents;
- admission control and the active-agent limit;
- SDK session creation and reopening;
- supervised background promises;
- start, wait, run, resume, and abort operations;
- lifecycle transitions;
- usage-claim serialization;
- shutdown and disposal.

Only `AgentManager` may mutate live agent state. Per-agent operations are serialized so simultaneous waits, aborts, and resumes cannot produce invalid transitions.

### SessionFactory

`SessionFactory` creates a fresh or resumed Pi SDK `AgentSession` using:

- a shared `ModelRuntime` for model catalog and credential resolution;
- a child-specific persistent `SessionManager`;
- a child-specific `SettingsManager` for the selected cwd;
- a `DefaultResourceLoader` configured with `noExtensions: true`;
- an exact resolved model;
- Pi's standard built-in coding tools;
- normal retry and compaction behavior from Pi settings.

There is no transport interface and no alternate execution backend.

### AgentRegistry

`AgentRegistry` folds append-only custom entries from the active controller branch into current agent records. It stores durable metadata and lifecycle changes, not transcript copies.

The custom entry type is `pi-subagents`, with a versioned data payload. Persisted event kinds are:

```text
created
started
settled
resumed
aborted
interrupted
removed
```

Each event includes the stable agent ID, timestamp, child session path, and child leaf ID where applicable. State reconstruction ignores records not present on the controller's active branch.

### TranscriptStore

`TranscriptStore` subscribes to typed `AgentSessionEvent` values and normalizes them into viewer records for:

- assistant text;
- collapsed thinking blocks;
- tool calls;
- streaming tool progress;
- tool results;
- retries;
- compaction;
- errors;
- lifecycle changes.

Running transcripts use a bounded in-memory cache. The persisted child JSONL remains authoritative. Completed transcripts are rebuilt from the child session on demand rather than duplicated into a second persistent format.

### Agent UI

The UI consists of:

- a compact widget above the editor;
- a full responsive read-only overlay;
- local TUI notifications.

UI updates read normalized state and never write transcript events into controller messages.

## Context model

### Fresh child context

A fresh child receives these layers:

1. Pi's normal coding-agent system prompt;
2. global and project `AGENTS.md` files discovered for the child's cwd;
3. discovered skill metadata, including the installed Superpowers package;
4. Pi's standard built-in coding tools;
5. the explicit dispatch prompt as the first user message.

The initial active built-ins match normal Pi coding-agent defaults: `read`, `bash`, `edit`, and `write`. No extension tools are loaded. Agents may use command-line `rg`, `find`, and related utilities through `bash` as in a normal Pi session.

### Excluded context

A child never receives:

- controller conversation messages;
- controller compaction or branch summaries;
- controller tool calls or tool results;
- controller attachments;
- the controller's expanded skill bodies;
- a copy of `ctx.getSystemPrompt()`;
- an automatically generated parent summary;
- output from another child unless the explicit dispatch prompt references an artifact containing it.

The extension does not inspect the controller transcript to construct dispatches.

### Resumed context

Resuming an agent restores only that child's recorded branch and appends the new resume prompt. It does not inject current controller state. The agent retains its original model, thinking level, cwd, resource policy, and identity.

If the original model or its authentication is unavailable, resume fails explicitly. It never silently selects a fallback model.

### Artifact-first handoff

The extension treats paths in prompts as text. It does not read, resolve, or inline task briefs, reports, plans, review packages, or other artifacts. The child reads those files with its own tools.

The extension never automatically chains one child's output into another child's prompt. This preserves Superpowers' artifact-first context discipline.

### Context manifest

Every agent records a local, viewable context manifest containing:

- canonical cwd;
- exact provider/model and thinking level;
- active built-in tool names;
- discovered context-file paths;
- discovered skill names and source paths;
- confirmation that child extensions were disabled;
- dispatch byte length and content hash.

The manifest does not duplicate the dispatch prompt or context-file contents. It is available in tool-result details and the TUI viewer, but not in controller model context.

## Model-facing tool API

All tools use strict TypeBox schemas and Google-compatible string enums where needed.

### `subagent_run`

Creates a fresh agent and waits for it to settle.

Parameters:

```typescript
{
  description: string;
  prompt: string;
  model: string;
  cwd?: string;
}
```

`model` is required and accepts Pi's exact model syntax, including an optional thinking suffix such as `provider/model:high`.

This is the default SDD dispatch primitive.

### `subagent_start`

Creates a fresh background agent and returns after startup acceptance.

Parameters are identical to `subagent_run`.

The result includes the stable agent ID and initial state. It does not include child usage because the run has not settled. Short-lived print and JSON hosts reject this operation and direct callers to `subagent_run`.

### `subagent_wait`

Waits for a background agent to settle.

Parameters:

```typescript
{
  agentId: string;
}
```

If already settled, it returns immediately. Cancelling this tool stops waiting but does not abort the child. The child must be stopped explicitly with `subagent_abort`.

### `subagent_resume`

Reopens a settled or interrupted child session, appends a new prompt, and waits for settlement.

Parameters:

```typescript
{
  agentId: string;
  prompt: string;
}
```

The caller cannot change model, thinking level, cwd, or resources. Calling resume on a currently active agent is an error.

### `subagent_abort`

Stops an active child.

Parameters:

```typescript
{
  agentId: string;
}
```

Abort is idempotent. Aborting an already terminal agent returns its current status without changing it.

### `subagent_list`

Returns a compact roster for the current controller branch. It includes IDs, descriptions, models, states, run counts, and elapsed or completion times. It never includes transcript text.

This tool is the controller's recovery mechanism after compaction.

## Superpowers compatibility

The extension does not bundle or override any Superpowers skill. Tool prompt metadata maps the stock SDD skill's abstract dispatch operations onto this API:

- fresh implementer: `subagent_run`;
- fresh task reviewer: `subagent_run`;
- fix rounds 1–3: `subagent_resume` with the original implementer ID;
- fix rounds 4–5: a fresh `subagent_run` with an explicitly more capable model;
- final reviewer: a fresh `subagent_run` with the explicitly selected capable model.

Tool guidance repeats these binding rules:

- every fresh dispatch specifies an exact model;
- no parallel implementation agents;
- task requirements and large context are handed over by file path;
- controller history is never copied into a dispatch;
- every `subagent_start` must eventually be paired with `subagent_wait` or `subagent_abort`.

The extension does not infer agent roles from description text and does not supply role-specific system prompts. Superpowers owns those prompts.

## Identity and lifecycle

A fresh agent receives a stable opaque ID in the form `sa_` followed by eight lowercase hexadecimal characters. IDs are unique within the controller session and must be supplied exactly to model-facing tools. The UI may omit the `sa_` prefix where space is constrained.

Resumption preserves the ID and increments a run counter.

Infrastructure lifecycle states are:

```text
starting
working
completed
needs_context
blocked
failed
aborted
interrupted
removed
```

Allowed primary transitions are:

```text
starting -> working
starting -> failed
starting -> aborted
working  -> completed
working  -> needs_context
working  -> blocked
working  -> failed
working  -> aborted
working  -> interrupted
completed|needs_context|blocked|failed|aborted|interrupted -> working  (resume)
terminal -> removed
```

The display classifier inspects a final response for the Superpowers contracts `DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, and `BLOCKED`. Classification affects UI state only. It never rewrites the response or overrides the controller's interpretation.

## Results and context budget

`subagent_run`, `subagent_wait`, and `subagent_resume` return model-visible content in this order:

```text
agent_id: <id>
status: <state>

<child final response>
```

Only the child's final assistant response enters controller context. Streaming text, thinking, tool calls, tool output, retries, and earlier child turns remain in the child session and viewer.

The final response is capped at 50 KiB using UTF-8-safe truncation. When truncation occurs, the result states that it was truncated and provides the local child-session reference. Full content remains in the child JSONL.

Implementer responses are expected to remain under the stock Superpowers limit of 15 lines. Reviewer and re-reviewer responses are intentionally allowed to use the full 50 KiB because the controller needs every finding.

Tool-result details contain structured metadata, including context manifest, model, usage, session path, child leaf, timings, and terminal state. Details do not participate in model context.

## Usage accounting

Each child run has a unique run record and cumulative SDK usage captured from assistant messages and child tool-reported nested usage.

- `subagent_run` and `subagent_resume` report the current run's usage on their tool result.
- `subagent_start` reports no usage at startup.
- The first successful `subagent_wait` after a background run reports that run's unclaimed usage.
- Concurrent or repeated waits may return the same final text, but usage is claimed atomically by at most one result.
- Resuming creates a new run record, so only the new turn sequence is charged by that resume tool result.

Registry metadata records whether each run's usage has been claimed. If a background agent is never waited on before its controller session ends, its usage remains visible in the agent viewer but cannot be added retrospectively to an already finalized parent tool result.

## Persistence and branching

### Storage location

Child sessions are stored under:

```text
~/.pi/agent/subagents/<parent-session-id>/
```

The parent session stores only append-only custom lifecycle entries. Frequent streaming events are not appended to the parent session.

### Controller compaction and reload

Custom lifecycle entries do not participate in LLM context, so controller compaction does not erase the registry. On extension reload or controller resume, the registry is reconstructed from the active branch.

A record whose final durable state is `working` but has no corresponding live SDK session is marked `interrupted`. No child restarts automatically.

### Matching parent and child branches

Every durable lifecycle event records the child session leaf ID represented by that parent state.

If the controller branches and resumes an older child state, the extension branches the child `SessionManager` from the recorded child leaf before appending the resume prompt. Later child work from a different controller branch is therefore excluded.

One child JSONL may contain multiple branches corresponding to controller branches. The registry's child leaf pointer determines which transcript and context path to use.

Tree navigation and parent forking are blocked while background children are active. The user must wait for or abort them first, preventing completion events from being persisted on the wrong controller branch.

### Removal

Removing an agent appends a `removed` event on the active controller branch and hides it from the roster. Version 1 does not automatically delete the child JSONL because another controller branch may still reference it. There is no automatic retention cleanup.

## TUI design

### Compact widget

After the first agent is created, a widget above the editor displays at most five rows:

```text
subagents  2 working · 1 needs input · 3 done                 alt+a
  ● a13c7  Implement Task 2                 sonnet:high   1m42s
  ! b81e2  Fix review findings              gpt-5.6       needs context
  ✓ c904a  Review Task 1                     sonnet        38s
  +3 more
```

Ordering is:

1. needs context or blocked;
2. working or starting;
3. most recently completed or failed.

Symbols are always accompanied by words so state is not communicated by color alone. Every rendered line is truncated to the supplied terminal width.

### Full viewer

`/agents` and `Alt+A` open a large overlay.

At wide widths, it uses a roster and transcript split view:

```text
┌ Agents ─────────────┬ Live transcript ─────────────────────┐
│ Needs input         │ assistant text, thinking, tool calls,│
│ Working             │ progress, tool results, and errors   │
│ Completed           │                                      │
└─────────────────────┴──────────────────────────────────────┘
```

At narrow widths, roster and detail become stacked views.

Controls:

- Up/Down: select agent;
- Page Up/Page Down: scroll selected detail;
- Tab: cycle transcript, context manifest, and usage;
- Ctrl+T: show or hide thinking;
- `a`: abort a running agent after confirmation;
- `x`: remove a terminal agent after confirmation;
- Escape: close the overlay and return to the controller.

Changing selection immediately changes the live transcript. Version 1 has no child message composer.

Tool calls and results are collapsed by default and bounded for rendering. The persisted child session retains full data.

### Notifications and rendering

Completion, failure, blocked, and needs-context transitions update the widget and create local TUI notifications. No custom message is injected into controller context.

A lightweight timer refreshes elapsed time only while agents are active. All subscriptions, timers, and overlay handles are disposed during shutdown.

In non-TUI hosts, model-facing tools continue to operate. The widget, overlay, shortcut, and local notifications are disabled; `subagent_list` remains available.

## Concurrency

The controller session permits at most four active child sessions. Admission is atomic.

Parallel `subagent_run` and `subagent_start` calls are supported for independent tasks. The extension does not claim filesystem isolation: all default agents share the same trusted worktree. Pi's file-mutation queue protects individual built-in writes, but callers must avoid semantically conflicting tasks.

The Superpowers-specific tool guidance prohibits multiple concurrent implementation agents.

Only one active run or resume is allowed for a given agent ID. Multiple waits share the same completion promise. Settled SDK sessions are disposed and reopened only when viewing needs uncached data or when resuming.

## Cancellation and errors

### Cancellation

- Cancelling `subagent_run` or `subagent_resume` aborts that child and waits for it to become idle.
- Cancelling `subagent_wait` detaches that waiter while leaving the child active.
- `subagent_abort` explicitly aborts the child.
- Partial child transcript and session state remain persisted after cancellation.

### Error classes

The extension distinguishes:

- dispatch validation failures;
- model resolution or authentication failures;
- resource-loading failures;
- provider failures;
- child tool failures;
- extension invariant failures;
- user aborts;
- interrupted controller lifecycle.

Invalid model, unavailable authentication, invalid cwd, and session-creation failures produce a durable failed record and a model-visible tool error containing the agent ID.

`NEEDS_CONTEXT` and `BLOCKED` are semantic SDD outcomes, not infrastructure errors.

Background failures update the UI immediately. A later wait returns the preserved error and partial final response. Every background promise installs its rejection handler before the starting tool returns.

## Trust and security

The extension is not a sandbox. Child agents and their built-in tools have the controller user's OS permissions. A separate `AgentSession` isolates model context, not filesystem authority.

The default child cwd is the controller cwd. An override must:

1. exist and be a directory;
2. resolve to a canonical path;
3. remain inside the controller's current trusted Git repository/worktree after symlink resolution.

An override outside that boundary is rejected. To work in another repository, the user starts a controller session in that repository.

Child extensions are disabled, preventing recursive loading of `pi-subagents` and hidden behavior from unrelated extensions. Skills and context files still load through Pi's normal trusted resource discovery.

Credentials remain inside the shared Pi `ModelRuntime`. API keys, tokens, and resolved authentication are never written into prompts, registry events, context manifests, or tool-result details.

## Shutdown and crash recovery

Shutdown is idempotent and follows this order:

1. reject new starts and resumes;
2. abort active children in parallel;
3. mark unfinished runs interrupted;
4. persist final child leaf pointers and metadata;
5. unsubscribe SDK event listeners;
6. dispose child sessions;
7. clear timers and UI handles.

This runs for extension reload, controller session replacement, and normal process shutdown.

If the process crashes before shutdown completes, startup detects stale working records and marks them interrupted. Automatic continuation is intentionally forbidden because it could duplicate edits or commits. The controller or user must explicitly resume.

## Testing strategy

Implementation follows test-driven development.

### Unit tests

Unit coverage includes:

- lifecycle transition validation;
- semantic status parsing;
- stable ID generation and collision handling;
- UTF-8-safe 50 KiB truncation;
- exactly-once usage claims;
- registry folding over active parent branches;
- parent and child leaf correspondence;
- cwd containment and symlink escapes;
- transcript event normalization;
- context-manifest construction;
- bounded transcript caches;
- responsive widget ordering and formatting.

### Deterministic SDK integration tests

Integration tests use temporary directories and a deterministic fake model/provider with no network or paid credentials. They cover:

- fresh child context excludes every parent message;
- `AGENTS.md` and skills are discovered;
- child extensions are disabled;
- exact model selection and no silent fallback;
- `start` followed by `wait`;
- synchronous `run`;
- resume preserves identity and child context;
- abort and waiter cancellation semantics;
- settled sessions dispose and reopen;
- shutdown marks active agents interrupted;
- stale-working recovery;
- child branching from the parent-recorded leaf;
- concurrent waits do not double-count usage;
- active-agent admission limit.

### TUI tests

TUI tests cover:

- narrow and wide rendering;
- line-width invariants with ANSI styling;
- roster ordering and overflow;
- keyboard navigation;
- live transcript updates;
- thinking visibility;
- abort and remove confirmation;
- disposal of timers and handles.

### Optional smoke test

A credentialed local smoke test exercises a real model. It is excluded from CI by default.

### CI

GitHub Actions runs on Node 22 and Node 24 and executes:

- TypeScript type checking;
- unit tests;
- deterministic SDK integration tests;
- TUI tests.

## Release acceptance

Version `0.1.0` is releasable when all automated checks pass and a manual workflow using the stock Superpowers package demonstrates:

1. a fresh implementer dispatch;
2. a fresh task reviewer dispatch;
3. resumption of the original implementer with review findings;
4. a fresh scoped re-reviewer;
5. stable identities and exact explicit models;
6. live switching among all agents in the viewer;
7. correct recovery after extension reload;
8. no controller-history inheritance;
9. only each child's final response entering controller context;
10. correct child session and usage persistence.

## Success criteria

The extension succeeds when an unmodified Superpowers SDD run can coordinate fresh and resumed agents while the human can continuously see who is working and inspect any child transcript, without polluting the controller's context or maintaining a second execution backend.
