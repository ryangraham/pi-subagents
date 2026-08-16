import { execFile as execFileCallback } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

async function canonicalDirectory(path: string, label: string): Promise<string> {
  const canonical = await realpath(path);
  const details = await stat(canonical);
  if (!details.isDirectory()) throw new Error(`${label} is not a directory: ${canonical}`);
  return canonical;
}

async function trustedRoot(canonicalParent: string): Promise<string> {
  try {
    const { stdout } = await execFile("git", ["-C", canonicalParent, "rev-parse", "--show-toplevel"]);
    return canonicalDirectory(stdout.trim(), "Git root");
  } catch {
    return canonicalParent;
  }
}

export async function resolveTrustedCwd(parentCwd: string, requestedCwd?: string): Promise<string> {
  const canonicalParent = await canonicalDirectory(parentCwd, "Controller cwd");
  const candidatePath = requestedCwd === undefined ? canonicalParent : resolve(parentCwd, requestedCwd);
  const candidate = await canonicalDirectory(candidatePath, "Requested cwd");
  const root = await trustedRoot(canonicalParent);
  const fromRoot = relative(root, candidate);

  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`Requested cwd is outside trusted root: ${candidate}`);
  }

  return candidate;
}
