# IntentLock skill evaluations

`cases.json` contains prompts and expected behavior. The runner puts the canonical skill from `.agents/skills/intentlock/` and the repository's `AGENTS.md` entry point into a fresh, repo-contained Git fixture for every selected case. The entry point tells coding agents to inspect a repository contract before ordinary edits; skill description matching alone cannot reliably detect a contract that the user did not mention. The runner also copies the built IntentLock CLI and its runtime dependencies, exposes a fixture-local `intentlock` shim to Codex-run shells, then records the model-visible prompt input and the complete Codex JSONL run. A CLI preflight verifies the copied executable. Cases use a read-only sandbox unless `context.requires_write` is true.

Run selected cases from the repository root:

```bash
python skill/evals/run.py --case direct-verify-patch --case negative-explain-sorting
```

Run the full set by omitting `--case`. Traces go to `skill/evals/results/<UTC timestamp>/`; each case has `cli-preflight.stdout`, `prompt-input.stdout`, `exec.stdout` (JSONL), `exec.stderr`, `discovery.json`, and `review.md`. Summary files include per-case and aggregate token counts when Codex reports them; `codex exec` does not provide USD cost. Generated results are ignored by Git. The runner deletes each disposable fixture after trace collection and refuses output paths outside this directory.

## Interpreting a run

The harness does not report an automatic activation or behavior pass. The CLI's `debug prompt-input` trace can show that `intentlock` was discovered from the fixture's `.agents/skills/` directory, but availability does not prove the model selected it. `codex exec --json` currently has no documented skill-activation event. Review the JSONL tool actions and final answer against the expected behavior in `cases.json`; do not count a keyword mention or self-report as proof of activation.

Each `review.md` starts with activation and behavior expectations for manual grading. Fill in the reviewer judgment and check each behavior after examining the full trace. Model responses can vary, so compare the actual actions and advice to the case rubric rather than grading a specific wording.
