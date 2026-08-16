import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { hashPrompt } from "../src/result.ts";
import { SessionFactory, type FreshSessionInput } from "../src/session-factory.ts";
import type { AgentRecord } from "../src/types.ts";
import { createFakeProvider, type FakeProviderHarness } from "./helpers/fake-provider.ts";

const execFile = promisify(execFileCallback);
const sessions: AgentSession[] = [];
const tempDirs: string[] = [];

interface Fixture {
  tempDir: string;
  projectDir: string;
  agentDir: string;
  artifactPath: string;
  fake: FakeProviderHarness;
  factory: SessionFactory;
  freshInput: FreshSessionInput;
}

async function createFixture(responses = ["Status: DONE", "Status: DONE"]): Promise<Fixture> {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-subagents-session-factory-"));
  tempDirs.push(tempDir);
  const projectDir = join(tempDir, "project");
  const agentDir = join(tempDir, "agent");
  const artifactPath = join(projectDir, "task-brief.md");

  await Promise.all([
    mkdir(join(projectDir, ".pi"), { recursive: true }),
    mkdir(join(agentDir, "skills", "example"), { recursive: true }),
    mkdir(join(agentDir, "extensions"), { recursive: true }),
    mkdir(join(agentDir, "agents"), { recursive: true }),
  ]);
  await execFile("git", ["init", "-q", projectDir]);
  await Promise.all([
    writeFile(join(projectDir, "AGENTS.md"), "PROJECT_CHILD_RULE\n", "utf8"),
    writeFile(join(projectDir, "CLAUDE.md"), "CLAUDE_CHILD_RULE\n", "utf8"),
    writeFile(join(tempDir, "CLAUDE.md"), "CLAUDE_CHILD_RULE\n", "utf8"),
    writeFile(join(projectDir, "SYSTEM.md"), "ROOT_SYSTEM_FILE_SHOULD_NOT_LOAD\n", "utf8"),
    writeFile(join(projectDir, ".pi", "SYSTEM.md"), "FORBIDDEN_SYSTEM_OVERRIDE\n", "utf8"),
    writeFile(join(projectDir, ".pi", "APPEND_SYSTEM.md"), "FORBIDDEN_APPENDED_SYSTEM\n", "utf8"),
    writeFile(
      join(agentDir, "skills", "example", "SKILL.md"),
      "---\nname: example\ndescription: Example child skill\n---\n\n# Example\n\nEXAMPLE_SKILL_BODY\n",
      "utf8",
    ),
    writeFile(
      join(agentDir, "extensions", "forbidden.ts"),
      'throw new Error("FORBIDDEN_EXTENSION_LOADED");\n',
      "utf8",
    ),
    writeFile(join(agentDir, "agents", "forbidden.md"), "FORBIDDEN_AGENT_DEFINITION\n", "utf8"),
    writeFile(artifactPath, "ARTIFACT_NOT_INLINED\n", "utf8"),
  ]);

  const fake = await createFakeProvider(responses.map((text) => ({ text })));
  const factory = new SessionFactory(agentDir, fake.runtime);
  const freshInput: FreshSessionInput = {
    parentSessionId: "parent-test-session",
    parentCwd: projectDir,
    request: {
      description: "implement task one",
      prompt: `Read the task brief at ${artifactPath} and implement it.`,
      model: "fake/worker",
    },
    projectTrusted: true,
  };

  return { tempDir, projectDir, agentDir, artifactPath, fake, factory, freshInput };
}

function track(session: AgentSession): AgentSession {
  sessions.push(session);
  return session;
}

function completedRecord(bundle: Awaited<ReturnType<SessionFactory["createFresh"]>>): AgentRecord {
  const sessionFile = bundle.session.sessionFile;
  const childLeafId = bundle.session.sessionManager.getLeafId();
  if (!sessionFile || !childLeafId) throw new Error("completed fixture is missing persisted session metadata");
  return {
    id: "sa_1234abcd",
    description: "implement task one",
    cwd: bundle.manifest.cwd,
    model: bundle.manifest.model,
    thinkingLevel: bundle.manifest.thinkingLevel,
    state: "completed",
    sessionFile,
    childLeafId,
    manifest: bundle.manifest,
    createdAt: 100,
    updatedAt: 200,
    runs: [
      {
        runId: "run_1",
        index: 1,
        promptSha256: bundle.manifest.dispatchSha256,
        startedAt: 100,
        settledAt: 200,
        usageClaimed: true,
        childLeafId,
      },
    ],
  };
}

