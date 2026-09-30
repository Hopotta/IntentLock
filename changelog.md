# Changelog

All notable changes to IntentLock are recorded here.

## [Unreleased]

- Dogfood IntentLock with a repository policy that protects selected design and toolchain files, blocks dependency additions, and runs tests; run the built CLI in cross-platform CI after fetching full Git history.
- Reject `doctor --contract` paths outside the repository and clarify that secure pull request enforcement requires a separately trusted checker and workflow.
- Make `doctor --contract` reject symlinks that resolve outside the repository, and clarify default-base selection when no baseline contract exists.
- Keep successful command logs out of terminal reports while retaining output for failed commands.
- Add `intentlock init` with safe no-overwrite behavior and `--force`, plus read-only `intentlock doctor` diagnostics that inspect command availability without running verifier commands.
- Add contract and verifier references, GitHub Actions guidance, minimal and Node examples, and README coverage of the baseline policy trust model.
- Expand CI quality checks across Ubuntu, Windows, and macOS with Node.js 20 and 22.
- Add schema-versioned JSON and actionable terminal reports, report-file output, verbose details, repo/policy/warning CLI options, secure trusted-default base resolution, untracked counts, and expanded CLI/report coverage.
- Add the `command` verifier with platform-shell execution from the repository root, a 120-second default timeout, bounded output capture, process-tree timeout termination, environment-error handling, trusted-policy source evidence, and unit plus temporary-Git coverage.
- Add the `structured_value` verifier for unchanged JSON/YAML selections, including array indexes, safe bounded evidence, and temporary-Git coverage.
- Add the Node `dependency_policy` verifier with deterministic package section comparisons, configurable addition/removal/version rules, manifest creation/deletion handling, bounded evidence, and temporary-Git coverage.
- Fix singular grammar in file-scope failure summaries.
- Add the first usable `intentlock check --base <ref>` vertical slice with a built-in `file_scope` verifier, picomatch globs, rename-aware POSIX path matching, evidence, policy-source reporting, and stable CLI exit codes.
- Add temporary-Git CLI integration coverage for in-scope changes, out-of-scope `README.md`, baseline contract tamper resistance, and configuration/environment errors.
- Document the minimal contract, glob behavior, trusted policy behavior, exit codes, and implemented slice status in the README.
- Add the sequential verification engine, shared Git-backed context, verifier registry, result/evidence model, aggregate status, and exit-code handling for warnings.
- Add a Git snapshot engine for repository discovery, base and merge-base resolution, effective changed-file collection, and baseline/current file reads.
- Add temporary-repository integration coverage for working-tree states, renames, ignored files, divergent branches, and safe path reads.
- Add strict version 1 YAML contract validation and baseline/worktree policy source selection with tamper warning metadata.
- Add Zod and YAML parsing dependencies for the contract loader.
- Accept the documented minimal `file_scope` contract without a description while rejecting empty descriptions.
- Initialize the TypeScript and pnpm CLI repository.
- Add build, lint, test, typecheck, and CI foundations.
- Add the `intentlock --help` and `intentlock --version` entry points.
