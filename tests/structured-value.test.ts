import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseContract } from "../src/contract/index.js";
import type { VerificationContext } from "../src/engine/context.js";
import { createVerificationContext } from "../src/engine/context.js";
import { createGitSnapshot, discoverRepository } from "../src/git/index.js";
import { structuredValueVerifier } from "../src/verifiers/structured-value.js";
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

function invariant(
  format: "json" | "yaml",
  selector = "$.window.width",
  file = format === "json" ? "config.json" : "config.yml",
) {
  return parseContract(`version: 1
invariants:
  - id: preserve-value
    type: structured_value
    severity: error
    file: ${file}
    format: ${format}
    selector: '${selector}'
    expectation: unchanged
`).invariants[0]!;
}

async function run(
  repo: TestGitRepo,
  base: string,
  format: "json" | "yaml",
  selector?: string,
) {
  const repository = discoverRepository(repo.root);
  const context = createVerificationContext(
    repository,
    createGitSnapshot(repository, base),
  );
  return structuredValueVerifier.verify(invariant(format, selector), context);
}

function readerContext(baseline: Buffer | null, current: Buffer | null) {
  return {
    readBaselineFile: async () => baseline,
    readCurrentFile: async () => current,
  } as unknown as VerificationContext;
}

describe("structured_value verifier unit behavior", () => {
  it("compares selected nested values structurally and supports array indexes", async () => {
    const result = await structuredValueVerifier.verify(
      invariant("json", "$.features[0].enabled"),
      readerContext(
        Buffer.from('{"features":[{"enabled":true,"name":"animation"}]}'),
        Buffer.from('{"features":[{"name":"animation","enabled":true}]}'),
      ),
    );

    expect(result.status).toBe("pass");
    expect(result.evidence).toEqual([]);
  });

  it("bounds evidence for long strings and structured objects", async () => {
    const longString = "x".repeat(2000);
    const stringResult = await structuredValueVerifier.verify(
      invariant("json", "$.value"),
      readerContext(
        Buffer.from(JSON.stringify({ value: longString })),
        Buffer.from(JSON.stringify({ value: `${longString}changed` })),
      ),
    );
    expect(stringResult.status).toBe("fail");
    expect(JSON.stringify(stringResult.evidence).length).toBeLessThan(1000);
    expect(stringResult.evidence[0]).toMatchObject({
      baseline: expect.stringContaining("[truncated]"),
      current: expect.stringContaining("[truncated]"),
    });

    const object = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [
        `key-${index}`,
        "x".repeat(50),
      ]),
    );
    const objectResult = await structuredValueVerifier.verify(
      invariant("json", "$.value"),
      readerContext(
        Buffer.from(JSON.stringify({ value: object })),
        Buffer.from(JSON.stringify({ value: { ...object, extra: true } })),
      ),
    );
    expect(objectResult.status).toBe("fail");
    expect(JSON.stringify(objectResult.evidence).length).toBeLessThan(1600);
    expect(objectResult.evidence[0]).toMatchObject({
      baseline: expect.stringContaining("[truncated]"),
      current: expect.stringContaining("[truncated]"),
    });
  });
});

describe("structured_value verifier with temporary Git repositories", () => {
  it("passes unchanged JSON and YAML selections", async () => {
    const repo = await newRepo();
    await repo.write("config.json", '{"window":{"width":420,"height":800}}');
    await repo.write("config.yml", "window:\n  width: 420\n  height: 800\n");
    const base = repo.commit("baseline");

    expect((await run(repo, base, "json")).status).toBe("pass");
    expect((await run(repo, base, "yaml")).status).toBe("pass");
  });

  it("fails when selected JSON and YAML values change, including array entries", async () => {
    const repo = await newRepo();
    await repo.write(
      "config.json",
      '{"window":{"width":420},"targets":["web","node"]}',
    );
    await repo.write(
      "config.yml",
      "window:\n  width: 420\ntargets: [web, node]\n",
    );
    const base = repo.commit("baseline");
    await repo.write(
      "config.json",
      '{"window":{"width":448},"targets":["browser","node"]}',
    );
    await repo.write(
      "config.yml",
      "window:\n  width: 448\ntargets: [web, node]\n",
    );

    const json = await run(repo, base, "json");
    const yaml = await run(repo, base, "yaml");
    const array = await run(repo, base, "json", "$.targets[0]");

    expect(json.status).toBe("fail");
    expect(yaml.status).toBe("fail");
    expect(json.evidence[0]).toMatchObject({
      kind: "structured_value_diff",
      baseline: 420,
      current: 448,
    });
    expect(array.status).toBe("fail");
    expect(array.evidence[0]).toMatchObject({
      selector: "$.targets[0]",
      baseline: "web",
      current: "browser",
    });
  });

  it("errors for missing baseline selections and fails for missing current values or files", async () => {
    const repo = await newRepo();
    await repo.write("config.json", '{"window":{"height":800}}');
    const base = repo.commit("baseline without width");
    await repo.write("config.json", '{"window":{"height":800,"width":420}}');

    const missingBaseline = await run(repo, base, "json");
    expect(missingBaseline.status).toBe("error");
    expect(missingBaseline.evidence[0]).toMatchObject({
      kind: "structured_value_error",
    });

    const baseWithValue = repo.commit("baseline with width");
    await repo.write("config.json", '{"window":{"height":800}}');
    const missingCurrentValue = await run(repo, baseWithValue, "json");
    expect(missingCurrentValue.status).toBe("fail");
    expect(missingCurrentValue.evidence[0]).toMatchObject({
      current: "[missing value]",
    });

    await rm(join(repo.root, "config.json"));
    const missingCurrentFile = await run(repo, baseWithValue, "json");
    expect(missingCurrentFile.status).toBe("fail");
    expect(missingCurrentFile.evidence[0]).toMatchObject({
      current: "[missing file]",
    });
  });

  it("returns errors for malformed baseline or current JSON and YAML", async () => {
    for (const format of ["json", "yaml"] as const) {
      const repo = await newRepo();
      await repo.write(
        format === "json" ? "config.json" : "config.yml",
        format === "json"
          ? '{"window":{"width":420}}'
          : "window:\n  width: 420\n",
      );
      const base = repo.commit("baseline");
      await repo.write(
        format === "json" ? "config.json" : "config.yml",
        format === "json" ? "{ invalid json" : "window: [\n",
      );

      const malformedCurrent = await run(repo, base, format);
      expect(malformedCurrent.status).toBe("error");
      expect(malformedCurrent.evidence[0]).toMatchObject({
        kind: "structured_value_error",
        message: expect.stringContaining("current"),
      });

      const malformedBaseRepo = await newRepo();
      await malformedBaseRepo.write(
        format === "json" ? "config.json" : "config.yml",
        format === "json" ? "{ invalid json" : "window: [\n",
      );
      const malformedBase = malformedBaseRepo.commit("malformed baseline");
      await malformedBaseRepo.write(
        format === "json" ? "config.json" : "config.yml",
        format === "json"
          ? '{"window":{"width":420}}'
          : "window:\n  width: 420\n",
      );
      const malformedBaseline = await run(
        malformedBaseRepo,
        malformedBase,
        format,
      );
      expect(malformedBaseline.status).toBe("error");
      expect(malformedBaseline.evidence[0]).toMatchObject({
        kind: "structured_value_error",
        message: expect.stringContaining("baseline"),
      });
    }
  }, 15_000);
});
