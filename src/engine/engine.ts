import type { Contract, Invariant } from "../contract/schema.js";
import type { VerificationContext } from "./context.js";
import { aggregateResults, type VerificationResult } from "./result.js";
import type { VerifierRegistry } from "./registry.js";

export interface RunVerificationOptions {
  failOnWarn?: boolean;
}

function errorResult(
  invariant: Invariant,
  summary: string,
): VerificationResult {
  return {
    invariantId: invariant.id,
    type: invariant.type,
    status: "error",
    severity: invariant.severity,
    summary,
    evidence: [{ kind: "verifier_error", message: summary }],
    durationMs: 0,
  };
}

/** Execute active contract invariants in their declaration order. */
export async function runVerification(
  contract: Contract,
  context: VerificationContext,
  registry: VerifierRegistry,
  options: RunVerificationOptions = {},
) {
  const results: VerificationResult[] = [];

  for (const invariant of contract.invariants) {
    const verifier = registry.get(invariant.type);
    if (!verifier) {
      results.push(
        errorResult(
          invariant,
          `No verifier is registered for type "${invariant.type}".`,
        ),
      );
      continue;
    }

    const startedAt = performance.now();
    try {
      const returned = await verifier.verify(invariant, context);
      const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
      const status =
        returned.status === "fail" && invariant.severity === "warn"
          ? "warn"
          : returned.status;
      results.push({
        ...returned,
        invariantId: invariant.id,
        type: invariant.type,
        severity: invariant.severity,
        status,
        durationMs,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
      results.push({
        ...errorResult(invariant, `Verifier failed to run: ${detail}`),
        durationMs,
      });
    }
  }

  return aggregateResults(results, options.failOnWarn);
}
