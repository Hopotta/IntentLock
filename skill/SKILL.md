---
name: intentlock
description: Skip documentation-only edits when no `.intentlock.yml` exists and IntentLock is not requested. Apply IntentLock to changes in repositories with an existing contract, or when the user asks to initialize, check, diagnose, or change a contract.
---

# IntentLock

Skip the IntentLock workflow for documentation-only edits when no `.intentlock.yml` exists and the user did not request IntentLock. An existing contract applies to repository changes; explicit requests to initialize, check, diagnose, or change a contract also apply. IntentLock checks declared deterministic invariants against a Git patch; it does not prove semantic correctness or general code safety.

## Workflow

1. At the start of an ordinary coding task, look for `.intentlock.yml` and inspect its current rules. Treat it as the repository's persistent policy. Never edit, weaken, or remove it just to make a patch pass; change policy only when the user explicitly asks for a policy change.
2. Identify the intended base ref and whether the user explicitly wants a separate one-off task contract. Keep persistent rules in `.intentlock.yml`; use another repository-relative file with `--contract <path>` only when a separate contract is requested. `--contract` selects one contract; it does not combine it with `.intentlock.yml`. If both checks are required, run each contract separately and report both results. For example, `intentlock check --base origin/main --contract .intentlock/tasks/task.yml --format json --verbose` checks only that task contract. A worktree-only contract is untrusted; `--policy-source worktree` makes that choice explicit. `--policy-source baseline` is suitable only when the selected contract exists at the base.
3. If no contract exists and the user wants one, run `intentlock init`, then add only the requested invariants. `init` creates an empty starter and preserves an existing contract; use `--force` only when replacement is intended. `--yes` is accepted for scripted initialization.
4. Implement the requested change and run the project's normal tests; resolve failures before treating the task as complete, and report if no test suite exists or tests cannot run. Then run `intentlock check` against the intended base with `--format json --verbose`. The patch includes committed, staged, unstaged, and untracked non-ignored changes relative to the Git merge base; renames check both paths. Inspect the JSON policy trust, invariant statuses, and evidence. When summarizing a check, report its policy source/trust and any policy warnings (such as `policy-modified`), including when invariants fail. Treat the deterministic report as the completion gate; do not substitute model judgment for it. If an invariant fails, fix the implementation within the authorized scope and rerun tests and the check. Do not weaken policy to clear a failure unless the task explicitly requests a policy change.

Use `intentlock doctor` when setup needs diagnosis: it checks Git, the current contract schema, base availability, dependency manifests, and command executable availability without running verifier commands. It reads the current contract and may use its `defaults.base` for diagnostics; this does not establish the trusted policy or base used by `check`.

For a globally installed CLI, use `intentlock <command>`. If the bare command is unavailable, look for a runnable local IntentLock CLI, such as `node dist/cli.js` or a project package command, and use it before treating the CLI as unavailable. If none exists, report verification as incomplete, never as a pass. In this repository before publication, build and run `node dist/cli.js <command>` (for example, `corepack pnpm build && node dist/cli.js check --base main --format json --verbose`); do not assume a published npm package or a locally linked command exists.

## Trust and policy safety

- `check` defaults to `--policy-source auto`: if the selected merge base contains the contract, that baseline copy is used and is trusted as policy input; edits to the worktree copy are reported as a warning. If the baseline contract is missing, the worktree copy is used and marked untrusted. `baseline` requires a baseline contract. `worktree` explicitly selects an untrusted current copy.
- Without `--base`, check starts from `main`. Only a trusted contract at that implicit baseline may steer the base through `defaults.base`; a worktree contract cannot. If `main` is unavailable, pass an available ref explicitly with `--base <ref>`. Explicit `--base` takes precedence over the default.
- Baseline policy semantics protect policy from edits in the patch; they do not protect against a checker or CI workflow changed by that patch. For untrusted pull requests, use a separately trusted IntentLock executable and workflow, full Git history, and a trusted base. Do not treat a checker built from the pull request checkout as a security boundary.
- A `command` verifier executes its configured shell command from the repository root. Treat trusted contract commands as executable code and review them before running checks. `doctor` only checks the first executable's PATH availability; it does not execute the command.
- IntentLock enforces only its declared deterministic rules. Do not describe a pass as proof the patch is secure, correct, or authorized beyond those rules.

## CLI and outcomes

`init`: `--repo <path>`, `--force`, `--yes`.

`doctor`: `--base <ref>`, `--contract <path>`, `--repo <path>`.

`check`: `--base <ref>`, `--contract <path>`, `--format terminal|json`, `--output <path>`, `--repo <path>`, `--fail-on-warn`, `--policy-source auto|baseline|worktree`, `--verbose`. `--output` is resolved from the repository root. JSON reports use schema version 1 and always include baseline and policy trust metadata; `--verbose` adds changed paths and timing details.

Exit codes: `0` means checks pass (warnings may still be present); `1` means an invariant failed, or a warning is promoted by `--fail-on-warn`; `2` means a contract, repository, environment, or verifier runtime error (such as malformed source data, missing required baseline data, or unavailable or timed-out commands); `3` means an unexpected internal error. A missing current file or selection that violates an invariant is a FAIL (exit `1`), not a verifier error. Doctor uses `2` when required diagnostics fail, while a missing command executable is only a warning and may still yield `0`. Distinguish these outcomes in the completion report. See [contract and invariant details](references/contracts.md).
