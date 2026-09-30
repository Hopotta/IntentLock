import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_COMMAND_OUTPUT_BYTES,
} from "../commands/runner.js";
import type { Invariant } from "../contract/schema.js";
import type { VerificationContext } from "../engine/context.js";
import type { EvidenceItem, VerificationResult } from "../engine/result.js";
import type { Verifier } from "../engine/verifier.js";

type CommandInvariant = Extract<Invariant, { type: "command" }>;

function unavailableExit(
  exitCode: number | null,
  command: string,
  stdout: string,
  stderr: string,
): boolean {
  if (exitCode === 127 || exitCode === 9009) return true;
  const bareExecutable = command.trim();
  const isBareExecutable = /^[^\s"'|&<>]+$/.test(bareExecutable);
  return (
    exitCode === 1 &&
    (/command not found|is not recognized as an internal or external command|not recognized as the name of a cmdlet/i.test(
      `${stdout}\n${stderr}`,
    ) ||
      (isBareExecutable && stderr.includes(bareExecutable)))
  );
}

function commandEvidence(
  invariant: CommandInvariant,
  context: VerificationContext,
  details: Record<string, unknown>,
): EvidenceItem {
  return {
    kind: "command_execution",
    command: invariant.run,
    cwd: context.repoRoot,
    policy_source: context.policySource ?? "unknown",
    ...details,
  };
}

function result(
  invariant: CommandInvariant,
  status: VerificationResult["status"],
  summary: string,
  evidence: EvidenceItem[],
): VerificationResult {
  return {
    invariantId: invariant.id,
    type: invariant.type,
    status,
    severity: invariant.severity,
    summary,
    evidence,
    durationMs: 0,
  };
}

export const commandVerifier: Verifier = {
  type: "command",
  async verify(invariant, context) {
    const commandInvariant = invariant as CommandInvariant;
    const timeoutMs =
      (commandInvariant.timeout_seconds ?? DEFAULT_COMMAND_TIMEOUT_MS / 1000) *
      1000;

    let execution;
    try {
      execution = await context.runCommand(commandInvariant.run, {
        cwd: context.repoRoot,
        timeoutMs,
        maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return result(
        commandInvariant,
        "error",
        "Could not start the configured command.",
        [commandEvidence(commandInvariant, context, { error: detail })],
      );
    }

    const evidence = commandEvidence(commandInvariant, context, {
      exit_code: execution.exitCode,
      timed_out: execution.timedOut,
      duration_ms: execution.durationMs,
      stdout: execution.stdout,
      stderr: execution.stderr,
      stdout_truncated: execution.stdoutTruncated ?? false,
      stderr_truncated: execution.stderrTruncated ?? false,
    });

    if (execution.timedOut) {
      return result(
        commandInvariant,
        "error",
        `Command timed out after ${timeoutMs} ms.`,
        [evidence],
      );
    }
    if (
      unavailableExit(
        execution.exitCode,
        commandInvariant.run,
        execution.stdout,
        execution.stderr,
      )
    ) {
      return result(
        commandInvariant,
        "error",
        "The configured command executable is unavailable.",
        [evidence],
      );
    }
    if (execution.exitCode === 0) {
      return result(
        commandInvariant,
        "pass",
        "Command completed successfully.",
        [evidence],
      );
    }
    return result(
      commandInvariant,
      "fail",
      `Command exited with code ${execution.exitCode ?? "unknown"}.`,
      [evidence],
    );
  },
};
