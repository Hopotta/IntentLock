import { z } from "zod";
import { ContractError } from "./errors.js";

const invariantIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function normalizeContractPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function isSafeRelativePath(path: string): boolean {
  if (!path || path.startsWith("/") || /^[A-Za-z]:\//.test(path)) return false;
  const segments = path.split("/");
  return segments.every(
    (segment) => segment !== "" && segment !== "." && segment !== "..",
  );
}

function hasControlCharacters(path: string): boolean {
  return Array.from(path).some((character) => character.charCodeAt(0) < 32);
}

const relativeFilePathSchema = z
  .string()
  .transform(normalizeContractPath)
  .refine(isSafeRelativePath, "Expected a safe repository-relative path.")
  .refine(
    (path) => !/[<>:"|?*]/.test(path) && !hasControlCharacters(path),
    "Path contains unsupported characters.",
  );

const relativeGlobSchema = z
  .string()
  .transform(normalizeContractPath)
  .refine(isSafeRelativePath, "Expected a safe repository-relative glob.")
  .refine(
    (path) => !/[<>:"|]/.test(path) && !hasControlCharacters(path),
    "Glob contains unsupported characters.",
  );

const commonFields = {
  id: z
    .string()
    .regex(invariantIdPattern, "Expected a machine-readable invariant id."),
  type: z.string(),
  description: z.string().min(1).optional(),
  severity: z.enum(["error", "warn"]),
};

const fileScopeSchema = z
  .object({
    ...commonFields,
    type: z.literal("file_scope"),
    allow: z.array(relativeGlobSchema).min(1).optional(),
    deny: z.array(relativeGlobSchema).min(1).optional(),
  })
  .strict()
  .refine((value) => value.allow !== undefined || value.deny !== undefined, {
    message: "At least one of allow or deny must be configured.",
  });

const dependencyPolicySchema = z
  .object({
    ...commonFields,
    type: z.literal("dependency_policy"),
    manifests: z.array(relativeFilePathSchema).min(1),
    allow_additions: z.boolean(),
    allow_removals: z.boolean(),
    allow_version_changes: z.boolean(),
    sections: z
      .array(
        z.enum([
          "dependencies",
          "devDependencies",
          "optionalDependencies",
          "peerDependencies",
        ]),
      )
      .min(1)
      .optional(),
  })
  .strict();

const selectorSchema = z
  .string()
  .regex(
    /^\$(?:\.[A-Za-z_][A-Za-z0-9_-]*|\[(?:0|[1-9][0-9]*)\])+$/,
    "Expected a selector such as $.window.width or $.targets[0].",
  );

const structuredValueSchema = z
  .object({
    ...commonFields,
    type: z.literal("structured_value"),
    file: relativeFilePathSchema,
    selector: selectorSchema,
    format: z.enum(["json", "yaml"]),
    expectation: z.literal("unchanged"),
  })
  .strict();

const commandSchema = z
  .object({
    ...commonFields,
    type: z.literal("command"),
    run: z.string().min(1),
    timeout_seconds: z.number().int().positive().optional(),
  })
  .strict();

const invariantSchema = z.discriminatedUnion("type", [
  fileScopeSchema,
  dependencyPolicySchema,
  structuredValueSchema,
  commandSchema,
]);

export const contractSchema = z
  .object({
    version: z.literal(1),
    project: z
      .object({ name: z.string().min(1) })
      .strict()
      .optional(),
    defaults: z
      .object({ base: z.string().min(1) })
      .strict()
      .optional(),
    invariants: z.array(invariantSchema),
  })
  .strict()
  .superRefine((contract, context) => {
    const firstIndex = new Map<string, number>();
    contract.invariants.forEach((invariant, index) => {
      const first = firstIndex.get(invariant.id);
      if (first !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["invariants", index, "id"],
          message: `Duplicate invariant id "${invariant.id}" (first declared at invariants[${first}].id).`,
        });
      } else {
        firstIndex.set(invariant.id, index);
      }
    });
  });

export type Contract = z.infer<typeof contractSchema>;
export type Invariant = Contract["invariants"][number];

function formatIssuePath(path: PropertyKey[]): string {
  return path.reduce<string>((formatted, part) => {
    if (typeof part === "number") return `${formatted}[${part}]`;
    return formatted ? `${formatted}.${String(part)}` : String(part);
  }, "");
}

export function validateContract(input: unknown): Contract {
  const result = contractSchema.safeParse(input);
  if (result.success) return result.data;

  const details = result.error.issues
    .map((issue) => {
      const path = formatIssuePath(issue.path) || "contract";
      return `${path}: ${issue.message}`;
    })
    .sort();
  const duplicate = result.error.issues.some(
    (issue) =>
      issue.code === "custom" &&
      issue.message.startsWith("Duplicate invariant id"),
  );
  throw new ContractError(
    duplicate ? "duplicate_id" : "invalid_schema",
    duplicate
      ? "Contract contains duplicate invariant ids."
      : "Contract schema is invalid.",
    details,
  );
}

export function validateContractPath(path: string): string {
  const result = relativeFilePathSchema.safeParse(path);
  if (!result.success) {
    throw new ContractError("invalid_schema", "Contract path is invalid.", [
      `contract path: ${result.error.issues[0]?.message ?? "Invalid path."}`,
    ]);
  }
  return result.data;
}
