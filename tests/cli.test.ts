import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTestGitRepo } from "./helpers/git-repo.js";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function runCli(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
  });
}

describe("intentlock CLI bootstrap", () => {
  it("prints its version", () => {
    const result = runCli(process.cwd(), "--version");

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("0.1.0");
  });

  it("prints help and exits successfully", () => {
    const result = runCli(process.cwd(), "--help");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: intentlock [options]");
    expect(result.stdout).toContain("--version");
  });

  it("initializes a Git repository and refuses to overwrite without --force", async () => {
    const repo = await createTestGitRepo();
    try {
      const created = runCli(repo.root, "init", "--yes");
      expect(created.status).toBe(0);
      const original = await readFile(`${repo.root}/.intentlock.yml`, "utf8");
      expect(original).toContain("invariants: []");

      await repo.write(".intentlock.yml", "user policy\n");
      const refused = runCli(repo.root, "init", "--yes");
      expect(refused.status).toBe(2);
      expect(await readFile(`${repo.root}/.intentlock.yml`, "utf8")).toBe(
        "user policy\n",
      );

      const forced = runCli(repo.root, "init", "--force", "--yes");
      expect(forced.status).toBe(0);
      expect(await readFile(`${repo.root}/.intentlock.yml`, "utf8")).toContain(
        "invariants: []",
      );
    } finally {
      await repo.cleanup();
    }
  });

  it("rejects init and doctor outside a Git repository", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const outside = await mkdtemp(join(tmpdir(), "intentlock-outside-"));
    try {
      const isolatedGitEnvironment = {
        ...process.env,
        GIT_CEILING_DIRECTORIES: outside,
      };
      const init = spawnSync(process.execPath, [cliPath, "init", "--yes"], {
        cwd: outside,
        encoding: "utf8",
        env: isolatedGitEnvironment,
      });
      const doctor = spawnSync(process.execPath, [cliPath, "doctor"], {
        cwd: outside,
        encoding: "utf8",
        env: isolatedGitEnvironment,
      });
      expect(init.status).toBe(2);
      expect(doctor.status).toBe(2);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("doctor reports malformed policies and unresolved bases", async () => {
    const repo = await createTestGitRepo();
    try {
      repo.commit("empty baseline");
      await repo.write(".intentlock.yml", "version: 2\ninvariants: []\n");
      const malformed = runCli(repo.root, "doctor");
      expect(malformed.status).toBe(2);
      expect(malformed.stdout).toContain("FAIL  contract-schema");

      await repo.write(".intentlock.yml", "version: 1\ninvariants: []\n");
      const missingBase = runCli(repo.root, "doctor", "--base", "missing-base");
      expect(missingBase.status).toBe(2);
      expect(missingBase.stdout).toContain("FAIL  base");
    } finally {
      await repo.cleanup();
    }
  });

  it("doctor rejects contract paths that escape the repository", async () => {
    const repo = await createTestGitRepo();
    try {
      repo.commit("empty baseline");
      await repo.write(".intentlock.yml", "version: 1\ninvariants: []\n");

      const result = runCli(
        repo.root,
        "doctor",
        "--contract",
        "../outside.yml",
      );

      expect(result.status).toBe(2);
      expect(result.stdout).toContain("FAIL  contract-schema");
      expect(result.stdout).toContain("Contract path is invalid.");
    } finally {
      await repo.cleanup();
    }
  });

  it.skipIf(process.platform === "win32")(
    "doctor rejects contract symlinks that resolve outside the repository",
    async () => {
      const { mkdtemp, rm, symlink, writeFile } =
        await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const repo = await createTestGitRepo();
      const outside = await mkdtemp(join(tmpdir(), "intentlock-contract-"));
      try {
        await writeFile(
          join(outside, "contract.yml"),
          "version: 1\ninvariants: []\n",
        );
        await symlink(
          join(outside, "contract.yml"),
          join(repo.root, "external-contract.yml"),
        );
        repo.commit("contract symlink");

        const result = runCli(
          repo.root,
          "doctor",
          "--contract",
          "external-contract.yml",
        );

        expect(result.status).toBe(2);
        expect(result.stdout).toContain("FAIL  contract-schema");
        expect(result.stdout).toContain(
          "Refusing to read a path outside the repository",
        );
      } finally {
        await repo.cleanup();
        await rm(outside, { recursive: true, force: true });
      }
    },
  );

  it("doctor checks command feasibility without executing verifier commands", async () => {
    const repo = await createTestGitRepo();
    try {
      repo.commit("empty baseline");
      const marker = `${repo.root}/doctor-command-ran`;
      const probe = `require("node:fs").writeFileSync("${marker}", "ran")`;
      await repo.write(
        ".intentlock.yml",
        `version: 1\ninvariants:\n  - id: probe\n    type: command\n    severity: error\n    run: ${JSON.stringify(`node -e '${probe}'`)}\n`,
      );
      const result = runCli(repo.root, "doctor", "--base", "main");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Command executable");
      await expect(readFile(marker, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await repo.cleanup();
    }
  });

  it("passes an in-scope patch using the trusted baseline policy", async () => {
    const repo = await createTestGitRepo();
    try {
      await repo.write(
        ".intentlock.yml",
        `version: 1\ninvariants:\n  - id: src-only\n    type: file_scope\n    severity: error\n    allow: ["src/**"]\n`,
      );
      await repo.write("src/index.ts", "baseline\n");
      repo.commit("trusted baseline");
      await repo.write("src/index.ts", "changed\n");

      const result = runCli(repo.root, "check", "--base", "main");

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "Policy: .intentlock.yml (trusted baseline)",
      );
      expect(result.stdout).toContain("PASS  src-only");
      expect(result.stdout).toContain("IntentLock PASS");
    } finally {
      await repo.cleanup();
    }
  });

  it("fails when README.md is outside the allowed scope", async () => {
    const repo = await createTestGitRepo();
    try {
      await repo.write(
        ".intentlock.yml",
        `version: 1\ninvariants:\n  - id: src-only\n    type: file_scope\n    severity: error\n    allow: ["src/**"]\n`,
      );
      const base = repo.commit("trusted baseline");
      await repo.write("README.md", "changed\n");

      const result = runCli(repo.root, "check", "--base", base);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("FAIL  src-only");
      expect(result.stdout).toContain("README.md outside allowed scope");
      expect(result.stdout).toContain("IntentLock FAIL");
    } finally {
      await repo.cleanup();
    }
  });

  it("ignores a worktree contract change and reports the tampering", async () => {
    const repo = await createTestGitRepo();
    try {
      await repo.write(
        ".intentlock.yml",
        `version: 1\ninvariants:\n  - id: src-only\n    type: file_scope\n    severity: error\n    allow: ["src/**"]\n`,
      );
      const base = repo.commit("trusted baseline");
      await repo.write(
        ".intentlock.yml",
        `version: 1\ninvariants:\n  - id: src-only\n    type: file_scope\n    severity: error\n    allow: ["**"]\n`,
      );
      await repo.write("README.md", "changed\n");

      const result = runCli(repo.root, "check", "--base", base);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("trusted baseline");
      expect(result.stdout).toContain(
        "differs from the trusted baseline policy",
      );
      expect(result.stdout).toContain("README.md outside allowed scope");
    } finally {
      await repo.cleanup();
    }
  });

  it("counts policy tampering as a warning and applies --fail-on-warn", async () => {
    const repo = await createTestGitRepo();
    try {
      await repo.write(
        ".intentlock.yml",
        `version: 1\nproject:\n  name: trusted\ninvariants:\n  - id: src-only\n    type: file_scope\n    severity: error\n    allow: ["src/**", ".intentlock.yml"]\n`,
      );
      const base = repo.commit("trusted baseline");
      await repo.write(
        ".intentlock.yml",
        `version: 1\nproject:\n  name: modified\ninvariants:\n  - id: src-only\n    type: file_scope\n    severity: error\n    allow: ["src/**", ".intentlock.yml"]\n`,
      );
      await repo.write("src/index.ts", "changed\n");

      const regular = runCli(
        repo.root,
        "check",
        "--base",
        base,
        "--format",
        "json",
      );
      expect(regular.status).toBe(0);
      expect(JSON.parse(regular.stdout)).toMatchObject({
        status: "warn",
        policy: {
          modifiedInPatch: true,
          warnings: [{ code: "policy-modified" }],
        },
        summary: { passed: 1, warnings: 1, failed: 0 },
      });

      const enforced = runCli(
        repo.root,
        "check",
        "--base",
        base,
        "--format",
        "json",
        "--fail-on-warn",
      );
      expect(enforced.status).toBe(1);
      expect(JSON.parse(enforced.stdout)).toMatchObject({
        status: "warn",
        summary: { warnings: 1 },
      });
    } finally {
      await repo.cleanup();
    }
  });

  it("uses stable configuration and environment exit codes", async () => {
    const repo = await createTestGitRepo();
    try {
      const base = repo.commit("empty baseline");
      await repo.write(".intentlock.yml", "not: [valid\n");
      const invalidContract = runCli(repo.root, "check", "--base", base);
      expect(invalidContract.status).toBe(2);

      const missingBase = runCli(repo.root, "check", "--base", "absent-ref");
      expect(missingBase.status).toBe(2);
    } finally {
      await repo.cleanup();
    }
  });

  it("emits a versioned JSON report with patch counts and policy trust", async () => {
    const repo = await createTestGitRepo();
    try {
      await repo.write(
        ".intentlock.yml",
        `version: 1\ninvariants:\n  - id: src-only\n    type: file_scope\n    severity: error\n    allow: ["src/**"]\n`,
      );
      const base = repo.commit("trusted baseline");
      await repo.write("src/index.ts", "new\n");
      await repo.write("src/untracked.ts", "new file\n");

      const result = runCli(
        repo.root,
        "check",
        "--base",
        base,
        "--format",
        "json",
      );
      const json = JSON.parse(result.stdout);
      expect(result.status).toBe(0);
      expect(json).toMatchObject({
        schemaVersion: 1,
        toolVersion: "0.1.0",
        status: "pass",
        policy: { source: "baseline", untrusted: false },
        baseline: { requested: base },
        patch: { changedFileCount: 2, untrackedFileCount: 2 },
      });
      expect(json.results[0]).toHaveProperty("evidence");
    } finally {
      await repo.cleanup();
    }
  });

  it("uses a trusted contract default base through a secure two-pass resolution", async () => {
    const repo = await createTestGitRepo();
    try {
      await repo.write(
        ".intentlock.yml",
        `version: 1\ndefaults:\n  base: stable\ninvariants:\n  - id: src-only\n    type: file_scope\n    severity: error\n    allow: ["src/**", "docs/**"]\n`,
      );
      await repo.write("src/index.ts", "baseline\n");
      const stable = repo.commit("trusted baseline");
      repo.git("branch", "stable", stable);
      await repo.write("docs/extra.md", "committed after stable\n");
      repo.commit("advance main");
      await repo.write("src/index.ts", "changed\n");

      const result = runCli(repo.root, "check", "--format", "json");
      const json = JSON.parse(result.stdout);
      expect(result.status).toBe(0);
      expect(json.baseline.requested).toBe("stable");
      expect(json.baseline.mergeBaseCommit).toBe(stable);
      expect(json.patch.changedFileCount).toBe(2);

      const explicit = runCli(
        repo.root,
        "check",
        "--base",
        "main",
        "--format",
        "json",
      );
      expect(explicit.status).toBe(0);
      expect(JSON.parse(explicit.stdout).baseline.requested).toBe("main");
    } finally {
      await repo.cleanup();
    }
  });

  it("requires an explicit base when the repository has no main branch", async () => {
    const repo = await createTestGitRepo();
    try {
      repo.git("branch", "-m", "master");
      await repo.write(
        ".intentlock.yml",
        `version: 1\ndefaults:\n  base: master\ninvariants:\n  - id: src-only\n    type: file_scope\n    severity: error\n    allow: ["src/**"]\n`,
      );
      await repo.write("src/index.ts", "baseline\n");
      const master = repo.commit("trusted baseline");
      await repo.write("src/index.ts", "changed\n");

      const implicit = runCli(repo.root, "check");
      expect(implicit.status).toBe(2);
      expect(implicit.stderr).toContain(
        "Cannot establish a trusted baseline. Specify --base <ref>.",
      );

      const result = runCli(
        repo.root,
        "check",
        "--base",
        "master",
        "--format",
        "json",
      );
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: "pass",
        baseline: { requested: "master", mergeBaseCommit: master },
        policy: { source: "baseline", untrusted: false },
      });
    } finally {
      await repo.cleanup();
    }
  });

  it("ignores a worktree default base when main exists", async () => {
    const repo = await createTestGitRepo();
    try {
      repo.commit("baseline without contract");
      repo.git("checkout", "-b", "policy-base");
      await repo.write(
        ".intentlock.yml",
        `version: 1\ninvariants:\n  - id: baseline-policy\n    type: file_scope\n    severity: error\n    allow: ["src/**"]\n`,
      );
      repo.commit("add policy on target base");
      repo.git("checkout", "main");
      await repo.write(
        ".intentlock.yml",
        `version: 1\ndefaults:\n  base: policy-base\ninvariants:\n  - id: readme\n    type: file_scope\n    severity: error\n    allow: ["**"]\n`,
      );
      await repo.write("README.md", "changed\n");

      const result = runCli(repo.root, "check", "--format", "json");
      const json = JSON.parse(result.stdout);
      expect(result.status).toBe(0);
      expect(json.baseline.requested).toBe("main");
      expect(json.policy).toMatchObject({
        source: "worktree",
        untrusted: true,
      });
      expect(json.policy.sourceReason).toBe("baseline-missing");
    } finally {
      await repo.cleanup();
    }
  });

  it("cannot bootstrap an implicit baseline from an attacker-selected worktree base", async () => {
    const repo = await createTestGitRepo();
    try {
      repo.git("branch", "-m", "master");
      await repo.write(
        ".intentlock.yml",
        `version: 1\ninvariants:\n  - id: src-only\n    type: file_scope\n    severity: error\n    allow: ["src/**"]\n`,
      );
      await repo.write("src/index.ts", "baseline\n");
      repo.commit("trusted master policy");
      repo.git("checkout", "-b", "feature");
      await repo.write(
        ".intentlock.yml",
        `version: 1\ndefaults:\n  base: HEAD\ninvariants:\n  - id: src-only\n    type: file_scope\n    severity: error\n    allow: ["**"]\n`,
      );
      await repo.write("README.md", "forbidden change\n");
      repo.commit("weaken policy and edit forbidden file");

      const implicit = runCli(repo.root, "check", "--format", "json");
      expect(implicit.status).toBe(2);
      expect(JSON.parse(implicit.stdout)).toMatchObject({
        status: "error",
        error: {
          kind: "environment_error",
          message: "Cannot establish a trusted baseline. Specify --base <ref>.",
        },
      });

      const explicit = runCli(
        repo.root,
        "check",
        "--base",
        "master",
        "--format",
        "json",
      );
      expect(explicit.status).toBe(1);
      expect(JSON.parse(explicit.stdout)).toMatchObject({
        status: "fail",
        policy: { source: "baseline", untrusted: false },
      });
      expect(JSON.parse(explicit.stdout).results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            invariantId: "src-only",
            status: "fail",
            summary: expect.stringContaining("changed paths violate"),
            evidence: expect.arrayContaining([
              expect.objectContaining({ path: "README.md" }),
            ]),
          }),
        ]),
      );
    } finally {
      await repo.cleanup();
    }
  });

  it("does not promote to a worktree contract when a trusted default base has no baseline contract", async () => {
    const repo = await createTestGitRepo();
    try {
      const stable = repo.commit("baseline without contract");
      repo.git("branch", "stable", stable);
      await repo.write(
        ".intentlock.yml",
        `version: 1\ndefaults:\n  base: stable\ninvariants: []\n`,
      );
      repo.commit("add trusted policy with stable default");

      const result = runCli(repo.root, "check", "--format", "json");
      expect(result.status).toBe(2);
      const json = JSON.parse(result.stdout);
      expect(json.status).toBe("error");
      expect(json.error.kind).toBe("contract_error");
      expect(json.error.message).toContain(
        "No baseline contract exists at .intentlock.yml.",
      );
    } finally {
      await repo.cleanup();
    }
  });

  it("honors --fail-on-warn and can write JSON reports to a file", async () => {
    const repo = await createTestGitRepo();
    try {
      await repo.write(
        ".intentlock.yml",
        `version: 1\ninvariants:\n  - id: docs-scope\n    type: file_scope\n    severity: warn\n    allow: ["src/**"]\n`,
      );
      const base = repo.commit("trusted baseline");
      await repo.write("README.md", "changed\n");
      const regular = runCli(
        repo.root,
        "check",
        "--base",
        base,
        "--format",
        "json",
      );
      expect(regular.status).toBe(0);
      expect(JSON.parse(regular.stdout).status).toBe("warn");

      const enforced = runCli(
        repo.root,
        "check",
        "--base",
        base,
        "--fail-on-warn",
        "--format",
        "json",
        "--output",
        "report.json",
      );
      expect(enforced.status).toBe(1);
      expect(enforced.stdout).toBe("");
      const saved = JSON.parse(
        await readFile(`${repo.root}/report.json`, "utf8"),
      );
      expect(saved).toMatchObject({ status: "warn", summary: { warnings: 1 } });
    } finally {
      await repo.cleanup();
    }
  });

  it("returns machine-readable expected errors in JSON mode and supports --repo", async () => {
    const repo = await createTestGitRepo();
    try {
      repo.commit("empty baseline");
      const invalid = runCli(
        process.cwd(),
        "check",
        "--repo",
        repo.root,
        "--base",
        "missing",
        "--format",
        "json",
      );
      expect(invalid.status).toBe(2);
      expect(JSON.parse(invalid.stdout)).toMatchObject({
        schemaVersion: 1,
        status: "error",
        error: { kind: "environment_error" },
      });
    } finally {
      await repo.cleanup();
    }
  });

  it("writes early error reports relative to the repository root", async () => {
    const { mkdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const repo = await createTestGitRepo();
    try {
      repo.commit("empty baseline");
      const nested = join(repo.root, "nested");
      await mkdir(nested);
      const result = runCli(
        repo.root,
        "check",
        "--repo",
        nested,
        "--base",
        "missing",
        "--format",
        "json",
        "--output",
        "error.json",
      );
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(
        JSON.parse(await readFile(join(repo.root, "error.json"), "utf8")),
      ).toMatchObject({ status: "error" });
    } finally {
      await repo.cleanup();
    }
  });
});
