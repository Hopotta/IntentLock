import { rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGitSnapshot,
  discoverRepository,
  readBaselineFile,
  readCurrentFile,
  resolveBase,
} from "../src/git/index.js";
import { createTestGitRepo, type TestGitRepo } from "./helpers/git-repo.js";

const repositories: TestGitRepo[] = [];

async function newRepo(): Promise<TestGitRepo> {
  const repo = await createTestGitRepo();
  repositories.push(repo);
  return repo;
}

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repo) => repo.cleanup()));
});

describe("Git snapshot", () => {
  it("discovers the repository root when called from a nested directory", async () => {
    const repo = await newRepo();
    await repo.write("nested/deeper/file.txt", "initial\n");
    repo.commit("initial");
    const nested = join(repo.root, "nested", "deeper");
    const discovered = discoverRepository(nested);

    expect(discovered.root).toBe(resolve(repo.root));
  });

  it("resolves the requested base commit and merge base", async () => {
    const repo = await newRepo();
    await repo.write("base.txt", "base\n");
    const base = repo.commit("base");
    repo.git("checkout", "-b", "feature");
    await repo.write("feature.txt", "feature\n");
    repo.commit("feature");
    repo.git("checkout", "main");
    await repo.write("main.txt", "main\n");
    const main = repo.commit("main");
    repo.git("checkout", "feature");

    const resolved = resolveBase(discoverRepository(repo.root), "main");
    expect(resolved.baseCommit).toBe(main);
    expect(resolved.mergeBaseCommit).toBe(base);
    expect(resolved.headCommit).toBe(repo.git("rev-parse", "HEAD"));
  });

  it("returns an empty list for a clean repository", async () => {
    const repo = await newRepo();
    await repo.write("file.txt", "baseline\n");
    const base = repo.commit("baseline");

    expect(
      createGitSnapshot(discoverRepository(repo.root), base).changedFiles,
    ).toEqual([]);
  });

  it("collects committed, staged, unstaged, and untracked changes", async () => {
    const repo = await newRepo();
    await repo.write("committed.txt", "v1\n");
    await repo.write("staged.txt", "v1\n");
    await repo.write("unstaged.txt", "v1\n");
    await repo.write("tracked.txt", "v1\n");
    const base = repo.commit("baseline");

    await repo.write("committed.txt", "v2\n");
    repo.commit("committed change");
    await repo.write("staged.txt", "v2\n");
    repo.git("add", "staged.txt");
    await repo.write("unstaged.txt", "v2\n");
    await repo.write("new file.txt", "new\n");
    await repo.write("ignored.log", "ignored\n");
    await repo.write(".gitignore", "*.log\n");

    const snapshot = createGitSnapshot(discoverRepository(repo.root), base);
    expect(snapshot.changedFiles).toEqual(
      expect.arrayContaining([
        { status: "modified", path: "committed.txt" },
        { status: "modified", path: "staged.txt" },
        { status: "modified", path: "unstaged.txt" },
        { status: "added", path: ".gitignore" },
        { status: "added", path: "new file.txt" },
      ]),
    );
    expect(
      snapshot.changedFiles.some((file) => file.path === "ignored.log"),
    ).toBe(false);
  });

  it("reports deleted files and both paths for detected renames", async () => {
    const repo = await newRepo();
    await repo.write("deleted.txt", "delete me\n");
    await repo.write("before.txt", "rename me\n");
    const base = repo.commit("baseline");

    await rm(join(repo.root, "deleted.txt"));
    repo.git("mv", "before.txt", "after.txt");

    const changed = createGitSnapshot(
      discoverRepository(repo.root),
      base,
    ).changedFiles;
    expect(changed).toContainEqual({ status: "deleted", path: "deleted.txt" });
    expect(changed).toContainEqual({
      status: "renamed",
      oldPath: "before.txt",
      path: "after.txt",
    });
  });

  it("reads baseline and current bytes and returns missing for new or deleted files", async () => {
    const repo = await newRepo();
    await repo.write("existing.txt", "baseline content\n");
    await repo.write("deleted.txt", "will disappear\n");
    const base = repo.commit("baseline");
    const repository = discoverRepository(repo.root);

    await repo.write("existing.txt", "current content\n");
    await repo.write("new.txt", "new current\n");
    await rm(join(repo.root, "deleted.txt"));

    expect(readBaselineFile(repository, base, "existing.txt")?.toString()).toBe(
      "baseline content\n",
    );
    expect(readBaselineFile(repository, base, "new.txt")).toBeUndefined();
    expect(
      (await readCurrentFile(repository, "existing.txt"))?.toString(),
    ).toBe("current content\n");
    expect(await readCurrentFile(repository, "new.txt")).toEqual(
      Buffer.from("new current\n"),
    );
    expect(await readCurrentFile(repository, "deleted.txt")).toBeUndefined();
  });

  it("normalizes Windows separators and rejects paths outside the repository", async () => {
    const repo = await newRepo();
    await repo.write("nested/file.txt", "content\n");
    const base = repo.commit("baseline");
    const repository = discoverRepository(repo.root);

    expect(
      readBaselineFile(repository, base, "nested\\file.txt")?.toString(),
    ).toBe("content\n");
    await expect(readCurrentFile(repository, "../outside.txt")).rejects.toThrow(
      /repository/,
    );
  });

  it("refuses to read a current symlink that escapes the repository", async () => {
    const repo = await newRepo();
    await repo.write("tracked.txt", "safe\n");
    repo.commit("baseline");
    const outside = join(repo.root, "..", "intentlock-outside-test.txt");
    await writeFile(outside, "outside");
    try {
      await symlink(outside, join(repo.root, "escape.txt"));
    } catch (error) {
      await rm(outside, { force: true });
      if (error instanceof Error && "code" in error && error.code === "EPERM")
        return;
      throw error;
    }
    try {
      await expect(
        readCurrentFile(discoverRepository(repo.root), "escape.txt"),
      ).rejects.toThrow(/outside/);
    } finally {
      await rm(outside, { force: true });
    }
  });
});
