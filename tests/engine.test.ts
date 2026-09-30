import { afterEach, describe, expect, it } from "vitest";
import { validateContract } from "../src/contract/index.js";
import {
  createVerificationContext,
  runVerification,
  VerifierRegistry,
  type VerificationContext,
  type VerificationResult,
  type Verifier,
} from "../src/engine/index.js";
import { createGitSnapshot, discoverRepository } from "../src/git/index.js";
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

function contractWithTypes(types: string[]) {
  return validateContract({
    version: 1,
    invariants: types.map((type, index) => ({
      id: `invariant-${index}`,
      type,
      severity: index === 1 ? "warn" : "error",
      ...(type === "file_scope"
        ? { allow: ["src/**"] }
        : type === "dependency_policy"
          ? {
              manifests: ["package.json"],
              allow_additions: false,
              allow_removals: false,
              allow_version_changes: false,
            }
          : type === "structured_value"
            ? {
                file: "config.json",
                selector: "$.value",
                format: "json",
                expectation: "unchanged",
              }
            : { run: "npm test", timeout_seconds: 10 }),
    })),
  });
}

function result(status: VerificationResult["status"]): VerificationResult {
  return {
    invariantId: "placeholder",
    type: "placeholder",
    status,
    severity: "error",
    summary: `${status} result`,
    evidence: [{ kind: "test" }],
    durationMs: 999,
  };
}

function fakeVerifier(type: string, verify: Verifier["verify"]): Verifier {
  return { type, verify };
}

describe("verification engine", () => {
  it("uses snapshot readers and executes registered verifiers in declaration order", async () => {
    const repo = await newRepo();
    await repo.write("src/value.txt", "baseline");
    const base = repo.commit("baseline");
    await repo.write("src/value.txt", "current");
    const repository = discoverRepository(repo.root);
    const snapshot = createGitSnapshot(repository, base);
    const context = createVerificationContext(repository, snapshot);
    const order: string[] = [];
    const registry = new VerifierRegistry();

    for (const [type, status] of [
      ["file_scope", "pass"],
      ["dependency_policy", "fail"],
      ["structured_value", "pass"],
      ["command", "pass"],
    ] as const) {
      registry.register(
        fakeVerifier(type, async (invariant, sharedContext) => {
          order.push(invariant.id);
          if (type === "file_scope") {
            expect(
              await sharedContext.readBaselineFile("src/value.txt"),
            )?.toEqual(Buffer.from("baseline"));
            expect(
              await sharedContext.readCurrentFile("src/value.txt"),
            )?.toEqual(Buffer.from("current"));
          }
          return result(status);
        }),
      );
    }

    const contract = contractWithTypes([
      "file_scope",
      "dependency_policy",
      "structured_value",
      "command",
    ]);
    const report = await runVerification(contract, context, registry);

    expect(order).toEqual(contract.invariants.map(({ id }) => id));
    expect(
      report.results.map(({ invariantId, status, severity }) => ({
        invariantId,
        status,
        severity,
      })),
    ).toEqual([
      { invariantId: "invariant-0", status: "pass", severity: "error" },
      { invariantId: "invariant-1", status: "warn", severity: "warn" },
      { invariantId: "invariant-2", status: "pass", severity: "error" },
      { invariantId: "invariant-3", status: "pass", severity: "error" },
    ]);
    expect(report.status).toBe("warn");
    expect(report.exitCode).toBe(0);
    expect(report.summary).toEqual({
      passed: 3,
      failed: 0,
      warnings: 1,
      errors: 0,
      skipped: 0,
    });
  });

  it("applies fail-on-warn and maps verifier exceptions and missing types to errors", async () => {
    const contract = contractWithTypes([
      "file_scope",
      "dependency_policy",
      "structured_value",
    ]);
    const registry = new VerifierRegistry().register(
      fakeVerifier("file_scope", async () => result("fail")),
    );
    registry.register(
      fakeVerifier("dependency_policy", async () => {
        throw new Error("tool unavailable");
      }),
    );
    const context = {} as VerificationContext;

    const report = await runVerification(contract, context, registry, {
      failOnWarn: true,
    });
    expect(
      report.results.map(({ status, severity, summary }) => ({
        status,
        severity,
        summary,
      })),
    ).toEqual([
      { status: "fail", severity: "error", summary: "fail result" },
      {
        status: "error",
        severity: "warn",
        summary: "Verifier failed to run: tool unavailable",
      },
      {
        status: "error",
        severity: "error",
        summary: 'No verifier is registered for type "structured_value".',
      },
    ]);
    expect(report.status).toBe("error");
    expect(report.exitCode).toBe(2);
    expect(report.summary).toMatchObject({ failed: 1, errors: 2 });
  });

  it("fails on an error-severity violation and on warnings only when requested", async () => {
    const warningContract = contractWithTypes([
      "file_scope",
      "dependency_policy",
    ]);
    const registry = new VerifierRegistry()
      .register(fakeVerifier("file_scope", async () => result("pass")))
      .register(fakeVerifier("dependency_policy", async () => result("fail")));
    const context = {} as VerificationContext;

    const warning = await runVerification(warningContract, context, registry);
    expect(warning.status).toBe("warn");
    expect(warning.exitCode).toBe(0);

    const blockingWarning = await runVerification(
      warningContract,
      context,
      registry,
      { failOnWarn: true },
    );
    expect(blockingWarning.status).toBe("warn");
    expect(blockingWarning.exitCode).toBe(1);

    const failureContract = contractWithTypes(["file_scope"]);
    const failure = await runVerification(
      failureContract,
      context,
      new VerifierRegistry().register(
        fakeVerifier("file_scope", async () => result("fail")),
      ),
    );
    expect(failure.status).toBe("fail");
    expect(failure.exitCode).toBe(1);
  });

  it("rejects duplicate verifier registration", () => {
    const registry = new VerifierRegistry();
    registry.register(fakeVerifier("file_scope", async () => result("pass")));
    expect(() =>
      registry.register(fakeVerifier("file_scope", async () => result("pass"))),
    ).toThrow(/already registered/);
  });
});