afterEach(async () => {
  while (sessions.length > 0) sessions.pop()?.dispose();
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

describe("SessionFactory", () => {
  it("creates a persistent isolated session with filtered resources", async () => {
    const { factory, freshInput, fake, artifactPath, projectDir } = await createFixture(["Status: DONE"]);
    const bundle = await factory.createFresh(freshInput);
    track(bundle.session);

    expect(bundle.manifest.contextFiles).toEqual(
      expect.arrayContaining([expect.stringMatching(/AGENTS\.md$/), expect.stringMatching(/CLAUDE\.md$/)]),
    );
    expect(bundle.manifest.skills.map((skill) => skill.name)).toContain("example");
    expect(bundle.manifest).toMatchObject({
      cwd: await realpath(projectDir),
      model: "fake/worker",
      parentHistoryIncluded: false,
      extensionsDisabled: true,
      promptTemplatesDisabled: true,
      themesDisabled: true,
      customSystemPromptsDisabled: true,
      agentDefinitionsDisabled: true,
      dispatchBytes: Buffer.byteLength(freshInput.request.prompt, "utf8"),
      dispatchSha256: hashPrompt(freshInput.request.prompt),
    });
    expect(JSON.stringify(bundle.manifest)).not.toContain(freshInput.request.prompt);
    expect(bundle.session.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);
    expect(bundle.session.sessionFile).toContain(join("subagents", freshInput.parentSessionId));
    expect(bundle.session.sessionManager.getSessionName()).toBe(freshInput.request.description);

    await bundle.session.prompt(freshInput.request.prompt);

    expect(fake.contexts).toHaveLength(1);
    expect(fake.contexts[0]?.tools?.map((tool) => tool.name)).toEqual(["read", "bash", "edit", "write"]);
    expect(fake.contexts[0]?.systemPrompt).toContain("PROJECT_CHILD_RULE");
    expect(fake.contexts[0]?.systemPrompt).toContain("CLAUDE_CHILD_RULE");
    expect(fake.contexts[0]?.systemPrompt).not.toContain("FORBIDDEN_SYSTEM_OVERRIDE");
    expect(fake.contexts[0]?.systemPrompt).not.toContain("FORBIDDEN_APPENDED_SYSTEM");
    expect(fake.contexts[0]?.systemPrompt).not.toContain("ROOT_SYSTEM_FILE_SHOULD_NOT_LOAD");
    expect(fake.contexts[0]?.systemPrompt).not.toContain("FORBIDDEN_AGENT_DEFINITION");
    expect(JSON.stringify(fake.contexts[0]?.messages)).toContain(artifactPath);
    expect(JSON.stringify(fake.contexts[0]?.messages)).not.toContain("PARENT_SECRET");
    expect(JSON.stringify(fake.contexts[0]?.messages)).not.toContain("ARTIFACT_NOT_INLINED");
  });

  it("reopens the recorded child branch with the original identity resources and model", async () => {
    const { factory, freshInput, fake } = await createFixture(["Status: DONE", "Status: DONE"]);
    const first = await factory.createFresh(freshInput);
    await first.session.prompt(freshInput.request.prompt);
    const record = completedRecord(first);
    first.session.dispose();

    const resumePrompt = "Fix the review findings from /tmp/review.md";
    const resumed = await factory.reopen({
      parentCwd: freshInput.parentCwd,
      record,
      prompt: resumePrompt,
      projectTrusted: true,
    });
    track(resumed.session);

    expect(resumed.session.sessionFile).toBe(record.sessionFile);
    expect(resumed.session.thinkingLevel).toBe(record.thinkingLevel);
    expect(resumed.manifest).toMatchObject({
      cwd: record.cwd,
      model: record.model,
      thinkingLevel: record.thinkingLevel,
      dispatchSha256: hashPrompt(resumePrompt),
    });

    await resumed.session.prompt(resumePrompt);

    expect(fake.contexts).toHaveLength(2);
    const resumedMessages = JSON.stringify(fake.contexts[1]?.messages);
    expect(resumedMessages).toContain(freshInput.request.prompt);
    expect(resumedMessages).toContain("Status: DONE");
    expect(resumedMessages).toContain(resumePrompt);
    expect(resumedMessages).not.toContain("PARENT_SECRET");
  });

  it("rejects untrusted projects before creating a child", async () => {
    const { factory, freshInput } = await createFixture([]);

    await expect(factory.createFresh({ ...freshInput, projectTrusted: false })).rejects.toThrow("trusted project");
  });

  it("rejects a cwd outside the controller trusted root", async () => {
    const { factory, freshInput, tempDir } = await createFixture([]);
    const outside = join(tempDir, "outside");
    await mkdir(outside);

    await expect(
      factory.createFresh({
        ...freshInput,
        request: { ...freshInput.request, cwd: outside },
      }),
    ).rejects.toThrow("outside trusted root");
  });

  it("rejects silent thinking-level clamping", async () => {
    const { factory, freshInput } = await createFixture([]);

    await expect(
      factory.createFresh({
        ...freshInput,
        request: { ...freshInput.request, model: "fake/worker:high" },
      }),
    ).rejects.toThrow("Thinking level high is unsupported by fake/worker");
  });

  it("rejects resume without a persisted session leaf and context manifest", async () => {
    const { factory, freshInput } = await createFixture([]);
    const validRecord: AgentRecord = {
      id: "sa_1234abcd",
      description: "implement task one",
      cwd: freshInput.parentCwd,
      model: "fake/worker",
      thinkingLevel: "off",
      state: "completed",
      sessionFile: "/tmp/child.jsonl",
      childLeafId: "leaf_done",
      manifest: {
        cwd: freshInput.parentCwd,
        model: "fake/worker",
        thinkingLevel: "off",
        tools: ["read", "bash", "edit", "write"],
        contextFiles: [],
        skills: [],
        parentHistoryIncluded: false,
        extensionsDisabled: true,
        promptTemplatesDisabled: true,
        themesDisabled: true,
        customSystemPromptsDisabled: true,
        agentDefinitionsDisabled: true,
        dispatchBytes: 1,
        dispatchSha256: "a".repeat(64),
      },
      createdAt: 100,
      updatedAt: 200,
      runs: [],
    };
    const noSessionRecord = structuredClone(validRecord);
    delete noSessionRecord.sessionFile;
    const noLeafRecord = structuredClone(validRecord);
    delete noLeafRecord.childLeafId;
    const noManifestRecord = structuredClone(validRecord);
    delete noManifestRecord.manifest;
    const reopenBase = {
      parentCwd: freshInput.parentCwd,
      prompt: "continue",
      projectTrusted: true,
    };

    for (const record of [noSessionRecord, noLeafRecord, noManifestRecord]) {
      await expect(factory.reopen({ ...reopenBase, record })).rejects.toThrow(
        "Cannot resume subagent without a persisted session, child leaf, and context manifest",
      );
    }
  });
});
