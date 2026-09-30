import type { Verifier } from "./verifier.js";

/** Central, explicit registry of verifier implementations. */
export class VerifierRegistry {
  private readonly verifiers = new Map<string, Verifier>();

  register(verifier: Verifier): this {
    if (!verifier.type.trim()) {
      throw new Error("A verifier type must not be empty.");
    }
    if (this.verifiers.has(verifier.type)) {
      throw new Error(
        `A verifier for type "${verifier.type}" is already registered.`,
      );
    }
    this.verifiers.set(verifier.type, verifier);
    return this;
  }

  get(type: string): Verifier | undefined {
    return this.verifiers.get(type);
  }

  has(type: string): boolean {
    return this.verifiers.has(type);
  }

  types(): string[] {
    return [...this.verifiers.keys()];
  }
}

/** Shared registry populated by built-in verifiers in the next milestone. */
export const verifierRegistry = new VerifierRegistry();
