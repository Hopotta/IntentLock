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
  stderr: string,
): boolean {
  const leadingExecutable = command
    .trim()
    .match(/^(?:"([^"]+)"|'([^']+)'|([^\s"'|&<>]+))/);
  const executable =
    leadingExecutable?.[1] ?? leadingExecutable?.[2] ?? leadingExecutable?.[3];
  const escapedExecutable = executable?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const localizedWindowsMissingCommand =
    escapedExecutable !== undefined &&
    new RegExp(
      `^['"]?${escapedExecutable}['"]?\\s+�{5}[^\\r\\n]+\\r?\\n�{6,}[^\\r\\n]*\\r?\\n?$`,
    ).test(stderr);
  const namedUnixMissingCommand =
    escapedExecutable !== undefined &&
    new RegExp(
      `(?:^|[\\s:])['"]?${escapedExecutable}['"]?:\\s*(?:command\\s+)?not found\\b|command not found:\\s*['"]?${escapedExecutable}['"]?`,
      "im",
    ).test(stderr);
  const namedWindowsMissingCommand =
    escapedExecutable !== undefined &&
    new RegExp(
      `['"]?${escapedExecutable}['"]?\\s+is not recognized as (?:an internal or external command|the name of a cmdlet)`,
      "i",
    ).test(stderr);
  if (exitCode === 9009) return true;
  if (exitCode === 127) return namedUnixMissingCommand;
  if (exitCode === 1)
    return namedWindowsMissingCommand || localizedWindowsMissingCommand;
  return false;
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
