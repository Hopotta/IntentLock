export { resolveBase } from "./base.js";
export type { ResolvedBase } from "./base.js";
export { normalizeGitPath, resolveRepositoryPath } from "./paths.js";
export { discoverRepository } from "./repository.js";
export type { GitRepository } from "./repository.js";
export {
  collectChangedFiles,
  createGitSnapshot,
  hasChangedPath,
  readBaselineFile,
  readCurrentFile,
} from "./snapshot.js";
export type {
  ChangedFile,
  ChangedFileStatus,
  GitSnapshot,
} from "./snapshot.js";
