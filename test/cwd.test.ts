import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveTrustedCwd } from "../src/cwd.ts";

const execFile = promisify(execFileCallback);

let tempDir: string;
let projectDir: string;
let nestedDir: string;
let siblingDir: string;
let prefixSiblingDir: string;
let escapeLink: string;
let nonGitDir: string;
let nestedNonGitDir: string;
let regularFile: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-subagents-cwd-"));
  projectDir = join(tempDir, "project");
  nestedDir = join(projectDir, "nested", "deep");
  siblingDir = join(tempDir, "sibling");
  prefixSiblingDir = join(tempDir, "project-escape");
  escapeLink = join(projectDir, "escape-link");
  nonGitDir = join(tempDir, "plain");
  nestedNonGitDir = join(nonGitDir, "nested");
  regularFile = join(projectDir, "file.txt");

  await Promise.all([
    mkdir(nestedDir, { recursive: true }),
    mkdir(siblingDir, { recursive: true }),
    mkdir(prefixSiblingDir, { recursive: true }),
    mkdir(nestedNonGitDir, { recursive: true }),
  ]);
  await execFile("git", ["init", "-q", projectDir]);
  await symlink(siblingDir, escapeLink);
  await writeFile(regularFile, "not a directory", "utf8");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("resolveTrustedCwd", () => {
  it("defaults to the canonical controller cwd", async () => {
    await expect(resolveTrustedCwd(projectDir)).resolves.toBe(await realpath(projectDir));
  });

  it("accepts a nested directory in the same git worktree", async () => {
    await expect(resolveTrustedCwd(projectDir, nestedDir)).resolves.toBe(await realpath(nestedDir));
  });

  it("resolves a relative override against the controller cwd", async () => {
    await expect(resolveTrustedCwd(projectDir, join("nested", "deep"))).resolves.toBe(await realpath(nestedDir));
  });

  it("rejects a sibling directory", async () => {
    await expect(resolveTrustedCwd(projectDir, siblingDir)).rejects.toThrow("outside trusted root");
  });

  it("rejects a sibling whose name only shares the trusted-root prefix", async () => {
    await expect(resolveTrustedCwd(projectDir, prefixSiblingDir)).rejects.toThrow("outside trusted root");
  });

  it("rejects a symlink that escapes the trusted root", async () => {
    await expect(resolveTrustedCwd(projectDir, escapeLink)).rejects.toThrow("outside trusted root");
  });

  it("uses controller cwd as the boundary outside git", async () => {
    await expect(resolveTrustedCwd(nonGitDir, nestedNonGitDir)).resolves.toBe(await realpath(nestedNonGitDir));
    await expect(resolveTrustedCwd(nonGitDir, siblingDir)).rejects.toThrow("outside trusted root");
  });

  it("rejects a nonexistent path", async () => {
    await expect(resolveTrustedCwd(projectDir, join(projectDir, "missing"))).rejects.toThrow();
  });

  it("rejects a regular file", async () => {
    await expect(resolveTrustedCwd(projectDir, regularFile)).rejects.toThrow("not a directory");
  });
});
