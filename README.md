# pi-subagents

Visible, resumable, context-isolated subagents for [Pi](https://github.com/earendil-works/pi), designed for the stock [Obra Superpowers](https://github.com/obra/superpowers) subagent-driven development workflow.

`pi-subagents` runs each child as an independent in-process Pi SDK session. Children share the controller's trusted working tree, while their model context and persisted transcripts remain separate from the controller conversation. A compact live widget and a read-only transcript viewer make that work visible without injecting UI state into model context.

## Install

```bash
pi install git:github.com/ryangraham/pi-subagents
```

Restart or reload Pi after installation.

## Requirements

- Pi 0.83 or newer
- Node.js 22.19 or newer (Node 24 is also tested)
- Authenticated provider/model credentials available to Pi
- Stock Obra Superpowers installed when using its subagent-driven development workflow

Version 1 is distributed from Git only. It is not published to npm.

## Tools

| Tool | Purpose |
| --- | --- |
| `subagent_run` | Create a fresh isolated child and wait for its terminal response. |
| `subagent_start` | Create a fresh child in the background and return its stable agent ID. |
| `subagent_wait` | Wait for a background child or reconstruct an already-settled result. |
| `subagent_resume` | Resume a settled child under the same ID, model, cwd, session, and context history. |
| `subagent_abort` | Abort a starting or working child. Its transcript remains available. |
| `subagent_list` | List branch-local agent IDs, states, models, run counts, and timing metadata without transcript text. |

Every fresh dispatch requires an explicit canonical model:

```text
provider/model[:thinking]
```

Examples include `anthropic/claude-sonnet-4-5:high` and `openai/gpt-5.2`. The exact provider/model must exist and be authenticated in the child runtime; there is no fallback model. Providers made available only by another extension are unavailable because child extensions are disabled. `subagent_resume` deliberately has no model argument and restores the original model and thinking level.

At most four children may be starting or working at once.

## Superpowers mapping

Use the stock workflow without changing Superpowers:

| Workflow stage | Tool mapping |
| --- | --- |
| Fresh implementer | `subagent_run` with the implementer brief path and an explicit model |
| Fresh task reviewer | A distinct `subagent_run` with the review package paths |
| Fix rounds 1–3 | `subagent_resume` using the original implementer ID |
| Re-review | A fresh reviewer via `subagent_run` |
| Fix rounds 4–5 | A fresh `subagent_run` with an explicitly more capable model |
| Final review | A fresh reviewer via `subagent_run` |

Pass plans, task briefs, reports, and review packages by path. Do not copy the controller conversation into child prompts.

## Context isolation

| Included in a fresh child | Excluded from a fresh child |
| --- | --- |
| The explicit dispatch prompt | Controller messages and summaries |
| Normal discovered `AGENTS.md` and `CLAUDE.md` instructions | Controller tool calls/results and attachments |
| Normal Pi skills catalog | Skill bodies expanded in the controller conversation |
| Pi's built-in `read`, `bash`, `edit`, and `write` tools | Extension-provided tools, including these subagent tools |
| The exact authenticated model and requested thinking level | Prompt templates and themes |
| The selected cwd inside the trusted controller root | Custom system prompts and agent-definition files |
| Access to the shared controller filesystem/worktree | Any implicit copy of parent history |

A resumed child reopens only its own recorded branch, then appends the new resume prompt. A fresh reviewer never receives an implementer's transcript.

## Results and transcript budget

Foreground run, wait, and resume calls return only the terminal child response to controller model context. Output is capped at 50 KiB with a UTF-8-safe boundary and an explicit truncation notice. The complete child transcript remains in the child JSONL.

Stock Superpowers implementer responses are expected to stay at 15 lines or fewer. Reviewer findings are not line-limited by this extension and retain the full 50 KiB result budget.

Tool-result details may include the model, context manifest, usage, session path, child leaf, timing, and terminal state. They never contain the final response or transcript records.

## TUI

After the first agent exists, a widget above the editor shows up to five agents, prioritized as needs input, working, then recent terminal work. State is always represented by words as well as symbols.

Open the read-only viewer with either:

- `/agents`
- `Alt+A`

Viewer controls:

| Key | Action |
| --- | --- |
| Up / Down | Select an agent |
| Page Up / Page Down | Scroll detail by 18 rows |
| Tab | Cycle transcript, context manifest, and usage |
| Ctrl+T | Show or hide thinking records |
| `a` | Confirm and abort a starting/working agent |
| `x` | Confirm and remove a terminal agent from this branch's roster |
| Escape | Close the viewer |

The viewer switches between split and stacked layouts at 100 columns. It has no child message composer; direct child interaction is intentionally outside the v1 scope.

## Persistence and branches

Child sessions are stored under:

```text
~/.pi/agent/subagents/<parent-session-id>/
```

Lifecycle metadata is stored as append-only Pi custom entries on the controller session tree. Reloading reconstructs the active branch's roster, while switching branches hides sibling-only agents. Stale starting or working entries become `interrupted` on restart. Removing an agent hides it from that branch but does not delete its child JSONL, because another branch may still reference it.

## Security model

This extension isolates model context, not operating-system authority. It is **not a sandbox**.

Children run with the same user permissions as the controller and share its filesystem/worktree. Requested child cwd values are canonicalized and must remain inside the controller's trusted root. Child extensions are disabled, and fresh sessions do not inherit controller conversation history.

Review child tool calls and use the same repository and credential precautions you would use for the controller.

## Headless modes

Print, JSON, and RPC hosts have no widget, viewer, shortcut, or local UI notifications. Foreground `subagent_run`, wait, resume, abort, and list operations remain available. Background `subagent_start` is rejected in short-lived print and JSON modes.

## Usage accounting

Terminal usage is persisted per child run and can be claimed exactly once by a terminal run/wait/resume tool result. If a background run started with `subagent_start` is never collected with `subagent_wait`, its usage remains visible in the viewer but cannot be added retrospectively to an already-finalized parent tool result. Call `subagent_wait` for every started run, including after an abort when parent usage accounting matters.

## Development

```bash
npm install
npm run check
```

The deterministic suite makes no paid-provider requests. `npm audit --omit=dev` audits the shipped dependency surface. A full development-tree audit may report advisories inherited from the Pi 0.83 minimum-compatibility fixture; Pi is a peer supplied by the host and that development tree is not included in this package. Use a current, security-supported Pi release in normal installations.

To run the opt-in credentialed smoke test:

```bash
PI_SUBAGENTS_SMOKE_MODEL='provider/model' npm run test:smoke
```

Without `PI_SUBAGENTS_SMOKE_MODEL`, the smoke suite is skipped.

Package contents can be inspected with:

```bash
npm pack --dry-run
```

## Release policy

The v1 line is installed directly from Git. npm publication, named agent profiles, inherited extensions, direct child messaging, automatic retention cleanup, and worktree isolation are not part of v1.
