import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkRepository } from "../src/check.js";
import { parseContract } from "../src/contract/index.js";
import { createVerificationContext } from "../src/engine/context.js";
import type { VerificationContext } from "../src/engine/context.js";
import { createGitSnapshot, discoverRepository } from "../src/git/index.js";
import { dependencyPolicyVerifier } from "../src/verifiers/dependency-policy.js";
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

function policy(
  options: {
    additions?: boolean;
    removals?: boolean;
    versionChanges?: boolean;
    sections?: string;
    manifests?: string;
  } = {},
) {
  const sections = options.sections ?? "[dependencies, devDependencies]";
  return parseContract(`version: 1
invariants:
  - id: deps
    type: dependency_policy
    severity: error
    manifests: ${options.manifests ?? "[package.json]"}
    allow_additions: ${options.additions ?? false}
    allow_removals: ${options.removals ?? false}
    allow_version_changes: ${options.versionChanges ?? false}
    sections: ${sections}
`).invariants[0]!;
}

async function run(repo: TestGitRepo, base: string, invariant = policy()) {
  const repository = discoverRepository(repo.root);
  const context = createVerificationContext(
    repository,
    createGitSnapshot(repository, base),
  );
  return dependencyPolicyVerifier.verify(invariant, context);
}

describe("dependency_policy verifier", () => {
  it("fails on an added dependency and reports bounded classification evidence", async () => {
    const repo = await newRepo();
    await repo.write("package.json", JSON.stringify({ dependencies: {} }));
    const base = repo.commit("baseline");
    await repo.write(
      "package.json",
      JSON.stringify({ dependencies: { lodash: "^4.17.21" } }),
    );

    const result = await run(repo, base);

    expect(result.status).toBe("fail");
    expect(result.summary).toContain("1 addition");
    expect(result.evidence).toContainEqual({
      kind: "dependency_change",
      change: "added",
      manifest: "package.json",
      section: "dependencies",
      dependency: "lodash",
      currentVersion: "^4.17.21",
      allowed: false,
    });
  });

  it("detects dependency names that collide with object prototype properties", async () => {
    const repo = await newRepo();
    await repo.write("package.json", '{"dependencies":{}}');
    const base = repo.commit("baseline");
    await repo.write("package.json", '{"dependencies":{"__proto__":"1.0.0"}}');

    const result = await run(repo, base);

    expect(result.status).toBe("fail");
    expect(result.evidence).toContainEqual({
      kind: "dependency_change",
      change: "added",
      manifest: "package.json",
      section: "dependencies",
      dependency: "__proto__",
      currentVersion: "1.0.0",
      allowed: false,
    });
  });

  it("fails on a version change", async () => {
    const repo = await newRepo();
    await repo.write(
      "package.json",
      JSON.stringify({ dependencies: { zod: "^3.23.0" } }),
    );
    const base = repo.commit("baseline");
    await repo.write(
      "package.json",
      JSON.stringify({ dependencies: { zod: "^3.24.0" } }),
    );

    const result = await run(repo, base);

    expect(result.status).toBe("fail");
    expect(result.evidence).toContainEqual(
      expect.objectContaining({
        change: "version_changed",
        dependency: "zod",
        baselineVersion: "^3.23.0",
        currentVersion: "^3.24.0",
      }),
    );
  });

  it("classifies removals and applies the removal policy", async () => {
    const repo = await newRepo();
    await repo.write(
      "package.json",
      JSON.stringify({ dependencies: { lodash: "^4.17.21" } }),
    );
    const base = repo.commit("baseline");
    await repo.write("package.json", JSON.stringify({ dependencies: {} }));

    const result = await run(repo, base, policy({ removals: true }));

    expect(result.status).toBe("pass");
    expect(result.evidence).toContainEqual(
      expect.objectContaining({
        change: "removed",
        dependency: "lodash",
        allowed: true,
      }),
    );
  });

  it("surfaces a newly created manifest and evaluates its dependencies", async () => {
    const repo = await newRepo();
    const base = repo.commit("baseline without manifest");
    await repo.write(
      "package.json",
      JSON.stringify({ dependencies: { lodash: "^4.17.21" } }),
    );

    const result = await run(repo, base);

    expect(result.status).toBe("fail");
    expect(result.evidence).toContainEqual({
      kind: "dependency_manifest_created",
      manifest: "package.json",
    });
    expect(result.evidence).toContainEqual(
      expect.objectContaining({ change: "added", dependency: "lodash" }),
    );
  });

  it("fails with exit code 1 when a baseline-configured manifest is deleted", async () => {
    const repo = await newRepo();
    await repo.write("package.json", JSON.stringify({ dependencies: {} }));
    await repo.write(
      ".intentlock.yml",
      `version: 1\ninvariants:\n  - id: deps\n    type: dependency_policy\n    severity: error\n    manifests: [package.json]\n    allow_additions: false\n    allow_removals: false\n    allow_version_changes: false\n`,
    );
    const base = repo.commit("baseline");
    await rm(join(repo.root, "package.json"));

    const { report } = await checkRepository({ cwd: repo.root, base });

    expect(report.status).toBe("fail");
    expect(report.exitCode).toBe(1);
    expect(report.results[0]?.evidence).toContainEqual(
      expect.objectContaining({
        kind: "dependency_manifest_deleted",
        manifest: "package.json",
        message: expect.stringContaining(
          "Restore it or remove it from the dependency policy",
        ),
        allowed: false,
      }),
    );
  });

  it("returns an error when a configured manifest is missing from both revisions", async () => {
    const repo = await newRepo();
    const base = repo.commit("baseline without manifest");

    const result = await run(repo, base);

    expect(result.status).toBe("error");
    expect(result.evidence).toContainEqual(
      expect.objectContaining({
        kind: "dependency_manifest_error",
        manifest: "package.json",
        message: expect.stringContaining(
          "missing from the baseline and current repository",
        ),
      }),
    );
  });

  it("passes when configured dependency sections are unchanged", async () => {
    const repo = await newRepo();
    const manifest = JSON.stringify({
      dependencies: { zod: "^4.6.5" },
      devDependencies: { vitest: "^3.0.8" },
    });
    await repo.write("package.json", manifest);
    const base = repo.commit("baseline");

    const result = await run(repo, base);

    expect(result.status).toBe("pass");
    expect(result.evidence).toEqual([]);
    expect(result.summary).toBe(
      "Configured dependency manifests are unchanged.",
    );
  });

  it("keeps disallowed changes visible when bounded evidence truncates allowed changes", async () => {
    const repo = await newRepo();
    const baselineDependencies = Object.fromEntries(
      Array.from({ length: 120 }, (_, index) => [
        `allowed-${String(index).padStart(3, "0")}`,
        "^1.0.0",
      ]),
    );
    await repo.write(
      "package.json",
      JSON.stringify({ dependencies: baselineDependencies }),
    );
    const base = repo.commit("baseline with removable dependencies");
    await repo.write(
      "package.json",
      JSON.stringify({ dependencies: { "zzz-disallowed": "^2.0.0" } }),
    );

    const result = await run(repo, base, policy({ removals: true }));

    expect(result.status).toBe("fail");
    expect(result.evidence.length).toBeLessThanOrEqual(100);
    expect(result.evidence).toContainEqual(
      expect.objectContaining({
        kind: "dependency_change",
        change: "added",
        dependency: "zzz-disallowed",
        allowed: false,
      }),
    );
    expect(result.evidence).toContainEqual(
      expect.objectContaining({
        kind: "dependency_evidence_truncated",
        limit: 100,
      }),
    );
  });

  it("prioritizes violations when many configured manifests are newly created", async () => {
    const createdManifests = Array.from(
      { length: 101 },
      (_, index) => `new-${String(index).padStart(3, "0")}.json`,
    );
    const current = new Map<string, Buffer>([
      ["package.json", Buffer.from('{"dependencies":{"lodash":"^4.17.21"}}')],
      ...createdManifests.map((path) => [path, Buffer.from("{}")] as const),
    ]);
    const context = {
      changedFiles: [],
      readBaselineFile: async (path: string) =>
        path === "package.json" ? Buffer.from('{"dependencies":{}}') : null,
      readCurrentFile: async (path: string) => current.get(path) ?? null,
    } as unknown as VerificationContext;

    const result = await dependencyPolicyVerifier.verify(
      policy({
        manifests: JSON.stringify(["package.json", ...createdManifests]),
      }),
      context,
    );

    expect(result.status).toBe("fail");
    expect(result.evidence).toContainEqual(
      expect.objectContaining({
        kind: "dependency_change",
        dependency: "lodash",
        allowed: false,
      }),
    );
    expect(result.evidence).toContainEqual(
      expect.objectContaining({
        kind: "dependency_evidence_truncated",
        limit: 100,
      }),
    );
  });

  it("returns an error for malformed JSON instead of treating it as a violation", async () => {
    const repo = await newRepo();
    await repo.write("package.json", JSON.stringify({ dependencies: {} }));
    const base = repo.commit("baseline");
    await repo.write("package.json", "{ invalid json");

    const result = await run(repo, base);

    expect(result.status).toBe("error");
    expect(result.evidence[0]).toMatchObject({
      kind: "dependency_manifest_error",
    });
  });

  it("preserves known violations when another configured manifest is malformed", async () => {
    const repo = await newRepo();
    await repo.write("package.json", '{"dependencies":{}}');
    await repo.write("other.json", '{"dependencies":{}}');
    const base = repo.commit("baseline");
    await repo.write("package.json", '{"dependencies":{"lodash":"^4.17.21"}}');
    await repo.write("other.json", "{ invalid json");

    const result = await run(
      repo,
      base,
      policy({ manifests: "[package.json, other.json]" }),
    );

    expect(result.status).toBe("error");
    expect(result.evidence).toContainEqual(
      expect.objectContaining({
        kind: "dependency_change",
        dependency: "lodash",
        allowed: false,
      }),
    );
    expect(result.evidence).toContainEqual(
      expect.objectContaining({
        kind: "dependency_manifest_error",
        manifest: "other.json",
      }),
    );
  });
});
