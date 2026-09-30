import { parse as parseYaml } from "yaml";
import type { Invariant } from "../contract/schema.js";
import type { VerificationContext } from "../engine/context.js";
import type { EvidenceItem, VerificationResult } from "../engine/result.js";
import type { Verifier } from "../engine/verifier.js";

type StructuredValueInvariant = Extract<
  Invariant,
  { type: "structured_value" }
>;
type StructuredFormat = StructuredValueInvariant["format"];

interface Selection {
  found: boolean;
  value?: unknown;
}

const MAX_STRING_EVIDENCE = 160;
const MAX_STRUCTURED_EVIDENCE = 500;

function parseDocument(
  contents: Buffer,
  path: string,
  revision: "baseline" | "current",
  format: StructuredFormat,
): unknown {
  const source = contents.toString("utf8");
  try {
    return format === "json" ? JSON.parse(source) : parseYaml(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${revision} ${format.toUpperCase()} file ${path} is malformed: ${detail}`,
    );
  }
}

function parseSelector(selector: string): Array<string | number> {
  const tokens: Array<string | number> = [];
  const tokenPattern = /\.([A-Za-z_][A-Za-z0-9_-]*)|\[(0|[1-9][0-9]*)\]/g;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(selector)) !== null) {
    tokens.push(match[1] ?? Number(match[2]));
  }
  return tokens;
}

function selectValue(root: unknown, selector: string): Selection {
  let value = root;
  for (const token of parseSelector(selector)) {
    if (typeof token === "number") {
      if (!Array.isArray(value) || token >= value.length)
        return { found: false };
      value = value[token];
      continue;
    }
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !Object.prototype.hasOwnProperty.call(value, token)
    ) {
      return { found: false };
    }
    value = (value as Record<string, unknown>)[token];
  }
  return { found: true, value };
}

function deepEqual(
  left: unknown,
  right: unknown,
  compared = new WeakMap<object, WeakSet<object>>(),
): boolean {
  if (Object.is(left, right)) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false;

  let rightValues = compared.get(left);
  if (rightValues?.has(right)) return true;
  if (!rightValues) {
    rightValues = new WeakSet<object>();
    compared.set(left, rightValues);
  }
  rightValues.add(right);

  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((item, index) => deepEqual(item, right[index], compared))
    );
  }

  const leftObject = left as Record<string, unknown>;
  const rightObject = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftObject).sort();
  const rightKeys = Object.keys(rightObject).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        deepEqual(leftObject[key], rightObject[key], compared),
    )
  );
}

function stableValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    return value.length > MAX_STRING_EVIDENCE
      ? `${value.slice(0, MAX_STRING_EVIDENCE)}… [truncated]`
      : value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return value.map((item) => stableValue(item, seen));
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((key) => [key, stableValue(source[key], seen)]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value))
    return String(value);
  if (typeof value === "bigint") return `${value.toString()}n`;
  return value;
}

function evidenceValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > MAX_STRING_EVIDENCE
      ? `${value.slice(0, MAX_STRING_EVIDENCE)}… [truncated]`
      : value;
  }
  if (value === null || typeof value !== "object") {
    return typeof value === "number" && !Number.isFinite(value)
      ? String(value)
      : value;
  }

  let encoded: string;
  try {
    encoded = JSON.stringify(stableValue(value));
  } catch {
    encoded = "[unavailable structured value]";
  }
  return encoded.length > MAX_STRUCTURED_EVIDENCE
    ? `${encoded.slice(0, MAX_STRUCTURED_EVIDENCE)}… [truncated]`
    : encoded;
}

function result(
  invariant: StructuredValueInvariant,
  status: VerificationResult["status"],
  summary: string,
  evidence: EvidenceItem[],
): VerificationResult {
  return {
    invariantId: invariant.id,
    type: invariant.type,
    status,
    severity: invariant.severity,
    summary,
    evidence,
    durationMs: 0,
  };
}

export const structuredValueVerifier: Verifier = {
  type: "structured_value",
  async verify(invariant, context: VerificationContext) {
    const expectation = invariant as StructuredValueInvariant;
    let baselineBytes: Buffer | null;
    let currentBytes: Buffer | null;
    try {
      [baselineBytes, currentBytes] = await Promise.all([
        context.readBaselineFile(expectation.file),
        context.readCurrentFile(expectation.file),
      ]);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return result(
        expectation,
        "error",
        "Could not read the configured structured file.",
        [
          {
            kind: "structured_value_error",
            file: expectation.file,
            selector: expectation.selector,
            message: detail,
          },
        ],
      );
    }

    if (!baselineBytes) {
      return result(
        expectation,
        "error",
        "The selected value is missing from the baseline.",
        [
          {
            kind: "structured_value_error",
            file: expectation.file,
            selector: expectation.selector,
            message: "Configured file is missing from the baseline.",
          },
        ],
      );
    }

    let baselineDocument: unknown;
    try {
      baselineDocument = parseDocument(
        baselineBytes,
        expectation.file,
        "baseline",
        expectation.format,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return result(
        expectation,
        "error",
        "The baseline structured file is malformed.",
        [
          {
            kind: "structured_value_error",
            file: expectation.file,
            selector: expectation.selector,
            message: detail,
          },
        ],
      );
    }

    const baseline = selectValue(baselineDocument, expectation.selector);
    if (!baseline.found) {
      return result(
        expectation,
        "error",
        "The selected value is missing from the baseline.",
        [
          {
            kind: "structured_value_error",
            file: expectation.file,
            selector: expectation.selector,
            message:
              "Configured selector does not resolve in the baseline file.",
          },
        ],
      );
    }

    if (!currentBytes) {
      return result(expectation, "fail", "Configured file was deleted.", [
        {
          kind: "structured_value_diff",
          file: expectation.file,
          selector: expectation.selector,
          baseline: evidenceValue(baseline.value),
          current: "[missing file]",
        },
      ]);
    }

    let currentDocument: unknown;
    try {
      currentDocument = parseDocument(
        currentBytes,
        expectation.file,
        "current",
        expectation.format,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return result(
        expectation,
        "error",
        "The current structured file is malformed.",
        [
          {
            kind: "structured_value_error",
            file: expectation.file,
            selector: expectation.selector,
            message: detail,
          },
        ],
      );
    }

    const current = selectValue(currentDocument, expectation.selector);
    if (!current.found) {
      return result(
        expectation,
        "fail",
        "The selected value is missing currently.",
        [
          {
            kind: "structured_value_diff",
            file: expectation.file,
            selector: expectation.selector,
            baseline: evidenceValue(baseline.value),
            current: "[missing value]",
          },
        ],
      );
    }

    if (!deepEqual(baseline.value, current.value)) {
      return result(expectation, "fail", "Configured value changed.", [
        {
          kind: "structured_value_diff",
          file: expectation.file,
          selector: expectation.selector,
          baseline: evidenceValue(baseline.value),
          current: evidenceValue(current.value),
        },
      ]);
    }

    return result(expectation, "pass", "Configured value is unchanged.", []);
  },
};
