import { loadContract, parseContract } from "./contract/loader.js";
import { ContractError } from "./contract/errors.js";
import { createCommandRunner } from "./commands/runner.js";
import { createVerificationContext } from "./engine/context.js";
import { runVerification } from "./engine/engine.js";
import { VerifierRegistry } from "./engine/registry.js";
import { createGitSnapshot, readCurrentFile } from "./git/snapshot.js";
import { discoverRepository } from "./git/repository.js";
import { registerBuiltInVerifiers } from "./verifiers/index.js";
import type { PolicySourceMode } from "./contract/loader.js";
import { validateContractPath } from "./contract/schema.js";

export class EnvironmentError extends Error {
  readonly name = "EnvironmentError";
}

export interface CheckOptions {
  cwd?: string;
  base?: string;
  contract?: string;
  policySource?: PolicySourceMode;
  failOnWarn?: boolean;
}

export async function checkRepository(options: CheckOptions = {}) {
  let repository;
  let snapshot;
  try {
    repository = discoverRepository(options.cwd);
    const requestedBase = options.base ?? "main";
    try {
      snapshot = createGitSnapshot(repository, requestedBase);
    } catch (error) {
      // A contract may select a non-main default (for example, master). When
      // the conventional bootstrap ref is absent, read only enough of the
      // worktree contract to locate that ref; the policy itself is loaded
      // again from the selected merge base below and remains trusted there.
      if (options.base !== undefined || requestedBase !== "main") throw error;
      const contractPath = validateContractPath(
        options.contract ?? ".intentlock.yml",
      );
      const currentBytes = await readCurrentFile(repository, contractPath);
      if (currentBytes === undefined) throw error;
      const bootstrapContract = parseContract(
        currentBytes.toString("utf8"),
        contractPath,
      );
      const fallbackBase = bootstrapContract.defaults?.base;
      if (!fallbackBase || fallbackBase === requestedBase) throw error;
      snapshot = createGitSnapshot(repository, fallbackBase);
    }
  } catch (error) {
    if (error instanceof ContractError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new EnvironmentError(detail, { cause: error });
  }

  let loaded;
  try {
    loaded = await loadContract(repository, snapshot.mergeBaseCommit, {
      contractPath: options.contract,
      policySource: options.policySource,
    });
    // Start from main so a baseline contract can be loaded before applying its
    // base default. A second load preserves the first source: trusted policy
    // must remain baseline-backed, and worktree policy must remain untrusted.
    const defaultBase =
      options.base === undefined ? loaded.contract.defaults?.base : undefined;
    if (defaultBase && defaultBase !== snapshot.requestedBase) {
      const selectedPolicySource = loaded.policy.source;
      snapshot = createGitSnapshot(repository, defaultBase);
      loaded = await loadContract(repository, snapshot.mergeBaseCommit, {
        contractPath: options.contract,
        policySource: selectedPolicySource,
      });
    }
  } catch (error) {
    if (error instanceof ContractError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new EnvironmentError(detail, { cause: error });
  }

  const registry = registerBuiltInVerifiers(new VerifierRegistry());
  const commandRunner = createCommandRunner(repository.root);
  const context = createVerificationContext(
    repository,
    snapshot,
    commandRunner,
    loaded.policy.source,
  );
  const verificationReport = await runVerification(
    loaded.contract,
    context,
    registry,
    {
      failOnWarn: options.failOnWarn,
    },
  );
  const policyWarningCount = loaded.policy.warnings.length;
  const report =
    policyWarningCount === 0
      ? verificationReport
      : {
          ...verificationReport,
          status:
            verificationReport.status === "pass"
              ? ("warn" as const)
              : verificationReport.status,
          summary: {
            ...verificationReport.summary,
            warnings: verificationReport.summary.warnings + policyWarningCount,
          },
          exitCode:
            options.failOnWarn &&
            verificationReport.status !== "error" &&
            verificationReport.status !== "fail"
              ? (1 as const)
              : verificationReport.exitCode,
        };
  return { report, policy: loaded.policy, snapshot };
}
