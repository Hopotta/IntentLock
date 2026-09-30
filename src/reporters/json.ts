import type { PolicyMetadata } from "../contract/loader.js";
import type { GitSnapshot } from "../git/snapshot.js";
import type { VerificationReport } from "../engine/result.js";

export const TOOL_VERSION = "0.1.0";
export const REPORT_SCHEMA_VERSION = 1;

export interface JsonReportOptions {
  verbose?: boolean;
  totalDurationMs?: number;
}

export function createJsonReport(
  report: VerificationReport,
  policy: PolicyMetadata,
  snapshot: GitSnapshot,
  options: JsonReportOptions = {},
) {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    toolVersion: TOOL_VERSION,
    status: report.status,
    policy: {
      path: policy.path,
      source: policy.source,
      sourceReason: policy.sourceReason,
      modifiedInPatch: policy.modifiedInPatch,
      untrusted: policy.untrusted,
      warnings: policy.warnings,
    },
    baseline: {
      requested: snapshot.requestedBase,
      resolvedCommit: snapshot.baseCommit,
      mergeBaseCommit: snapshot.mergeBaseCommit,
    },
    patch: {
      changedFileCount: snapshot.changedFiles.length,
      untrackedFileCount: snapshot.untrackedFileCount,
      ...(options.verbose
        ? {
            changedFiles: snapshot.changedFiles.map((file) => ({
              status: file.status,
              path: file.path,
              ...(file.oldPath ? { oldPath: file.oldPath } : {}),
            })),
          }
        : {}),
    },
    results: report.results.map((result) => ({
      invariantId: result.invariantId,
      type: result.type,
      severity: result.severity,
      status: result.status,
      summary: result.summary,
      durationMs: result.durationMs,
      evidence: result.evidence,
    })),
    summary: report.summary,
    ...(options.verbose
      ? { timings: { totalDurationMs: options.totalDurationMs ?? 0 } }
      : {}),
  };
}

export function createJsonError(error: unknown) {
  const isError = error instanceof Error;
  const isContract = isError && error.name === "ContractError";
  const isEnvironment = isError && error.name === "EnvironmentError";
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    toolVersion: TOOL_VERSION,
    status: "error" as const,
    error: {
      kind: isContract
        ? "contract_error"
        : isEnvironment
          ? "environment_error"
          : "internal_error",
      message: isError ? error.message : String(error),
      ...(isContract && "details" in error ? { details: error.details } : {}),
    },
  };
}
