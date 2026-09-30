import { gitText } from "./process.js";
import type { GitRepository } from "./repository.js";

export interface ResolvedBase {
  requestedBase: string;
  baseCommit: string;
  headCommit: string;
  mergeBaseCommit: string;
}

export function resolveBase(
  repository: GitRepository,
  requestedBase: string,
): ResolvedBase {
  if (!requestedBase.trim()) throw new Error("Base ref must not be empty");
  const baseCommit = gitText(
    ["rev-parse", "--verify", "--end-of-options", `${requestedBase}^{commit}`],
    repository.root,
  ).trim();
  const headCommit = gitText(
    ["rev-parse", "--verify", "HEAD^{commit}"],
    repository.root,
  ).trim();
  const mergeBaseCommit = gitText(
    ["merge-base", baseCommit, headCommit],
    repository.root,
  ).trim();
  if (!mergeBaseCommit)
    throw new Error(`No merge base exists for ${requestedBase} and HEAD`);
  return { requestedBase, baseCommit, headCommit, mergeBaseCommit };
}
