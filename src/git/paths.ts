import { isAbsolute, relative, resolve, sep } from "node:path";

export function normalizeGitPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function resolveRepositoryPath(root: string, path: string): string {
  const normalized = normalizeGitPath(path);
  if (!normalized || normalized.includes("\0") || isAbsolute(normalized)) {
    throw new Error(`Path must be repository-relative: ${path}`);
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => segment === ".." || segment === "")) {
    throw new Error(`Path must stay within the repository: ${path}`);
  }

  const absolute = resolve(root, ...segments);
  const fromRoot = relative(resolve(root), absolute);
  if (
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(`Path must stay within the repository: ${path}`);
  }

  return absolute;
}

export function isPathInside(root: string, candidate: string): boolean {
  const fromRoot = relative(resolve(root), resolve(candidate));
  return (
    fromRoot === "" ||
    (fromRoot !== ".." &&
      !fromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(fromRoot))
  );
}
