import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { discoverRepository } from "./git/repository.js";

export const STARTER_CONTRACT = `# Add invariants to enforce the boundaries for this repository.
# For schema details, see docs/contract-reference.md.
version: 1

defaults:
  base: main

invariants: []
`;

export interface InitializeOptions {
  cwd?: string;
  force?: boolean;
}

export interface InitializeResult {
  repositoryRoot: string;
  contractPath: string;
  created: boolean;
}

/** Create a deliberately empty starter policy after confirming this is a Git repo. */
export async function initializeRepository(
  options: InitializeOptions = {},
): Promise<InitializeResult> {
  const repository = discoverRepository(options.cwd);
  const contractPath = join(repository.root, ".intentlock.yml");
  try {
    await writeFile(contractPath, STARTER_CONTRACT, {
      encoding: "utf8",
      flag: options.force ? "w" : "wx",
    });
    return { repositoryRoot: repository.root, contractPath, created: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return { repositoryRoot: repository.root, contractPath, created: false };
    }
    throw error;
  }
}
