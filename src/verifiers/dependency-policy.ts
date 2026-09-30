import type { Invariant } from "../contract/schema.js";
import type { VerificationContext } from "../engine/context.js";
import type { EvidenceItem, VerificationResult } from "../engine/result.js";
import type { Verifier } from "../engine/verifier.js";

type DependencyPolicyInvariant = Extract<
  Invariant,
  { type: "dependency_policy" }
>;
type DependencySection = NonNullable<
  DependencyPolicyInvariant["sections"]
>[number];
type ChangeKind = "added" | "removed" | "version_changed";

interface DependencyChange extends EvidenceItem {
  kind: "dependency_change";
  change: ChangeKind;
  manifest: string;
  section: DependencySection;
  dependency: string;
  baselineVersion?: string;
  currentVersion?: string;
}

const DEFAULT_SECTIONS: DependencySection[] = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const MAX_CHANGE_EVIDENCE = 100;

function parseManifest(
  contents: Buffer,
  path: string,
  revision: "baseline" | "current",
  sections: DependencySection[],
): Record<DependencySection, Record<string, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.toString("utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${revision} manifest ${path} is not valid JSON: ${detail}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${revision} manifest ${path} must contain a JSON object.`);
  }

  const manifest = parsed as Record<string, unknown>;
  const dependencies = Object.create(null) as Record<
    DependencySection,
    Record<string, string>
  >;
  for (const section of sections) {
    const value = manifest[section];
    if (value === undefined) {
      dependencies[section] = {};
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(
        `${revision} manifest ${path} section ${section} must be an object.`,
      );
    }
    const sectionDependencies = Object.create(null) as Record<string, string>;
    for (const [name, version] of Object.entries(value)) {
      if (typeof version !== "string") {
        throw new Error(
          `${revision} manifest ${path} dependency ${name} in ${section} must have a string version.`,
        );
      }
      sectionDependencies[name] = version;
    }
    dependencies[section] = sectionDependencies;
  }
  return dependencies;
}

function disallowed(
  change: ChangeKind,
  policy: DependencyPolicyInvariant,
): boolean {
  if (change === "added") return !policy.allow_additions;
  if (change === "removed") return !policy.allow_removals;
  return !policy.allow_version_changes;
}

