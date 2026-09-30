# Verifier reference

Every invariant requires a unique `id`, a supported `type`, and `severity: error | warn`. `description` is optional. Failures include evidence in terminal and JSON reports.

## `file_scope`

```yaml
- id: source-scope
  type: file_scope
  severity: error
  description: Limit changes to source and tests.
  allow: ["src/**", "tests/**"]
  deny: ["src/generated/**"]
```

At least one of `allow` or `deny` is required, and each supplied list must be non-empty. `allow` limits changed paths; `deny` always rejects matching paths and takes precedence. With only `deny`, other paths are allowed. Renames are checked using both old and new paths.

## `dependency_policy`

```yaml
- id: dependencies
  type: dependency_policy
  severity: error
  manifests: ["package.json"]
  allow_additions: false
  allow_removals: true
  allow_version_changes: true
  sections:
    [dependencies, devDependencies, optionalDependencies, peerDependencies]
```

`manifests` is a non-empty list of repository-relative Node `package.json` paths. Each of the three `allow_*` flags is required. `sections` is optional and defaults to all four listed dependency sections.

## `structured_value`

```yaml
- id: preserve-width
  type: structured_value
  severity: error
  file: "src/config.json"
  format: json
  selector: "$.window.width"
  expectation: unchanged
```

`format` is `json` or `yaml`; `selector` supports object properties and numeric array indices, such as `$.targets[0].name`. The selected value must be unchanged between baseline and current content.

## `command`

```yaml
- id: tests
  type: command
  severity: error
  description: Run the test suite.
  run: "pnpm test"
  timeout_seconds: 120
```

`run` is a non-empty shell command executed from the repository root during `intentlock check`. `timeout_seconds` is optional and defaults to 120 seconds. Captured output is bounded. The command verifier executes repository-controlled commands, so only run contracts from a source you trust. `intentlock doctor` checks whether the command's first executable is present on `PATH`; it does not execute it.
