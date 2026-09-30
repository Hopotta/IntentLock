import type { Invariant } from "../contract/schema.js";
import type { VerificationContext } from "./context.js";
import type { VerificationResult } from "./result.js";

export interface Verifier {
  type: string;
  verify(
    invariant: Invariant,
    context: VerificationContext,
  ): Promise<VerificationResult>;
}