export const dependencyPolicyVerifier: Verifier = {
  type: "dependency_policy",
  async verify(invariant, context: VerificationContext) {
    const policy = invariant as DependencyPolicyInvariant;
    const sections = policy.sections ?? DEFAULT_SECTIONS;
    const changes: DependencyChange[] = [];
    const errors: EvidenceItem[] = [];
    const created: EvidenceItem[] = [];
    const deleted: EvidenceItem[] = [];

    for (const manifestPath of policy.manifests) {
      let baselineBytes: Buffer | null;
      let currentBytes: Buffer | null;
      try {
        [baselineBytes, currentBytes] = await Promise.all([
          context.readBaselineFile(manifestPath),
          context.readCurrentFile(manifestPath),
        ]);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        errors.push({
          kind: "dependency_manifest_error",
          manifest: manifestPath,
          message: detail,
        });
        continue;
      }

      if (!currentBytes) {
        if (baselineBytes) {
          deleted.push({
            kind: "dependency_manifest_deleted",
            manifest: manifestPath,
            message: `Configured manifest ${manifestPath} existed at the baseline and was deleted in the current patch. Restore it or remove it from the dependency policy.`,
            allowed: false,
          });
        } else {
          errors.push({
            kind: "dependency_manifest_error",
            manifest: manifestPath,
            message: `Configured manifest ${manifestPath} is missing from the baseline and current repository.`,
          });
        }
        continue;
      }

      if (!baselineBytes) {
        created.push({
          kind: "dependency_manifest_created",
          manifest: manifestPath,
        });
      }

      let baseline: Record<DependencySection, Record<string, string>>;
      let current: Record<DependencySection, Record<string, string>>;
      try {
        baseline = baselineBytes
          ? parseManifest(baselineBytes, manifestPath, "baseline", sections)
          : (Object.fromEntries(
              sections.map((section) => [section, {}]),
            ) as Record<DependencySection, Record<string, string>>);
        current = parseManifest(
          currentBytes,
          manifestPath,
          "current",
          sections,
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        errors.push({
          kind: "dependency_manifest_error",
          manifest: manifestPath,
          message: detail,
        });
        continue;
      }

      for (const section of sections) {
        const before = baseline[section];
        const after = current[section];
        const names = [
          ...new Set([...Object.keys(before), ...Object.keys(after)]),
        ].sort();
        for (const dependency of names) {
          const baselineVersion = before[dependency];
          const currentVersion = after[dependency];
          let change: ChangeKind | undefined;
          if (baselineVersion === undefined) change = "added";
          else if (currentVersion === undefined) change = "removed";
          else if (baselineVersion !== currentVersion)
            change = "version_changed";
          if (change) {
            changes.push({
              kind: "dependency_change",
              change,
              manifest: manifestPath,
              section,
              dependency,
              ...(baselineVersion === undefined ? {} : { baselineVersion }),
              ...(currentVersion === undefined ? {} : { currentVersion }),
              allowed: !disallowed(change, policy),
            });
          }
        }
      }
    }

    if (errors.length > 0) {
      const knownViolations = [
        ...deleted,
        ...changes.filter((change) => change.allowed === false),
      ];
      return {
        invariantId: policy.id,
        type: policy.type,
        status: "error",
        severity: policy.severity,
        summary: `${errors.length} configured dependency manifest${errors.length === 1 ? " has" : "s have"} an error.`,
        evidence: [...knownViolations, ...errors],
        durationMs: 0,
      } satisfies VerificationResult;
    }

    const violations = changes.filter((change) => change.allowed === false);
    const violationCount = violations.length + deleted.length;
    const allEvidence = [
      ...deleted,
      ...violations,
      ...created,
      ...changes.filter((change) => change.allowed !== false),
    ];
    const evidence = allEvidence.slice(
      0,
      allEvidence.length > MAX_CHANGE_EVIDENCE
        ? MAX_CHANGE_EVIDENCE - 1
        : MAX_CHANGE_EVIDENCE,
    );
    if (evidence.length < allEvidence.length) {
      evidence.push({
        kind: "dependency_evidence_truncated",
        omittedCount: allEvidence.length - evidence.length,
        limit: MAX_CHANGE_EVIDENCE,
      });
    }

    const counts = {
      added: violations.filter((item) => item.change === "added").length,
      removed: violations.filter((item) => item.change === "removed").length,
      versionChanged: violations.filter(
        (item) => item.change === "version_changed",
      ).length,
    };
    const summary =
      violationCount > 0
        ? `${violationCount} dependency policy violation${violationCount === 1 ? "" : "s"}: ${[
            deleted.length
              ? `${deleted.length} configured manifest${deleted.length === 1 ? " was" : "s were"} deleted`
              : "",
            counts.added
              ? `${counts.added} addition${counts.added === 1 ? "" : "s"}`
              : "",
            counts.removed
              ? `${counts.removed} removal${counts.removed === 1 ? "" : "s"}`
              : "",
            counts.versionChanged
              ? `${counts.versionChanged} version change${counts.versionChanged === 1 ? "" : "s"}`
              : "",
          ]
            .filter(Boolean)
            .join(", ")}.`
        : changes.length > 0
          ? `All ${changes.length} dependency change${changes.length === 1 ? " is" : "s are"} allowed by policy.`
          : "Configured dependency manifests are unchanged.";

    return {
      invariantId: policy.id,
      type: policy.type,
      status: violationCount > 0 ? "fail" : "pass",
      severity: policy.severity,
      summary,
      evidence,
      durationMs: 0,
    } satisfies VerificationResult;
  },
};
