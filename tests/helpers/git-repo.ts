import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface TestGitRepo {
  root: string;
  git(...args: string[]): string;
  write(path: string, contents: string): Promise<void>;
  commit(message: string): string;
  cleanup(): Promise<void>;
}

export async function createTestGitRepo(): Promise<TestGitRepo> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "intentlock-git-")));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }).trim();

  git("init", "-b", "main");
  git("config", "user.name", "IntentLock Tests");
  git("config", "user.email", "intentlock-tests@example.invalid");

  return {
    root,
    git,
    async write(path, contents) {
      const fullPath = join(root, ...path.split("/"));
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, contents);
    },
    commit(message) {
      git("add", "--all");
      git("commit", "-m", message, "--allow-empty");
      return git("rev-parse", "HEAD");
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}
