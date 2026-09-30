# IntentLock

IntentLock is a CLI-first change-contract system for AI-assisted software development. It verifies not only that a patch works, but that it stayed within the authorized scope of change.

## Trust model

IntentLock protects an established policy from the patch it checks. If `.intentlock.yml` exists at the selected Git merge base, `intentlock check` uses that baseline copy even if the working tree has changed it. The change is reported as a warning. If there is no baseline contract, the current contract is used and marked untrusted. `--policy-source worktree` is an explicit untrusted override. Enforcing this against untrusted pull requests also requires a separately trusted IntentLock executable and CI workflow; a checker built from the pull request checkout can be modified by that patch. Fetch full history and use baseline policy semantics. See the [CI guide](docs/ci.md) for the trust requirements and the local dogfooding workflow.

IntentLock enforces only the deterministic rules declared in the contract. It does not prove that code is safe or semantically correct, and trusted command verifiers can execute repository-controlled commands.

## Quick start

In a Git repository, create a starter policy:

```sh
intentlock init
```

The starter has an empty invariant list. Add the boundaries you want IntentLock to enforce. `init` never replaces an existing contract unless `--force` is supplied; `--yes` is accepted for noninteractive scripts. Run `intentlock doctor` to check repository, contract, base, manifest, and command-executable availability. Doctor does not run verifier commands.

Minimal contract at `.intentlock.yml`:

```yaml
version: 1

defaults:
  base: main

invariants:
  - id: src-only
    type: file_scope
    severity: error
    allow:
      - "src/**"
```

Run the check from anywhere inside the Git repository:

```sh
intentlock check
```

The check compares the patch to the Git merge base, includes committed, staged, unstaged, and untracked changes, and checks both paths of a rename. An explicit `--base` selects the base directly. Without it, IntentLock uses `main`; only a trusted contract at that implicit baseline may set `defaults.base` to another base. A worktree contract is untrusted and cannot steer implicit base selection. If `main` is unavailable, pass an available ref with `--base`. At the selected baseline, an existing contract is used as trusted policy; a worktree-sourced contract remains untrusted. Reports identify whether the selected policy is trusted.

`file_scope` patterns use [picomatch glob syntax](https://github.com/micromatch/picomatch), matched against repository-relative POSIX paths. `deny` patterns take precedence over `allow`; omit `allow` to permit every path not denied. Hidden path segments are included.

See [contract reference](docs/contract-reference.md), [verifier reference](docs/verifier-reference.md), [CI guide](docs/ci.md), and [examples](examples/).

Exit codes: `0` all required checks pass, `1` an invariant is violated, `2` a contract or environment error, and `3` an unexpected internal error.

## Reports and CLI options

Terminal output is the default. Use `--format json` for a versioned machine-readable report, `--output <path>` to write either format to a file, and `--verbose` to include baseline commits, changed paths, and timings. The JSON report uses `schemaVersion: 1` and includes policy trust metadata, baseline resolution, changed and untracked file counts, verifier evidence, and summary counts. Expected contract and repository errors also produce JSON when JSON format is selected.

```sh
intentlock check --repo ./path/to/repo --format json --output report.json
intentlock check --base origin/main --fail-on-warn --verbose
```

`--policy-source` accepts `auto` (default), `baseline`, or `worktree`. Worktree policies are marked untrusted. `--repo` selects the repository directory; by default it is the current working directory.

## Development

Requirements: Node.js 20+ and pnpm 9.

```sh
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm typecheck
```

## Coding-agent skill

The [IntentLock skill](skill/SKILL.md) is published in the visible `skill/` directory, with its [contract reference](skill/references/contracts.md) and [agent metadata](skill/agents/openai.yaml). It guides a coding agent through contract-aware changes: inspect the contract, run the project's normal tests, run `intentlock check` against the intended Git base, and report test results separately from invariant results. The CLI produces the deterministic verdict; the skill helps the agent use that verdict during its workflow.

To use the skill in another repository:

1. Copy the contents of [`skill/`](skill/) into `.agents/skills/intentlock/` in the target repository.
2. Copy the instructions from this repository's [AGENTS.md](AGENTS.md) into the target repository's root `AGENTS.md`, merging with any instructions already there.
3. Commit a `.intentlock.yml` with the invariants you want enforced, and make the IntentLock CLI available to the agent. See [Quick start](#quick-start) for contract setup.

The `AGENTS.md` entry point checks for `.intentlock.yml` before file changes and directs the agent to load the skill when a contract exists, including for tasks that never mention IntentLock. In this repository, the [Codex discovery entry](.agents/skills/intentlock/SKILL.md) points to the public skill; in an installed repository, the copied skill lives at that discovery path. Without a contract, ordinary edits skip this workflow; an explicit request to initialize, check, diagnose, or change a contract still uses the skill. Read-only questions do not require a check unless the user asks for one. Installing the skill alone can miss a generic request such as “finish the refactor,” because the agent may never select it from the request wording.

For an explicit check, ask the agent to use `$intentlock`, or run the CLI directly, for example `intentlock check --base main --format json --verbose`. The agent should report the policy source and trust status, warnings, and each invariant outcome. A passing check means the declared rules passed; it is not a guarantee of semantic correctness or code safety. The [skill evaluation cases](evals/README.md) are kept separately from the installable skill and cover requests with and without a contract.

## Dogfooding

This repository uses [`.intentlock.yml`](.intentlock.yml) to keep selected toolchain configuration stable during ordinary feature work, reject new package dependencies, keep the `package.json` test, build, lint, and typecheck scripts unchanged, and run the test suite. Source, tests, docs, and examples remain available for normal changes. The cross-platform CI fetches full Git history and checks against the pull request's target branch, or `main` for push events.

The CI job builds IntentLock from the checkout it is checking. This demonstrates the workflow and checks policy behavior; it is not a tamper-proof enforcement boundary for untrusted pull requests. See the [CI trust guidance](docs/ci.md) for the separately trusted checker model.

## CLI

```sh
pnpm exec intentlock --help
pnpm exec intentlock --version
pnpm exec intentlock check
```

## Status

See [changelog.md](changelog.md) for release history.
