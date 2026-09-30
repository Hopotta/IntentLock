import picomatch from "picomatch";
import type { Invariant } from "../contract/schema.js";
import type { VerificationContext } from "../engine/context.js";
import type { VerificationResult } from "../engine/result.js";
import type { Verifier } from "../engine/verifier.js";

type FileScopeInvariant = Extract<Invariant, { type: "file_scope" }>;

interface ScopeViolation {
  path: string;
  oldPath?: string;
  reason: "not-allowed" | "denied";
  matchedPatterns: string[];
}

function violatesPath(
  path: string,
  invariant: FileScopeInvariant,
): ScopeViolation | undefined {
  const deniedBy = (invariant.deny ?? []).filter((pattern) =>
    picomatch(pattern, { dot: true })(path),
  );
  if (deniedBy.length > 0) {
    return { path, reason: "denied", matchedPatterns: deniedBy };
  }

  const allowedBy = invariant.allow?.filter((pattern) =>
    picomatch(pattern, { dot: true })(path),
  );
  if (invariant.allow && allowedBy?.length === 0) {
    return {
      path,
      reason: "not-allowed",
      matchedPatterns: invariant.allow,
    };
  }

  return undefined;
}

export const fileScopeVerifier: Verifier = {
  type: "file_scope",
  async verify(invariant, context: VerificationContext) {
    const scope = invariant as FileScopeInvariant;
    const violations: ScopeViolation[] = [];

    for (const file of context.changedFiles) {
      const currentPath = file.path.replaceAll("\\", "/");
      const oldPath = file.oldPath?.replaceAll("\\", "/");
      const paths = [currentPath, ...(oldPath ? [oldPath] : [])];
      for (const path of paths) {
        const violation = violatesPath(path, scope);
        if (violation) {
          violations.push({
            ...violation,
            ...(oldPath ? { oldPath } : {}),
          });
        }
      }
    }

    return {
      invariantId: scope.id,
      type: scope.type,
      status: violations.length > 0 ? "fail" : "pass",
      severity: scope.severity,
      summary:
        violations.length > 0
          ? `${violations.length} changed path${violations.length === 1 ? " violates" : "s violate"} the allowed change scope.`
          : "All changed paths are inside the authorized scope.",
      evidence: violations.map((violation) => ({
        kind: "path_scope_violation",
        ...violation,
      })),
      durationMs: 0,
    } satisfies VerificationResult;
  },
};
