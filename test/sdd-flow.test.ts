import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.ts";
import { AgentRegistry } from "../src/registry.ts";
import { SessionFactory } from "../src/session-factory.ts";
import { registerSubagentTools, type SubagentToolDetails } from "../src/tools.ts";
import {
  CUSTOM_ENTRY_TYPE,
  type RegistryEvent,
} from "../src/types.ts";
import { createFakeProvider } from "./helpers/fake-provider.ts";

const execFile = promisify(execFileCallback);
const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

function resultText(result: Awaited<ReturnType<ToolDefinition<any, SubagentToolDetails>["execute"]>>): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

describe("stock Superpowers subagent workflow", () => {
  it("isolates fresh implementer and reviewer contexts then resumes the original implementer", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-subagents-sdd-flow-"));
    tempDirs.push(tempDir);
    const projectDir = join(tempDir, "project");
    const agentDir = join(tempDir, "agent");
    const parentDir = join(tempDir, "parent-sessions");
    await Promise.all([
      mkdir(projectDir, { recursive: true }),
      mkdir(agentDir, { recursive: true }),
      mkdir(parentDir, { recursive: true }),
    ]);
    await execFile("git", ["init", "-q", projectDir]);
    await Promise.all([
      writeFile(join(projectDir, "AGENTS.md"), "CHILD_PROJECT_RULE\n", "utf8"),
      writeFile(join(projectDir, "task-1-brief.md"), "Implement Task 1 from the approved plan.\n", "utf8"),
      writeFile(join(projectDir, "task-1-review.md"), "Fix the naming issue only.\n", "utf8"),
    ]);

    const implementerResponse = [
      "**Status:** DONE",
      "Commits created: a1b2c3d implement task",
      "Tests: 4/4 passing",
      "Report: /tmp/task-1-report.md",
    ].join("\n");
    const reviewerResponse = [
      "### Spec Compliance",
      "✅ Spec compliant",
      "### Issues",
      "None",
      "### Assessment",
      "Task quality: Approved",
    ].join("\n");
    const fixResponse = [
      "**Status:** DONE",
      "Commits created: d4e5f6a address review",
      "Tests: 5/5 passing",
      "Report: /tmp/task-1-report.md",
    ].join("\n");
    const fake = await createFakeProvider([
      { text: implementerResponse, usage: { input: 10, output: 4, totalTokens: 14 } },
      { text: reviewerResponse, usage: { input: 20, output: 5, totalTokens: 25 } },
      { text: fixResponse, usage: { input: 30, output: 6, totalTokens: 36 } },
    ]);
    const parent = SessionManager.create(projectDir, parentDir);
    const parentSentinel = "PARENT_CONTEXT_SENTINEL_MUST_NOT_REACH_CHILDREN";
    parent.appendMessage({
      role: "user",
      content: [{ type: "text", text: parentSentinel }],
      timestamp: 1,
    });

    const persisted: RegistryEvent[] = [];
    const registry = AgentRegistry.fromEntries(parent.getBranch(), (event) => {
      persisted.push(structuredClone(event));
      parent.appendCustomEntry(CUSTOM_ENTRY_TYPE, event);
    });
    let agentSequence = 0;
    let runSequence = 0;
    let clock = 1_000;
    const manager = new AgentManager({
      factory: new SessionFactory(agentDir, fake.runtime),
      registry,
      createAgentId: () => `sa_${(++agentSequence).toString(16).padStart(8, "0")}`,
      createRunId: () => `run_${(++runSequence).toString(16).padStart(8, "0")}`,
      now: () => ++clock,
    });

    const tools: ToolDefinition<any, SubagentToolDetails>[] = [];
    const pi = {
      registerTool: (tool: ToolDefinition<any, SubagentToolDetails>) => tools.push(tool),
      on: vi.fn(),
    } as unknown as ExtensionAPI;
    registerSubagentTools(pi, () => manager);
    const context = {
      mode: "tui",
      hasUI: true,
      cwd: projectDir,
      signal: undefined,
      sessionManager: parent,
      isProjectTrusted: () => true,
    } as unknown as ExtensionContext;
    const execute = (
      name: string,
      params: Record<string, unknown>,
    ) => {
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`Missing tool ${name}`);
      return tool.execute(`call_${name}`, params, undefined, undefined, context);
    };

    const implementPrompt = `Read ${join(projectDir, "task-1-brief.md")} and implement Task 1. Do not ask the controller for history.`;
    const implementResult = await execute("subagent_run", {
      description: "implement task 1",
      prompt: implementPrompt,
      model: "fake/worker",
    });
    const implementerId = implementResult.details.agentId!;

    const reviewerPrompt = `Review Task 1 against ${join(projectDir, "task-1-brief.md")} using the report path /tmp/task-1-report.md.`;
    const reviewerResult = await execute("subagent_run", {
      description: "review task 1",
      prompt: reviewerPrompt,
      model: "fake/worker",
    });
    const reviewerId = reviewerResult.details.agentId!;

    const fixPrompt = `Read ${join(projectDir, "task-1-review.md")} and address the review findings.`;
    const resumeResult = await execute("subagent_resume", {
      agentId: implementerId,
      prompt: fixPrompt,
    });

    expect(implementerId).toBe("sa_00000001");
    expect(reviewerId).toBe("sa_00000002");
    expect(resumeResult.details.agentId).toBe(implementerId);
    const implementer = manager.get(implementerId)!;
    const reviewer = manager.get(reviewerId)!;
    expect(implementer.sessionFile).toBeTruthy();
    expect(reviewer.sessionFile).toBeTruthy();
    expect(implementer.sessionFile).not.toBe(reviewer.sessionFile);
    expect(implementer).toMatchObject({ model: "fake/worker", state: "completed" });
    expect(reviewer).toMatchObject({ model: "fake/worker", state: "completed" });
    expect(implementer.runs).toHaveLength(2);
    expect(reviewer.runs).toHaveLength(1);

    expect(fake.contexts).toHaveLength(3);
    const implementContext = JSON.stringify(fake.contexts[0]);
    const reviewContext = JSON.stringify(fake.contexts[1]);
    const resumedContext = JSON.stringify(fake.contexts[2]);
    const encodedImplementerResponse = JSON.stringify(implementerResponse).slice(1, -1);
    expect(implementContext).toContain(implementPrompt);
    expect(reviewContext).toContain(reviewerPrompt);
    expect(reviewContext).not.toContain(implementPrompt);
    expect(reviewContext).not.toContain(encodedImplementerResponse);
    expect(resumedContext).toContain(implementPrompt);
    expect(resumedContext).toContain(encodedImplementerResponse);
    expect(resumedContext).toContain(fixPrompt);
    for (const captured of fake.contexts) {
      expect(JSON.stringify(captured)).not.toContain(parentSentinel);
      expect(captured.tools?.map((tool) => tool.name)).toEqual(["read", "bash", "edit", "write"]);
      expect(captured.tools?.some((tool) => tool.name.startsWith("subagent_"))).toBe(false);
    }

    const implementText = resultText(implementResult);
    const reviewerText = resultText(reviewerResult);
    const resumeText = resultText(resumeResult);
    expect(implementText).toContain(implementerResponse);
    expect(implementText).not.toContain(implementPrompt);
    expect(implementText).not.toContain(reviewerResponse);
    expect(reviewerText).toContain(reviewerResponse);
    expect(reviewerText).not.toContain(implementerResponse);
    expect(reviewerText).not.toContain(reviewerPrompt);
    expect(resumeText).toContain(fixResponse);
    expect(resumeText).not.toContain(implementerResponse);
    expect(resumeText).not.toContain(fixPrompt);
    for (const text of [implementText, reviewerText, resumeText]) expect(text).not.toContain(parentSentinel);

    expect(implementResult.usage).toMatchObject({ input: 10, output: 4, totalTokens: 14 });
    expect(reviewerResult.usage).toMatchObject({ input: 20, output: 5, totalTokens: 25 });
    expect(resumeResult.usage).toMatchObject({ input: 30, output: 6, totalTokens: 36 });
    const claims = persisted.filter((event) => event.kind === "usage_claimed");
    expect(claims).toHaveLength(3);
    expect(new Set(claims.map((event) => event.runId))).toEqual(
      new Set(["run_00000001", "run_00000002", "run_00000003"]),
    );
    expect(implementer.runs.every((run) => run.usageClaimed)).toBe(true);
    expect(reviewer.runs.every((run) => run.usageClaimed)).toBe(true);
    expect((await manager.wait(implementerId)).claimedUsage).toBeUndefined();
    expect((await manager.wait(reviewerId)).claimedUsage).toBeUndefined();
    expect(persisted.filter((event) => event.kind === "usage_claimed")).toHaveLength(3);

    await manager.shutdown();
  });
});
