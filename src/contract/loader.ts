import { parseDocument } from "yaml";
import type { GitRepository } from "../git/repository.js";
import {
  hasChangedPath,
  readBaselineFile,
  readCurrentFile,
} from "../git/snapshot.js";
import { ContractError } from "./errors.js";
import {
  validateContract,
  validateContractPath,
  type Contract,
} from "./schema.js";

export type PolicySourceMode = "auto" | "baseline" | "worktree";
export type PolicySource = "baseline" | "worktree";

export interface PolicyWarning {
  code: "policy-modified";
  path: string;
  message: string;
}

export interface PolicyMetadata {
  path: string;
  source: PolicySource;
  sourceMode: PolicySourceMode;
  sourceReason: "baseline-exists" | "baseline-missing" | "worktree-override";
  modifiedInPatch: boolean;
  untrusted: boolean;
  warnings: PolicyWarning[];
}

export interface LoadedContract {
  contract: Contract;
  policy: PolicyMetadata;
}

export interface LoadContractOptions {
  contractPath?: string;
  policySource?: PolicySourceMode;
}

function parseContractText(text: string, path: string): Contract {
  let value: unknown;
  try {
    const document = parseDocument(text, {
      uniqueKeys: true,
      prettyErrors: false,
    });
    if (document.errors.length > 0) {
      throw new ContractError(
        "invalid_yaml",
        `Contract YAML is invalid: ${path}`,
        document.errors.map((error) => error.message).sort(),
      );
    }
    value = document.toJS();
  } catch (error) {
    if (error instanceof ContractError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ContractError(
      "invalid_yaml",
      `Contract YAML is invalid: ${path}`,
      [message],
    );
  }

  if (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    typeof value.version === "number" &&
    value.version !== 1
  ) {
    throw new ContractError(
      "unsupported_version",
      `Unsupported contract version ${value.version}; this version of IntentLock supports version 1.`,
    );
  }

  if (
    typeof value === "object" &&
    value !== null &&
    "invariants" in value &&
    Array.isArray(value.invariants)
  ) {
    const knownTypes = new Set([
      "file_scope",
      "dependency_policy",
      "structured_value",
      "command",
    ]);
    for (const [index, invariant] of value.invariants.entries()) {
      if (
        typeof invariant === "object" &&
        invariant !== null &&
        "type" in invariant &&
        typeof invariant.type === "string" &&
        !knownTypes.has(invariant.type)
      ) {
        throw new ContractError(
          "invalid_schema",
          "Contract schema is invalid.",
          [
            `invariants[${index}].type: Unknown verifier type "${invariant.type}".`,
          ],
        );
      }
    }
  }

  return validateContract(value);
}

function bytesEqual(
  left: Buffer | undefined,
  right: Buffer | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.equals(right);
}

export async function loadContract(
  repository: GitRepository,
  baselineCommit: string,
  options: LoadContractOptions = {},
): Promise<LoadedContract> {
  const path = validateContractPath(options.contractPath ?? ".intentlock.yml");
  const sourceMode = options.policySource ?? "auto";
  const baselineBytes = readBaselineFile(repository, baselineCommit, path);
  const currentBytes = await readCurrentFile(repository, path);
  const modifiedInPatch =
    !bytesEqual(baselineBytes, currentBytes) ||
    hasChangedPath(repository, baselineCommit, path);

  let source: PolicySource;
  let sourceReason: PolicyMetadata["sourceReason"];
  if (sourceMode === "worktree") {
    source = "worktree";
    sourceReason = "worktree-override";
  } else if (baselineBytes !== undefined) {
    source = "baseline";
    sourceReason = "baseline-exists";
  } else if (sourceMode === "baseline") {
    throw new ContractError(
      "missing_contract",
      `No baseline contract exists at ${path}.`,
      [
        `Policy source "baseline" requires the contract to exist at the baseline commit.`,
      ],
    );
  } else {
    source = "worktree";
    sourceReason = "baseline-missing";
  }

  const selectedBytes = source === "baseline" ? baselineBytes : currentBytes;
  if (selectedBytes === undefined) {
    throw new ContractError(
      "missing_contract",
      `No contract found at ${path}.`,
      [`The selected policy source "${source}" does not contain this file.`],
    );
  }

  const warnings: PolicyWarning[] = [];
  if (source === "baseline" && modifiedInPatch) {
    warnings.push({
      code: "policy-modified",
      path,
      message: `${path} differs from the trusted baseline policy; the baseline version was used.`,
    });
  }

  return {
    contract: parseContractText(selectedBytes.toString("utf8"), path),
    policy: {
      path,
      source,
      sourceMode,
      sourceReason,
      modifiedInPatch,
      untrusted: source === "worktree",
      warnings,
    },
  };
}

export function parseContract(text: string, path = "<input>"): Contract {
  return parseContractText(text, path);
}
