import type { PolicyMetadata } from "../contract/loader.js";
import type { GitSnapshot } from "../git/snapshot.js";
import type { VerificationReport } from "../engine/result.js";

export interface TerminalReportOptions {
  verbose?: boolean;
  toolVersion?: string;
  color?: boolean;
}

function display(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function commandOutput(label: string, value: unknown): string[] {
  const text = String(value ?? "").trim();
  if (!text) return [];
  const limit = 2_000;
  const clipped =
    text.length > limit ? `${text.slice(0, limit)}… [truncated]` : text;
  return [`      ${label}: ${clipped.replaceAll("\n", "\n      ")}`];
}

function paint(text: string, code: number, enabled: boolean): string {
  return enabled ? `\u001b[${code}m${text}\u001b[0m` : text;
}

function evidenceLines(evidence: Record<string, unknown>): string[] {
  switch (evidence.kind) {
    case "path_scope_violation": {
      const reason =
        evidence.reason === "denied" ? "matches deny" : "outside allowed scope";
      const rename = evidence.oldPath ? `${String(evidence.oldPath)} → ` : "";
      return [`      ${rename}${String(evidence.path)} ${reason}`];
    }
    case "dependency_change": {
      const before =
        evidence.baselineVersion === undefined
          ? "(absent)"
          : String(evidence.baselineVersion);
      const after =
        evidence.currentVersion === undefined
          ? "(absent)"
          : String(evidence.currentVersion);
      return [
        `      ${String(evidence.manifest)} ${String(evidence.section)}: ${String(evidence.dependency)} ${before} → ${after}`,
      ];
    }
    case "dependency_manifest_created":
      return [
        `      Dependency manifest created: ${String(evidence.manifest)}`,
      ];
    case "dependency_manifest_error":
    case "structured_value_error":
      return [
        `      ${String(evidence.message ?? "Verification evidence unavailable")}`,
      ];
    case "dependency_evidence_truncated":
      return [
        `      ${String(evidence.omittedCount)} additional dependency changes omitted.`,
      ];
    case "structured_value_diff":
      return [
        `      ${String(evidence.file)} ${String(evidence.selector)}`,
        `      ${display(evidence.baseline)} → ${display(evidence.current)}`,
      ];
    case "command_execution": {
      const lines = [`      $ ${String(evidence.command)}`];
      if (evidence.error) lines.push(`      ${String(evidence.error)}`);
      if (evidence.timed_out) lines.push("      Command timed out.");
      if (evidence.exit_code !== undefined)
        lines.push(`      Exit code: ${String(evidence.exit_code)}`);
      lines.push(...commandOutput("stdout", evidence.stdout));
      lines.push(...commandOutput("stderr", evidence.stderr));
      return lines;
    }
    case "verifier_error":
      return [`      ${String(evidence.message)}`];
    default:
      return [`      Evidence: ${display(evidence)}`];
  }
}

export function renderTerminalReport(
  report: VerificationReport,
  policy: PolicyMetadata,
  snapshot?: GitSnapshot,
  options: TerminalReportOptions = {},
): string {
  const sourceDescription =
    policy.source === "baseline"
      ? "trusted baseline"
      : policy.sourceReason === "worktree-override"
        ? "WORKTREE (untrusted override)"
        : "WORKTREE (baseline contract missing; untrusted)";
  const version = options.toolVersion ?? "0.1.0";
  const color = options.color ?? false;
  const lines = [
    `IntentLock ${version}`,
    `Policy: ${policy.path} (${sourceDescription})`,
  ];

  for (const warning of policy.warnings) lines.push(`WARN  ${warning.message}`);

  if (options.verbose && snapshot) {
    lines.push(
      `Baseline: ${snapshot.mergeBaseCommit} (requested ${snapshot.requestedBase})`,
    );
    lines.push(`Resolved base: ${snapshot.baseCommit}`);
    lines.push(
      `Patch: ${snapshot.changedFiles.length} changed file(s), ${snapshot.untrackedFileCount} untracked`,
    );
  }

  for (const result of report.results) {
    const label =
      result.status === "warn" ? "WARN" : result.status.toUpperCase();
    const colorCode =
      result.status === "pass"
        ? 32
        : result.status === "warn"
          ? 33
          : result.status === "skip"
            ? 36
            : 31;
    lines.push(
      `${paint(label.padEnd(5), colorCode, color)} ${result.invariantId}`,
    );
    if (result.status !== "pass") lines.push(`      ${result.summary}`);
    if (options.verbose && result.status === "pass")
      lines.push(`      ${result.summary}`);
    for (const item of result.evidence) {
      if (result.status === "pass" && item.kind === "command_execution")
        continue;
      lines.push(...evidenceLines(item as Record<string, unknown>));
    }
    if (options.verbose) lines.push(`      ${result.durationMs} ms`);
  }

  const failed = report.summary.failed;
  const warnings = report.summary.warnings;
  const errors = report.summary.errors;
  const problems = [
    ...(errors ? [`${errors} verifier error${errors === 1 ? "" : "s"}`] : []),
    ...(failed
      ? [`${failed} invariant${failed === 1 ? "" : "s"} violated`]
      : []),
  ];
  const detail =
    problems.length > 0
      ? problems.join(", ")
      : warnings
        ? `${warnings} warning${warnings === 1 ? "" : "s"}`
        : "all invariants passed";
  const statusCode =
    report.status === "pass" ? 32 : report.status === "warn" ? 33 : 31;
  lines.push(
    `${paint(`IntentLock ${report.status.toUpperCase()}`, statusCode, color)} — ${detail}.`,
  );

  if (options.verbose && snapshot) {
    lines.push("Changed files:");
    if (snapshot.changedFiles.length === 0) lines.push("  (none)");
    for (const file of snapshot.changedFiles) {
      lines.push(
        `  ${file.status.padEnd(8)} ${file.oldPath ? `${file.oldPath} → ` : ""}${file.path}`,
      );
    }
  }

  return lines.join("\n");
}
