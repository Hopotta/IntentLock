import { resolve } from "node:path";
import { gitText } from "./process.js";

export interface GitRepository {
  root: string;
}

export function discoverRepository(cwd: string = process.cwd()): GitRepository {
  const discoveredRoot = gitText(["rev-parse", "--show-toplevel"], cwd).trim();
  if (!discoveredRoot)
    throw new Error(`Could not determine Git repository root from ${cwd}`);
  return { root: resolve(discoveredRoot) };
}
