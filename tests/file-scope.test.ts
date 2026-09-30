import { describe, expect, it } from "vitest";
import { parseContract } from "../src/contract/index.js";
import type { VerificationContext } from "../src/engine/context.js";
import { fileScopeVerifier } from "../src/verifiers/file-scope.js";

function invariant(yaml: string) {
  return parseContract(yaml).invariants[0]!;
}

function context(paths: VerificationContext["changedFiles"]) {
  return { changedFiles: paths } as VerificationContext;
}

describe("file_scope verifier", () => {
  it("allows matching paths and rejects paths outside allow globs", async () => {
    const rule = invariant(`version: 1
invariants:
  - id: src-only
    type: file_scope
    severity: error
    allow: ["src/**"]
`);
    const result = await fileScopeVerifier.verify(
      rule,
      context([
        { status: "modified", path: "src/index.ts" },
        { status: "added", path: "README.md" },
      ]),
    );

    expect(result.status).toBe("fail");
    expect(result.summary).toBe(
      "1 changed path violates the allowed change scope.",
    );
    expect(result.evidence).toEqual([
      expect.objectContaining({
        kind: "path_scope_violation",
        path: "README.md",
        reason: "not-allowed",
      }),
    ]);
  });

  it("gives deny globs precedence over allow globs", async () => {
    const rule = invariant(`version: 1
invariants:
  - id: no-private
    type: file_scope
    severity: error
    allow: ["src/**"]
    deny: ["src/private/**"]
`);
    const result = await fileScopeVerifier.verify(
      rule,
      context([{ status: "modified", path: "src/private/key.ts" }]),
    );

    expect(result.status).toBe("fail");
    expect(result.evidence[0]).toMatchObject({
      path: "src/private/key.ts",
      reason: "denied",
      matchedPatterns: ["src/private/**"],
    });
  });

  it("treats omitted allow as unrestricted except for denials", async () => {
    const rule = invariant(`version: 1
invariants:
  - id: no-secrets
    type: file_scope
    severity: error
    deny: ["**/*.secret"]
`);
    const result = await fileScopeVerifier.verify(
      rule,
      context([
        { status: "modified", path: "README.md" },
        { status: "added", path: "config/app.secret" },
      ]),
    );

    expect(result.status).toBe("fail");
    expect(result.evidence.map((item) => item.path)).toEqual([
      "config/app.secret",
    ]);
  });

  it("checks both old and new paths for a rename and normalizes Windows paths", async () => {
    const rule = invariant(`version: 1
invariants:
  - id: source-only
    type: file_scope
    severity: error
    allow: ["src/**"]
`);
    const result = await fileScopeVerifier.verify(
      rule,
      context([
        {
          status: "renamed",
          oldPath: "docs\\guide.md",
          path: "src\\guide.md",
        },
      ]),
    );

    expect(result.status).toBe("fail");
    expect(result.evidence).toEqual([
      expect.objectContaining({
        path: "docs/guide.md",
        oldPath: "docs/guide.md",
        reason: "not-allowed",
      }),
    ]);
  });

  it("fails a rename when its new path is denied", async () => {
    const rule = invariant(`version: 1
invariants:
  - id: no-private
    type: file_scope
    severity: error
    allow: ["src/**"]
    deny: ["src/private/**"]
`);
    const result = await fileScopeVerifier.verify(
      rule,
      context([
        {
          status: "renamed",
          oldPath: "src/public.ts",
          path: "src/private/secret.ts",
        },
      ]),
    );

    expect(result.evidence[0]).toMatchObject({
      path: "src/private/secret.ts",
      reason: "denied",
    });
  });
});
