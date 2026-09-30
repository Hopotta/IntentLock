# Contract reference

IntentLock reads `.intentlock.yml` from the repository root by default. A contract is YAML with a strict version 1 schema. Unknown fields and verifier types are errors.

```yaml
version: 1
project:
  name: example-project
defaults:
  base: main
invariants: []
```

`project` and `defaults` are optional. `defaults.base` is used by `intentlock check` and `intentlock doctor` unless `--base` is supplied. `invariants` is required and may be empty. Each invariant has a unique `id`, a supported `type`, `severity: error | warn`, and an optional non-empty `description`.

## Policy trust

When a contract exists at the selected Git merge base, checks use that baseline version. A changed working-tree contract is reported as a warning; its changes do not affect the check. When no baseline contract exists, auto mode uses the working-tree version and marks it untrusted. `--policy-source worktree` explicitly selects the current file and marks it untrusted. `--policy-source baseline` requires a contract at the baseline. Do not use worktree-sourced contracts as trusted policy for untrusted pull requests.

The baseline is resolved from the requested ref and its merge base with `HEAD`. The check compares committed, staged, unstaged, and untracked non-ignored changes. See [the verifier reference](verifier-reference.md) for invariant details.

## Paths

Contract file and manifest paths must be repository-relative, use `/` separators (Windows separators are normalized), and may not escape the repository. Glob patterns use picomatch syntax and match repository-relative POSIX paths. Git ignore rules apply to untracked-file discovery.

## CLI

`intentlock init [--force] [--yes] [--repo <path>]` creates an empty starter policy. Existing policies are preserved unless `--force` is supplied; `--yes` is accepted for noninteractive scripts (initialization does not prompt).

`intentlock doctor [--base <ref>] [--contract <path>] [--repo <path>]` validates Git/repository access, contract schema, base availability, dependency manifests, and command executable availability. Doctor never runs configured verifier commands.

`intentlock check` supports `--base`, `--contract`, `--format terminal|json`, `--output`, `--repo`, `--fail-on-warn`, `--policy-source auto|baseline|worktree`, and `--verbose`. Exit codes are 0 for pass/warnings, 1 for failed invariants, 2 for contract/repository/environment errors, and 3 for unexpected internal errors.
