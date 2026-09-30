import { afterEach, describe, expect, it } from "vitest";
import {
  ContractError,
  loadContract,
  parseContract,
  validateContractPath,
} from "../src/contract/index.js";
import { discoverRepository } from "../src/git/index.js";
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

const completeContract = `version: 1
project:
  name: IntentLock test
defaults:
  base: main
invariants:
  - id: source-scope
    type: file_scope
    description: Keep changes scoped.
    severity: error
    allow: ["src/**", "tests/**"]
    deny: ["src/private/**"]
  - id: dependencies
    type: dependency_policy
    description: Control dependency changes.
    severity: warn
    manifests: [package.json]
    allow_additions: false
    allow_removals: true
    allow_version_changes: true
    sections: [dependencies, devDependencies]
  - id: stable-width
    type: structured_value
    description: Preserve configured width.
    severity: error
    file: src/ui/window.yml
    selector: $.window.width
    format: yaml
    expectation: unchanged
  - id: run-tests
    type: command
    description: Run project tests.
    severity: error
    run: pnpm test
    timeout_seconds: 120
`;

describe("contract schema", () => {
  it("accepts the documented first-slice contract without a description", () => {
    const contract = parseContract(`version: 1
defaults:
  base: main
invariants:
  - id: src-only
    type: file_scope
    severity: error
    allow:
      - "src/**"
`);

    expect(contract.invariants[0]).toMatchObject({
      id: "src-only",
      type: "file_scope",
      severity: "error",
      allow: ["src/**"],
    });
    expect(contract.invariants[0]).not.toHaveProperty("description");
    expect(() =>
      parseContract(
        `version: 1\ninvariants:\n  - id: scoped\n    type: file_scope\n    description: ""\n    severity: error\n    allow: ["src/**"]\n`,
      ),
    ).toThrow(/description/);
  });

  it("accepts all four MVP invariant configurations", () => {
    const contract = parseContract(completeContract);
    expect(contract.version).toBe(1);
    expect(contract.invariants.map((item) => item.type)).toEqual([
      "file_scope",
      "dependency_policy",
      "structured_value",
      "command",
    ]);
  });

  it("rejects duplicate IDs, unknown verifier types, and unknown fields", () => {
    const duplicate = completeContract.replace(
      "id: dependencies",
      "id: source-scope",
    );
    expect(() => parseContract(duplicate)).toThrowError(ContractError);
    expect(() => parseContract(duplicate)).toThrow(/duplicate invariant ids/i);

    const unknownType = completeContract.replace(
      "type: command",
      "type: custom",
    );
    expect(() => parseContract(unknownType)).toThrow(/invariants\[3\]\.type/);

    const unknownField = completeContract.replace(
      "timeout_seconds: 120",
      "timeout_seconds: 120\n    secret_override: true",
    );
    expect(() => parseContract(unknownField)).toThrow(/Unrecognized key/);
  });

  it("rejects invalid paths, selectors, malformed YAML, and unsupported versions", () => {
    expect(() => validateContractPath("../outside.yml")).toThrow(
      /repository-relative/,
    );
    expect(() =>
      parseContract(
        completeContract.replace(
          "file: src/ui/window.yml",
          "file: /outside.yml",
        ),
      ),
    ).toThrow(/repository-relative/);
    expect(() =>
      parseContract(
        completeContract.replace(
          "selector: $.window.width",
          "selector: $..width",
        ),
      ),
    ).toThrow(/selector/);
    expect(() => parseContract("version: [\n")).toThrowError(ContractError);
    expect(() =>
      parseContract(completeContract.replace("version: 1", "version: 2")),
    ).toThrow(/Unsupported contract version 2/);
  });
});

