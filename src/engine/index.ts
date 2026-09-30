export { createVerificationContext } from "./context.js";
export type {
  CommandResult,
  CommandRunner,
  CommandRunOptions,
  VerificationContext,
} from "./context.js";
export { runVerification } from "./engine.js";
export type { RunVerificationOptions } from "./engine.js";
export { aggregateResults, createVerificationSummary } from "./result.js";
export type {
  EvidenceItem,
  OverallStatus,
  VerificationReport,
  VerificationResult,
  VerificationSeverity,
  VerificationStatus,
  VerificationSummary,
} from "./result.js";
export { VerifierRegistry, verifierRegistry } from "./registry.js";
export type { Verifier } from "./verifier.js";
