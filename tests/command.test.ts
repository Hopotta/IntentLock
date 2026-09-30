import { afterEach, describe, expect, it } from "vitest";
import { checkRepository } from "../src/check.js";
import { createCommandRunner } from "../src/commands/runner.js";
import { parseContract } from "../src/contract/index.js";
import type { VerificationContext } from "../src/engine/context.js";
import { commandVerifier } from "../src/verifiers/command.js";
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

function commandInvariant(run: string, timeoutSeconds?: number) {
  return parseContract(`version: 1
invariants:
  - id: command-check
    type: command
    severity: error
    run: ${JSON.stringify(run)}
${timeoutSeconds === undefined ? "" : `    timeout_seconds: ${timeoutSeconds}\n`}`)
    .invariants[0]!;
}

function context(root: string, runCommand = createCommandRunner(root)) {
  return {
    repoRoot: root,
    requestedBase: "main",
    baseCommit: "base",
    mergeBaseCommit: "base",
    changedFiles: [],
    policySource: "baseline",
    readBaselineFile: async () => null,
    readCurrentFile: async () => null,
    runCommand,
  } as VerificationContext;
}

describe("command verifier", () => {
  it("runs through the platform shell from repository root and passes on zero", async () => {
    const repo = await newRepo();
    const command = `node -e "process.stdout.write(process.cwd())"`;
    const outcome = await commandVerifier.verify(
      commandInvariant(command),
      context(repo.root),
    );

    expect(outcome.status).toBe("pass");
    expect(outcome.evidence[0]).toMatchObject({
      kind: "command_execution",
      command,
      cwd: repo.root,
      policy_source: "baseline",
      exit_code: 0,
      stdout: repo.root,
    });
    expect(outcome.evidence[0]?.duration_ms).toEqual(expect.any(Number));
  });

  it("fails for nonzero exit codes and keeps output bounded to 64 KiB per stream", async () => {
    const repo = await newRepo();
    const command = `node -e "process.stdout.write('x'.repeat(120000), () => process.stderr.write('y'.repeat(120000), () => process.exit(7)))"`;
    const outcome = await commandVerifier.verify(
      commandInvariant(command),
      context(repo.root),
    );
    const evidence = outcome.evidence[0]!;

    expect(outcome.status).toBe("fail");
    expect(outcome.summary).toContain("code 7");
    expect(Buffer.byteLength(String(evidence.stdout))).toBeLessThanOrEqual(
      64 * 1024,
    );
    expect(Buffer.byteLength(String(evidence.stderr))).toBeLessThanOrEqual(
      64 * 1024,
    );
    expect(evidence).toMatchObject({
      stdout_truncated: true,
      stderr_truncated: true,
      exit_code: 7,
    });
  });

  it("does not mark output truncated when it exactly fills the capture limit", async () => {
    const repo = await newRepo();
    const outcome = await commandVerifier.verify(
      commandInvariant(`node -e "process.stdout.write('x'.repeat(64 * 1024))"`),
      context(repo.root),
    );

    expect(outcome.status).toBe("pass");
    expect(Buffer.byteLength(String(outcome.evidence[0]?.stdout))).toBe(
      64 * 1024,
    );
    expect(outcome.evidence[0]).toMatchObject({ stdout_truncated: false });
  });

  it("reports a declared timeout as an environment error", async () => {
    const repo = await newRepo();
    const outcome = await commandVerifier.verify(
      commandInvariant(`node -e "setTimeout(() => {}, 3000)"`, 1),
      context(repo.root),
    );

    expect(outcome.status).toBe("error");
    expect(outcome.summary).toContain("timed out");
    expect(outcome.evidence[0]).toMatchObject({
      kind: "command_execution",
      timed_out: true,
    });
  });

  it("kills a spawned child that inherits stdio when the command times out", async () => {
    const repo = await newRepo();
    const command = `node -e "const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'inherit' }); setTimeout(() => {}, 10000)"`;
    const outcome = await commandVerifier.verify(
      commandInvariant(command, 1),
      context(repo.root),
    );

    expect(outcome.status).toBe("error");
    expect(outcome.summary).toContain("timed out");
    expect(outcome.evidence[0]?.duration_ms).toBeLessThan(5_000);
  });

  it("uses the 120-second default when the contract omits a timeout", async () => {
    let timeoutMs: number | undefined;
    const outcome = await commandVerifier.verify(
      commandInvariant('node -e "process.exit(0)"'),
      context(".", async (_command, options) => {
        timeoutMs = options?.timeoutMs;
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
          durationMs: 1,
        };
      }),
    );

    expect(outcome.status).toBe("pass");
    expect(timeoutMs).toBe(120_000);
  });

  it("reports an unavailable executable as an environment error", async () => {
    const repo = await newRepo();
    const command = "intentlock-no-such-tool";
    const outcome = await commandVerifier.verify(
      commandInvariant(command),
      context(repo.root),
    );

    expect(outcome.status).toBe("error");
    expect(outcome.summary).toContain("executable is unavailable");
  });
});

describe("command verifier with temporary Git repositories", () => {
  it("runs only the baseline command policy and identifies its source", async () => {
    const repo = await newRepo();
    const trustedCommand = `node -e "process.stdout.write('trusted')"`;
    await repo.write(
      ".intentlock.yml",
      `version: 1\ninvariants:\n  - id: command-check\n    type: command\n    severity: error\n    run: ${JSON.stringify(trustedCommand)}\n`,
    );
    const base = repo.commit("trusted command policy");
    await repo.write(
      ".intentlock.yml",
      `version: 1\ninvariants:\n  - id: command-check\n    type: command\n    severity: error\n    run: ${JSON.stringify(`node -e "process.exit(1)"`)}\n`,
    );

    const { report, policy } = await checkRepository({ cwd: repo.root, base });

    expect(policy).toMatchObject({ source: "baseline", untrusted: false });
    expect(report.results[0]).toMatchObject({ status: "pass" });
    expect(report.results[0]?.evidence[0]).toMatchObject({
      command: trustedCommand,
      policy_source: "baseline",
      stdout: "trusted",
    });
  });
});