describe("contract policy loading", () => {
  it("uses the baseline contract and reports a patch that weakens it", async () => {
    const repo = await newRepo();
    const baselinePolicy = `version: 1\ninvariants:\n  - id: scope\n    type: file_scope\n    description: Keep settings protected.\n    severity: error\n    deny: [src/settings/**]\n`;
    await repo.write(".intentlock.yml", baselinePolicy);
    const baseline = repo.commit("trusted policy");
    await repo.write(
      ".intentlock.yml",
      baselinePolicy.replace("deny: [src/settings/**]", "deny: []"),
    );

    const loaded = await loadContract(discoverRepository(repo.root), baseline);
    expect(loaded.contract.invariants[0]).toMatchObject({
      deny: ["src/settings/**"],
    });
    expect(loaded.policy).toMatchObject({
      path: ".intentlock.yml",
      source: "baseline",
      sourceMode: "auto",
      sourceReason: "baseline-exists",
      modifiedInPatch: true,
      untrusted: false,
    });
    expect(loaded.policy.warnings).toEqual([
      {
        code: "policy-modified",
        path: ".intentlock.yml",
        message:
          ".intentlock.yml differs from the trusted baseline policy; the baseline version was used.",
      },
    ]);
  });

  it("reports Git metadata changes to the trusted policy even when bytes match", async () => {
    const repo = await newRepo();
    const policy = `version: 1\ninvariants: []\n`;
    await repo.write(".intentlock.yml", policy);
    const baseline = repo.commit("trusted policy");
    repo.git("update-index", "--chmod=+x", ".intentlock.yml");

    const loaded = await loadContract(discoverRepository(repo.root), baseline);
    expect(loaded.policy.modifiedInPatch).toBe(true);
    expect(loaded.policy.warnings).toEqual([
      {
        code: "policy-modified",
        path: ".intentlock.yml",
        message:
          ".intentlock.yml differs from the trusted baseline policy; the baseline version was used.",
      },
    ]);
  });

  it("identifies a new contract as worktree-sourced when baseline has none", async () => {
    const repo = await newRepo();
    const baseline = repo.commit("repository without a contract");
    await repo.write(".intentlock.yml", completeContract);

    const loaded = await loadContract(discoverRepository(repo.root), baseline);
    expect(loaded.policy).toMatchObject({
      source: "worktree",
      sourceMode: "auto",
      sourceReason: "baseline-missing",
      modifiedInPatch: true,
      untrusted: true,
      warnings: [],
    });
  });

  it("supports an explicit worktree override and requires baseline policy when requested", async () => {
    const repo = await newRepo();
    await repo.write(
      ".intentlock.yml",
      `version: 1\ninvariants:\n  - id: scope\n    type: file_scope\n    description: Keep changes scoped.\n    severity: error\n    allow: [src/**]\n`,
    );
    const baseline = repo.commit("repository with baseline contract");
    await repo.write(
      ".intentlock.yml",
      `version: 1\ninvariants:\n  - id: scope\n    type: file_scope\n    description: Allow all changes.\n    severity: error\n    allow: ["**"]\n`,
    );

    const loaded = await loadContract(discoverRepository(repo.root), baseline, {
      policySource: "worktree",
    });
    expect(loaded.contract.invariants[0]).toMatchObject({ allow: ["**"] });
    expect(loaded.policy).toMatchObject({
      source: "worktree",
      sourceMode: "worktree",
      sourceReason: "worktree-override",
      untrusted: true,
    });
    const emptyRepo = await newRepo();
    const noContractBase = emptyRepo.commit("repository without a contract");
    await expect(
      loadContract(discoverRepository(emptyRepo.root), noContractBase, {
        policySource: "baseline",
      }),
    ).rejects.toMatchObject({ code: "missing_contract" });
  });

  it("loads a custom --contract path relative to the repository root", async () => {
    const repo = await newRepo();
    await repo.write(".intentlock/tasks/perf review.yml", completeContract);
    const baseline = repo.commit("task policy");

    const loaded = await loadContract(discoverRepository(repo.root), baseline, {
      contractPath: ".intentlock\\tasks\\perf review.yml",
    });
    expect(loaded.policy.path).toBe(".intentlock/tasks/perf review.yml");
    expect(loaded.policy.source).toBe("baseline");
  });

  it("fails with a stable missing-contract configuration error", async () => {
    const repo = await newRepo();
    const baseline = repo.commit("repository without a contract");

    await expect(
      loadContract(discoverRepository(repo.root), baseline),
    ).rejects.toMatchObject({
      code: "missing_contract",
    });
    await expect(
      loadContract(discoverRepository(repo.root), baseline),
    ).rejects.toThrow("No contract found at .intentlock.yml.");
  });
});
