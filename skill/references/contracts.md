# Contract and invariant reference

IntentLock accepts strict version 1 YAML contracts. Unknown fields and verifier types are errors. The root requires `version: 1` and `invariants`; `project.name` and `defaults.base` are optional. Invariants need unique machine-readable `id`, `type`, and `severity: error | warn`; non-empty `description` is optional. Contract and manifest paths are repository-relative. Windows separators are normalized, and paths cannot escape the repository.

## Invariant types

- **`file_scope`** — provide a non-empty `allow` list, `deny` list, or both. Patterns use picomatch glob syntax against repository-relative POSIX paths; hidden path segments are included. `deny` wins over `allow`; with only `deny`, all other paths are allowed. Both sides of renames are checked.
- **`dependency_policy`** — compare Node `package.json` dependency sections in one or more `manifests`. Configure required booleans `allow_additions`, `allow_removals`, and `allow_version_changes`. Optional `sections` defaults to `dependencies`, `devDependencies`, `optionalDependencies`, and `peerDependencies`. Deleting a manifest that existed at baseline is a policy violation (FAIL); a manifest missing from both baseline and current content, or malformed content, is a verifier error.
- **`structured_value`** — require a JSON or YAML value selected by `selector` to remain unchanged from baseline to current content. Selectors use `$`, object properties such as `$.scripts.test`, and numeric array indexes such as `$.targets[0].name`. `expectation` must be `unchanged`. A missing current file or selection is a policy violation (FAIL); a missing baseline file or selection, or malformed baseline/current content, is a verifier error.
- **`command`** — run the non-empty `run` shell command from the repository root during `check`. `timeout_seconds` is optional and defaults to 120; captured output is bounded. The command verifier can execute repository-controlled code.

Example:

```yaml
version: 1
defaults:
  base: main
invariants:
  - id: source-only
    type: file_scope
    severity: error
    allow: ["src/**", "tests/**"]
    deny: ["src/generated/**"]
```

## CLI behavior details

- `init` makes an empty starter contract; it never replaces an existing one without `--force`.
- `doctor` validates the current contract and diagnoses its base, manifests, and command executables. It does not check policy trust or run verifier commands. A missing command executable is a warning and can still yield exit code 0.
- `check` uses the contract at the selected base when available in `auto` mode. `--policy-source baseline` requires it. `--policy-source worktree` explicitly selects the current contract and is untrusted. If no baseline contract exists in auto mode, the worktree contract is used as untrusted.
- `check` exit code 2 includes verifier runtime errors, such as missing or malformed selected files, timeouts, or unavailable commands, as well as contract/repository/environment errors. A warning-level invariant failure is reported as a warning and normally exits 0; `--fail-on-warn` promotes that outcome to exit 1.
