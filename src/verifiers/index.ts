import { verifierRegistry } from "../engine/registry.js";
import type { VerifierRegistry } from "../engine/registry.js";
import { dependencyPolicyVerifier } from "./dependency-policy.js";
import { commandVerifier } from "./command.js";
import { fileScopeVerifier } from "./file-scope.js";
import { structuredValueVerifier } from "./structured-value.js";

export { dependencyPolicyVerifier } from "./dependency-policy.js";
export { commandVerifier } from "./command.js";
export { fileScopeVerifier } from "./file-scope.js";
export { structuredValueVerifier } from "./structured-value.js";

export function registerBuiltInVerifiers(
  registry: VerifierRegistry = verifierRegistry,
): VerifierRegistry {
  if (!registry.has(fileScopeVerifier.type))
    registry.register(fileScopeVerifier);
  if (!registry.has(dependencyPolicyVerifier.type))
    registry.register(dependencyPolicyVerifier);
  if (!registry.has(structuredValueVerifier.type))
    registry.register(structuredValueVerifier);
  if (!registry.has(commandVerifier.type)) registry.register(commandVerifier);
  return registry;
}
