import { readFile, realpath } from "node:fs/promises";
import { gitBytes, gitText } from "./process.js";
import type { ResolvedBase } from "./base.js";
import type { GitRepository } from "./repository.js";
import {
  isPathInside,
  normalizeGitPath,
  resolveRepositoryPath,
} from "./paths.js";
import { resolveBase } from "./base.js";

export type ChangedFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface ChangedFile {
  status: ChangedFileStatus;
  path: string;
  oldPath?: string;
}

export interface GitSnapshot extends ResolvedBase {
  repositoryRoot: string;
  changedFiles: ChangedFile[];
  untrackedFileCount: number;
}

function countUntrackedFiles(repository: GitRepository): number {
  return gitBytes(
    ["ls-files", "--others", "--exclude-standard", "-z"],
    repository.root,
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean).length;
}

function parseNameStatus(output: Buffer): ChangedFile[] {
  const fields = output.toString("utf8").split("\0");
  const files: ChangedFile[] = [];
  for (let index = 0; index < fields.length;) {
    const statusField = fields[index++];
    if (!statusField) continue;
    const code = statusField[0];
    if (code === "R" || code === "C") {
      const oldPath = fields[index++];
      const path = fields[index++];
      if (oldPath && path) {
        files.push({
          status: "renamed",
          oldPath: normalizeGitPath(oldPath),
          path: normalizeGitPath(path),
        });
      }
      continue;
    }
    const rawPath = fields[index++];
    if (!rawPath) continue;
    const status: ChangedFileStatus =
      code === "A" ? "added" : code === "D" ? "deleted" : "modified";
    files.push({ status, path: normalizeGitPath(rawPath) });
  }
  return files;
}

export function collectChangedFiles(
  repository: GitRepository,
  baseline: string,
): ChangedFile[] {
  const diff = parseNameStatus(
    gitBytes(
      ["diff", "--name-status", "-z", "--find-renames", baseline, "--"],
      repository.root,
    ),
  );

  const seenPaths = new Set(
    diff.flatMap((file) => [
      file.path,
      ...(file.oldPath ? [file.oldPath] : []),
    ]),
  );
  const untracked = gitBytes(
    ["ls-files", "--others", "--exclude-standard", "-z"],
    repository.root,
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map(normalizeGitPath);

  for (const path of untracked) {
    if (!seenPaths.has(path)) diff.push({ status: "added", path });
  }
  return diff.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

/**
 * Report Git-level changes to a tracked path, including mode-only changes.
 * Content comparison alone misses executable-bit and symlink metadata edits,
 * which still count as changes to a trusted policy file.
 */
export function hasChangedPath(
  repository: GitRepository,
  baseline: string,
  path: string,
): boolean {
  resolveRepositoryPath(repository.root, path);
  const normalized = normalizeGitPath(path);
  const staged = gitBytes(
    [
      "diff",
      "--cached",
      "--name-only",
      "--no-renames",
      "-z",
      baseline,
      "--",
      normalized,
    ],
    repository.root,
  );
  const unstaged = gitBytes(
    ["diff", "--name-only", "--no-renames", "-z", "--", normalized],
    repository.root,
  );
  return [staged, unstaged].some((output) =>
    output
      .toString("utf8")
      .split("\0")
      .some((changed) => normalizeGitPath(changed) === normalized),
  );
}

export function createGitSnapshot(
  repository: GitRepository,
  requestedBase: string,
): GitSnapshot {
  const resolved = resolveBase(repository, requestedBase);
  return {
    repositoryRoot: repository.root,
    ...resolved,
    changedFiles: collectChangedFiles(repository, resolved.mergeBaseCommit),
    untrackedFileCount: countUntrackedFiles(repository),
  };
}

export function readBaselineFile(
  repository: GitRepository,
  baseline: string,
  path: string,
): Buffer | undefined {
  resolveRepositoryPath(repository.root, path);
  const normalized = normalizeGitPath(path);
  if (
    !normalized ||
    normalized
      .split("/")
      .some((segment) => segment === ".." || segment === "" || segment === ".")
  ) {
    throw new Error(`Path must be repository-relative: ${path}`);
  }
  gitText(["cat-file", "-e", `${baseline}^{commit}`], repository.root);
  const object = `${baseline}:${normalized}`;
  try {
    gitText(["cat-file", "-e", object], repository.root);
    return gitBytes(["cat-file", "blob", object], repository.root);
  } catch {
    return undefined;
  }
}

export async function readCurrentFile(
  repository: GitRepository,
  path: string,
): Promise<Buffer | undefined> {
  const target = resolveRepositoryPath(repository.root, path);
  try {
    const actual = await realpath(target);
    if (!isPathInside(repository.root, actual)) {
      throw new Error(
        `Refusing to read a path outside the repository: ${path}`,
      );
    }
    return await readFile(actual);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return undefined;
    }
    throw error;
  }
}
