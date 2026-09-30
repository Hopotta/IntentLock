export type VerificationStatus = "pass" | "fail" | "warn" | "skip" | "error";
export type VerificationSeverity = "error" | "warn";
export type OverallStatus = "pass" | "fail" | "warn" | "error";

export interface EvidenceItem {
  kind: string;
  [key: string]: unknown;
}

export interface VerificationResult {
  invariantId: string;
  type: string;
  status: VerificationStatus;
  severity: VerificationSeverity;
  summary: string;
  evidence: EvidenceItem[];
  durationMs: number;
}

export interface VerificationSummary {
  passed: number;
  failed: number;
  warnings: number;
  errors: number;
  skipped: number;
}

export interface VerificationReport {
  status: OverallStatus;
  results: VerificationResult[];
  summary: VerificationSummary;
  exitCode: 0 | 1 | 2;
}

export function createVerificationSummary(
  results: VerificationResult[],
): VerificationSummary {
  return results.reduce<VerificationSummary>(
    (summary, result) => {
      switch (result.status) {
        case "pass":
          summary.passed += 1;
          break;
        case "fail":
          summary.failed += 1;
          break;
        case "warn":
          summary.warnings += 1;
          break;
        case "error":
          summary.errors += 1;
          break;
        case "skip":
          summary.skipped += 1;
          break;
      }
      return summary;
    },
    { passed: 0, failed: 0, warnings: 0, errors: 0, skipped: 0 },
  );
}

export function aggregateResults(
  results: VerificationResult[],
  failOnWarn = false,
): VerificationReport {
  const summary = createVerificationSummary(results);
  const status: OverallStatus =
    summary.errors > 0
      ? "error"
      : results.some(
            (result) => result.status === "fail" && result.severity === "error",
          )
        ? "fail"
        : summary.warnings > 0 ||
            (failOnWarn &&
              results.some(
                (result) =>
                  result.status === "fail" && result.severity === "warn",
              ))
          ? "warn"
          : "pass";

  const exitCode =
    status === "error"
      ? 2
      : status === "fail" || (failOnWarn && status === "warn")
        ? 1
        : 0;

  return { status, results, summary, exitCode };
}
