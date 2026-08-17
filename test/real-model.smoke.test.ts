import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { AgentManager } from "../src/agent-manager.ts";
import { AgentRegistry } from "../src/registry.ts";
import { SessionFactory } from "../src/session-factory.ts";

const execFile = promisify(execFileCallback);
const smokeModel = process.env.PI_SUBAGENTS_SMOKE_MODEL?.trim();
const smokeSuite = smokeModel ? describe : describe.skip;

smokeSuite("credentialed real-model smoke", () => {
  it("dispatches one isolated child through the production SDK path", async () => {
    if (!smokeModel) throw new Error("PI_SUBAGENTS_SMOKE_MODEL is required");
    const projectDir = await mkdtemp(join(tmpdir(), "pi-subagents-real-smoke-"));
    const agentDir = getAgentDir();
    const parentSessionId = `smoke_${randomUUID()}`;
    const childSessionDir = join(agentDir, "subagents", parentSessionId);
    let manager: AgentManager | undefined;

    try {
      await execFile("git", ["init", "-q", projectDir]);
      const runtime = await ModelRuntime.create({ allowModelNetwork: false });
      manager = new AgentManager({
        factory: new SessionFactory(agentDir, runtime),
        registry: AgentRegistry.fromEvents([], () => undefined),
      });
      const result = await manager.run(
        {
          description: "real model smoke",
          prompt: "Reply with exactly: SMOKE_OK",
          model: smokeModel,
        },
        {
          parentSessionId,
          cwd: projectDir,
          projectTrusted: true,
          mode: "tui",
        },
        AbortSignal.timeout(120_000),
      );

      expect(result.outcome.finalText).toContain("SMOKE_OK");
    } finally {
      try {
        await manager?.shutdown();
      } finally {
        await Promise.all([
          rm(projectDir, { recursive: true, force: true }),
          rm(childSessionDir, { recursive: true, force: true }),
        ]);
      }
    }
  }, 150_000);
});
