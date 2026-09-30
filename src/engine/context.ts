import type { ChangedFile, GitSnapshot } from "../git/snapshot.js";
import { readBaselineFile, readCurrentFile } from "../git/snapshot.js";
import type { GitRepository } from "../git/repository.js";

export interface CommandRunOptions {
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  timedOut: boolean;
  durationMs: number;
}

export interface VerificationContext {
  repoRoot: string;
  requestedBase: string;
  baseCommit: string;
  mergeBaseCommit: string;
  /** Identifies whether active command definitions came from trusted baseline policy. */
  policySource?: "baseline" | "worktree";
  changedFiles: ChangedFile[];
  readBaselineFile(path: string): Promise<Buffer | null>;
  readCurrentFile(path: string): Promise<Buffer | null>;
  runCommand(
    command: string,
    options?: CommandRunOptions,
  ): Promise<CommandResult>;
}

export type CommandRunner = VerificationContext["runCommand"];

/** Build one immutable view over the Git snapshot for every verifier to share. */
export function createVerificationContext(
  repository: GitRepository,
  snapshot: GitSnapshot,
  runCommand: CommandRunner = async () => {
    throw new Error(
      "Command execution is not configured for this verification run.",
    );
  },
  policySource?: "baseline" | "worktree",
): VerificationContext {
  return {
    repoRoot: snapshot.repositoryRoot,
    requestedBase: snapshot.requestedBase,
    baseCommit: snapshot.baseCommit,
    mergeBaseCommit: snapshot.mergeBaseCommit,
    policySource,
    changedFiles: snapshot.changedFiles,
    async readBaselineFile(path) {
      return (
        readBaselineFile(repository, snapshot.mergeBaseCommit, path) ?? null
      );
    },
    async readCurrentFile(path) {
      return (await readCurrentFile(repository, path)) ?? null;
    },
    runCommand,
  };
}
