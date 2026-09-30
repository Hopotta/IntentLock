import { access } from "node:fs/promises";
import { delimiter, extname, join, resolve } from "node:path";
import { parseDocument } from "yaml";
import { ContractError } from "./contract/errors.js";
import { validateContract, validateContractPath } from "./contract/schema.js";
import { discoverRepository } from "./git/repository.js";
import { readCurrentFile } from "./git/snapshot.js";
import { resolveBase } from "./git/base.js";
import { gitText } from "./git/process.js";

export type DiagnosticStatus = "pass" | "fail" | "warn";
export interface Diagnostic {
  id: string;
  status: DiagnosticStatus;
  message: string;
}
export interface DoctorResult {
  repositoryRoot?: string;
  contractPath?: string;
  base?: string;
  diagnostics: Diagnostic[];
  exitCode: 0 | 2;
}
export interface DoctorOptions {
  cwd?: string;
  base?: string;
  contract?: string;
}

function executableNames(name: string): string[] {
  if (process.platform !== "win32") return [name];
  const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean);
  return extname(name)
    ? [name]
    : [name, ...extensions.map((suffix) => `${name}${suffix.toLowerCase()}`)];
}

async function executableAvailable(name: string): Promise<boolean> {
  if (!name || name.includes(" ") || name.includes("/") || name.includes("\\"))
    return false;
  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    for (const candidate of executableNames(name)) {
      try {
        await access(join(entry, candidate));
        return true;
      } catch {
        // Continue searching PATH.
      }
    }
  }
  return false;
}

function commandExecutable(command: string): string {
  const first = command.trim().match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  return first?.[1] ?? first?.[2] ?? first?.[3] ?? "";
}

/** Diagnose repository readiness without invoking configured verifier commands. */
export async function diagnoseRepository(
  options: DoctorOptions = {},
): Promise<DoctorResult> {
  const diagnostics: Diagnostic[] = [];
  try {
    gitText(["--version"], options.cwd ?? process.cwd());
    diagnostics.push({
      id: "git",
      status: "pass",
      message: "Git is available.",
    });
  } catch (error) {
    diagnostics.push({
      id: "git",
      status: "fail",
      message: error instanceof Error ? error.message : String(error),
    });
    return { diagnostics, exitCode: 2 };
  }
  let repository;
  try {
    repository = discoverRepository(options.cwd);
    diagnostics.push({
      id: "git-repository",
      status: "pass",
      message: `Git repository found at ${repository.root}.`,
    });
  } catch (error) {
    diagnostics.push({
      id: "git-repository",
      status: "fail",
      message: error instanceof Error ? error.message : String(error),
    });
    return { diagnostics, exitCode: 2 };
  }

  let relativeContractPath: string;
  try {
    relativeContractPath = validateContractPath(
      options.contract ?? ".intentlock.yml",
    );
  } catch (error) {
    diagnostics.push({
      id: "contract-schema",
      status: "fail",
      message: error instanceof Error ? error.message : String(error),
    });
    return { repositoryRoot: repository.root, diagnostics, exitCode: 2 };
  }
  const contractPath = resolve(
    repository.root,
    ...relativeContractPath.split("/"),
  );
  let contract;
  try {
    const bytes = await readCurrentFile(repository, relativeContractPath);
    if (bytes === undefined) {
      throw new ContractError(
        "missing_contract",
        `No contract found at ${relativeContractPath}.`,
      );
    }
    const text = bytes.toString("utf8");
    const document = parseDocument(text, {
      uniqueKeys: true,
      prettyErrors: false,
    });
    if (document.errors.length)
      throw new ContractError(
        "invalid_yaml",
        "Contract YAML is invalid.",
        document.errors.map((item) => item.message),
      );
    contract = validateContract(document.toJS());
    diagnostics.push({
      id: "contract-schema",
      status: "pass",
      message: `Contract schema is valid (${contractPath}).`,
    });
  } catch (error) {
    diagnostics.push({
      id: "contract-schema",
      status: "fail",
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      repositoryRoot: repository.root,
      contractPath,
      diagnostics,
      exitCode: 2,
    };
  }

  const base = options.base ?? contract.defaults?.base ?? "main";
  try {
    resolveBase(repository, base);
    diagnostics.push({
      id: "base",
      status: "pass",
      message: `Base ref "${base}" resolves and has a merge base with HEAD.`,
    });
  } catch (error) {
    diagnostics.push({
      id: "base",
      status: "fail",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const manifests = [
    ...new Set(
      contract.invariants.flatMap((item) =>
        item.type === "dependency_policy" ? item.manifests : [],
      ),
    ),
  ];
  for (const manifest of manifests) {
    try {
      await access(join(repository.root, ...manifest.split("/")));
      diagnostics.push({
        id: `manifest:${manifest}`,
        status: "pass",
        message: `Manifest is available: ${manifest}.`,
      });
    } catch {
      diagnostics.push({
        id: `manifest:${manifest}`,
        status: "fail",
        message: `Manifest is missing: ${manifest}.`,
      });
    }
  }

  for (const invariant of contract.invariants) {
    if (invariant.type !== "command") continue;
    const executable = commandExecutable(invariant.run);
    const available = await executableAvailable(executable);
    diagnostics.push({
      id: `command:${invariant.id}`,
      status: available ? "pass" : "warn",
      message: available
        ? `Command executable "${executable}" is present on PATH; command was not run.`
        : `Command executable "${executable || "(unrecognized)"}" was not found on PATH; command was not run.`,
    });
  }

  return {
    repositoryRoot: repository.root,
    contractPath,
    base,
    diagnostics,
    exitCode: diagnostics.some((item) => item.status === "fail") ? 2 : 0,
  };
}
