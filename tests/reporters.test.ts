import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PolicyMetadata } from "../src/contract/loader.js";
import type { GitSnapshot } from "../src/git/snapshot.js";
import type { VerificationReport } from "../src/engine/result.js";
import { createJsonReport } from "../src/reporters/json.js";
import { renderTerminalReport } from "../src/reporters/terminal.js";

const policy: PolicyMetadata = {
  path: ".intentlock.yml",
  source: "baseline",
  sourceMode: "auto",
  sourceReason: "baseline-exists",
  modifiedInPatch: false,
  untrusted: false,
  warnings: [],
};

const snapshot: GitSnapshot = {
  repositoryRoot: "/repo",
  requestedBase: "main",
  baseCommit: "abc123",
  headCommit: "def456",
  mergeBaseCommit: "abc123",
  changedFiles: [
    { status: "modified", path: "package.json" },
    { status: "modified", path: "src/config.json" },
    { status: "modified", path: "src/window.yml" },
  ],
  untrackedFileCount: 1,
};

const report: VerificationReport = {
  status: "fail",
  exitCode: 1,
  summary: { passed: 0, failed: 4, warnings: 0, errors: 0, skipped: 0 },
  results: [
    {
      invariantId: "source-scope",
      type: "file_scope",
      severity: "error",
      status: "fail",
      summary: "1 changed path violates the allowed change scope.",
      durationMs: 1,
      evidence: [
        {
          kind: "path_scope_violation",
          path: "README.md",
          reason: "not-allowed",
          matchedPatterns: ["src/**"],
        },
      ],
    },
    {
      invariantId: "no-new-dependencies",
      type: "dependency_policy",
      severity: "error",
      status: "fail",
      summary: "1 disallowed dependency change: 1 addition.",
      durationMs: 2,
      evidence: [
        {
          kind: "dependency_change",
          change: "added",
          manifest: "package.json",
          section: "dependencies",
          dependency: "left-pad",
          currentVersion: "1.3.0",
          allowed: false,
        },
      ],
    },
    {
      invariantId: "keep-window-size",
      type: "structured_value",
      severity: "error",
      status: "fail",
      summary: "Configured value changed.",
      durationMs: 3,
      evidence: [
        {
          kind: "structured_value_diff",
          file: "src/window.yml",
          selector: "$.window.width",
          baseline: 420,
          current: 448,
        },
      ],
    },
    {
      invariantId: "regression-tests",
      type: "command",
      severity: "error",
      status: "fail",
      summary: "Command exited with code 1.",
      durationMs: 4,
      evidence: [
        {
          kind: "command_execution",
          command: "pnpm test",
          cwd: "/repo",
          policy_source: "baseline",
          exit_code: 1,
          timed_out: false,
          stdout: "1 test failed",
          stderr: "",
          stdout_truncated: false,
          stderr_truncated: false,
        },
      ],
    },
  ],
};

describe("reporters", () => {
  it("matches the versioned JSON report golden", async () => {
    const actual = createJsonReport(report, policy, snapshot);
    const golden = await readFile(
      fileURLToPath(new URL("./golden/report.json", import.meta.url)),
      "utf8",
    );
    expect(actual).toEqual(JSON.parse(golden));
  });

  it("matches the actionable terminal report golden", async () => {
    const actual = renderTerminalReport(report, policy, snapshot) + "\n";
    const golden = await readFile(
      fileURLToPath(new URL("./golden/report.txt", import.meta.url)),
      "utf8",
    );
    expect(actual).toBe(golden.replaceAll("\r\n", "\n"));
  });

  it("hides successful command output while retaining failing command output", () => {
    const successfulOutput = "successful test log that should stay hidden";
    const failingOutput = "1 test failed with useful detail";
    const actual = renderTerminalReport(
      {
        ...report,
        status: "fail",
        summary: { passed: 1, failed: 1, warnings: 0, errors: 0, skipped: 0 },
        results: [
          {
            invariantId: "successful-tests",
            type: "command",
            severity: "error",
            status: "pass",
            summary: "Command completed successfully.",
            durationMs: 120,
            evidence: [
              {
                kind: "command_execution",
                command: "pnpm test",
                exit_code: 0,
                stdout: successfulOutput,
                stderr: "",
              },
            ],
          },
          {
            invariantId: "failing-tests",
            type: "command",
            severity: "error",
            status: "fail",
            summary: "Command exited with code 1.",
            durationMs: 240,
            evidence: [
              {
                kind: "command_execution",
                command: "pnpm test",
                exit_code: 1,
                stdout: failingOutput,
                stderr: "",
              },
            ],
          },
        ],
      },
      policy,
      snapshot,
    );

    expect(actual).not.toContain(successfulOutput);
    expect(actual).toContain(failingOutput);
    expect(actual).toContain("PASS  successful-tests");
  });

  it("adds changed paths and timing fields only in verbose JSON", () => {
    const verbose = createJsonReport(report, policy, snapshot, {
      verbose: true,
      totalDurationMs: 15,
    });
    expect(verbose.patch).toHaveProperty("changedFiles");
    expect(verbose).toHaveProperty("timings.totalDurationMs", 15);
  });

  it("shows verifier errors alongside invariant failures in the terminal summary", () => {
    const actual = renderTerminalReport(
      {
        ...report,
        status: "error",
        exitCode: 2,
        summary: { passed: 0, failed: 1, warnings: 0, errors: 1, skipped: 0 },
        results: [
          report.results[0],
          {
            invariantId: "missing-tool",
            type: "command",
            severity: "error",
            status: "error",
            summary: "Command could not start.",
            durationMs: 1,
            evidence: [
              { kind: "verifier_error", message: "Tool unavailable." },
            ],
          },
        ],
      },
      policy,
    );

    expect(actual).toContain(
      "IntentLock ERROR — 1 verifier error, 1 invariant violated.",
    );
  });
});
