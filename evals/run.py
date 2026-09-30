#!/usr/bin/env python3
"""Run IntentLock skill evaluation prompts in disposable local repositories.

The Codex CLI does not currently emit a documented skill-activation event.
This runner therefore preserves prompt-input and JSONL execution traces for
manual review; it does not infer activation from words in the answer.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import time
from typing import Any


EVALS_DIR = Path(__file__).resolve().parent
REPO_ROOT = EVALS_DIR.parent
SKILL_DIR = REPO_ROOT / "skill"
SKILL_NAME = "intentlock"


def read_cases(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("schema_version") != 1 or payload.get("skill") != SKILL_NAME:
        raise ValueError("cases.json must use schema_version 1 and skill 'intentlock'")
    cases = payload.get("cases")
    if not isinstance(cases, list) or not cases:
        raise ValueError("cases.json must contain a non-empty cases array")
    seen: set[str] = set()
    for case in cases:
        case_id = case.get("id")
        if (
            not isinstance(case_id, str)
            or not case_id
            or not re.fullmatch(r"[a-z0-9-]+", case_id)
            or case_id in seen
        ):
            raise ValueError(f"case IDs must be non-empty and unique: {case_id!r}")
        seen.add(case_id)
        if not isinstance(case.get("prompt"), str) or not isinstance(case.get("expected"), dict):
            raise ValueError(f"case {case_id!r} requires prompt and expected fields")
    return cases


def run(
    command: list[str],
    *,
    cwd: Path,
    timeout: int = 300,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        timeout=timeout,
        env=env,
        check=False,
    )


def write_files(root: Path, files: dict[str, Any]) -> None:
    for relative, content in files.items():
        target = (root / relative).resolve()
        if not target.is_relative_to(root.resolve()):
            raise ValueError(f"fixture file escapes repository root: {relative!r}")
        target.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, (dict, list)):
            target.write_text(json.dumps(content, indent=2) + "\n", encoding="utf-8", newline="\n")
        else:
            target.write_text(str(content), encoding="utf-8", newline="\n")


def git(cwd: Path, *args: str) -> None:
    result = run(["git", *args], cwd=cwd)
    if result.returncode:
        raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr.strip()}")


def make_fixture(case: dict[str, Any], root: Path) -> None:
    context = case.get("context") or {}
    fixture_files = context.get("fixture_files") or {}
    default_baseline_contract = context.get(
        "repository_has_intentlock_yml", ".intentlock.yml" in fixture_files
    )
    baseline_has_contract = context.get("baseline_has_contract", default_baseline_contract)
    if not fixture_files:
        fixture_files = {
            "package.json": '{"name":"intentlock-eval-fixture","scripts":{"test":"node --test"}}\n',
            "src/parser.js": "export function parseDate(input) { return new Date(input); }\n",
            "README.md": "Disposable repository used by the IntentLock skill evaluation.\n",
        }
        if context.get("repository_has_intentlock_yml", False) or baseline_has_contract:
            fixture_files[".intentlock.yml"] = "version: 1\ndefaults:\n  base: main\ninvariants: []\n"

    root.mkdir(parents=True)
    write_files(root, fixture_files)
    agent_instructions = REPO_ROOT / "AGENTS.md"
    if (root / "AGENTS.md").exists():
        raise ValueError("fixture files must not replace the IntentLock agent entry point")
    shutil.copy2(agent_instructions, root / "AGENTS.md")
    git_context = context.get("git_context") or {}
    base_available = git_context.get("default_base_available", True)
    current_branch = "main" if base_available else "eval-current"
    git(root, "init", "-b", current_branch)
    git(root, "config", "core.autocrlf", "false")
    git(root, "config", "user.name", "IntentLock Eval")
    git(root, "config", "user.email", "intentlock-eval@example.invalid")

    # Build the requested baseline before applying working-tree-only state.
    if not baseline_has_contract:
        (root / ".intentlock.yml").unlink(missing_ok=True)
    git(root, "add", "-A")
    git(root, "commit", "-m", "evaluation baseline")

    # Make only explicitly known trusted alternate refs available. For the
    # missing-default-base case, main stays absent by construction.
    for base in git_context.get("known_trusted_alternate_bases", []):
        git(root, "branch", str(base))

    # A baseline-only contract can be removed from the worktree by cases that
    # model divergence. A worktree-only contract can be supplied here as well.
    if context.get("repository_has_intentlock_yml") is False and baseline_has_contract:
        (root / ".intentlock.yml").unlink(missing_ok=True)
    write_files(root, context.get("working_tree_files") or {})

    skill_target = root / ".agents" / "skills" / SKILL_NAME
    skill_target.mkdir(parents=True, exist_ok=True)
    shutil.copy2(SKILL_DIR / "SKILL.md", skill_target / "SKILL.md")
    refs = SKILL_DIR / "references"
    if refs.is_dir():
        shutil.copytree(refs, skill_target / "references", dirs_exist_ok=True)
    agents = SKILL_DIR / "agents"
    if agents.is_dir():
        shutil.copytree(agents, skill_target / "agents", dirs_exist_ok=True)

    # The skill is injected as environment context, while AGENTS.md is a
    # tracked repository instruction. Neither is part of the test patch.
    exclude = root / ".git" / "info" / "exclude"
    with exclude.open("a", encoding="utf-8") as stream:
        stream.write("\n/.agents/skills/intentlock/\n/dist/\n/node_modules/\n")

    # The cases need to exercise the documented `node dist/cli.js` path. Ship
    # the already-built CLI and only its production runtime dependencies into
    # each temporary repository so a model can run real checks offline.
    dist = root / "dist"
    dist.mkdir(exist_ok=True)
    shutil.copy2(REPO_ROOT / "dist" / "cli.js", dist / "cli.js")
    (dist / "package.json").write_text('{"type":"module"}\n', encoding="utf-8")
    modules = root / "node_modules"
    modules.mkdir(exist_ok=True)
    for package in ("commander", "picomatch", "yaml", "zod"):
        source = REPO_ROOT / "node_modules" / package
        if not source.exists():
            raise FileNotFoundError(f"required runtime dependency is missing: {source}")
        shutil.copytree(source, modules / package, dirs_exist_ok=True)
    bin_dir = modules / ".bin"
    bin_dir.mkdir(exist_ok=True)
    (bin_dir / "intentlock.cmd").write_text(
        '@echo off\r\nnode "%~dp0..\\..\\dist\\cli.js" %*\r\n', encoding="utf-8"
    )
    unix_shim = bin_dir / "intentlock"
    unix_shim.write_text(
        '#!/bin/sh\nexec node "$(dirname "$0")/../../dist/cli.js" "$@"\n', encoding="utf-8"
    )
    unix_shim.chmod(unix_shim.stat().st_mode | 0o111)


def remove_fixture(fixture_root: Path, run_dir: Path) -> None:
    fixtures_root = (run_dir / ".fixtures").resolve()
    if fixture_root.is_symlink():
        raise RuntimeError(f"refusing to remove fixture symlink: {fixture_root}")
    resolved = fixture_root.resolve()
    if resolved.parent != fixtures_root or resolved.name in ("", ".", ".."):
        raise RuntimeError(f"refusing to clean unexpected fixture path: {resolved}")
    if resolved.is_symlink():
        raise RuntimeError(f"refusing to remove fixture symlink: {resolved}")
    if resolved.exists():
        def make_writable_and_retry(function: Any, path: str, _exc_info: Any) -> None:
            if Path(path).is_symlink():
                function(path)
                return
            current_mode = os.stat(path, follow_symlinks=False).st_mode
            owner_access = stat.S_IRUSR | stat.S_IWUSR
            if stat.S_ISDIR(current_mode):
                owner_access |= stat.S_IXUSR
            os.chmod(path, current_mode | owner_access)
            function(path)

        shutil.rmtree(resolved, onerror=make_writable_and_retry)


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def decode_capture(value: str | bytes | None) -> str:
    if value is None:
        return ""
    return value.decode("utf-8", errors="replace") if isinstance(value, bytes) else value


def usage_from_jsonl(path: Path) -> dict[str, int] | None:
    totals: dict[str, int] = {}
    found = False
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") != "turn.completed" or not isinstance(event.get("usage"), dict):
            continue
        found = True
        for key, value in event["usage"].items():
            if isinstance(value, int):
                totals[key] = totals.get(key, 0) + value
    return totals if found else None


def save_process(case_dir: Path, stem: str, result: subprocess.CompletedProcess[str]) -> dict[str, Any]:
    write_text(case_dir / f"{stem}.stdout", result.stdout)
    write_text(case_dir / f"{stem}.stderr", result.stderr)
    return {"exit_code": result.returncode, "stdout_file": f"{stem}.stdout", "stderr_file": f"{stem}.stderr"}


def text_values(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [text for item in value for text in text_values(item)]
    if isinstance(value, dict):
        return [text for item in value.values() for text in text_values(item)]
    return []


def isolated_codex_env(fixture_root: Path) -> dict[str, str]:
    # Codex normally filters inherited variables for model-run commands. Pass
    # only the OS/runtime variables needed by the local shell plus PATH, and
    # prepend the fixture shim directory. Do not expose API keys or tokens.
    allowed = {
        "PATH",
        "SYSTEMROOT",
        "WINDIR",
        "COMSPEC",
        "PATHEXT",
        "PSMODULEPATH",
        "SYSTEMDRIVE",
        "HOMEDRIVE",
        "HOMEPATH",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "HOME",
        "CODEX_HOME",
        "LANG",
        "TERM",
        "PROMPT",
    }
    env = {key: value for key, value in os.environ.items() if key.upper() in allowed}
    shim_dir = str(fixture_root / "node_modules" / ".bin")
    env["PATH"] = shim_dir + os.pathsep + env.get("PATH", "")
    return env


def evaluate_case(case: dict[str, Any], run_dir: Path, codex: str, model: str, effort: str, timeout: int) -> dict[str, Any]:
    case_id = case["id"]
    case_dir = run_dir / "cases" / case_id
    case_dir.mkdir(parents=True, exist_ok=True)
    fixture_root = run_dir / ".fixtures" / case_id
    fixture_root.parent.mkdir(parents=True, exist_ok=True)
    make_fixture(case, fixture_root)
    write_text(case_dir / "prompt.txt", case["prompt"] + "\n")

    cli_preflight = run(["node", "dist/cli.js", "--help"], cwd=fixture_root, timeout=30)
    cli_availability = save_process(case_dir, "cli-preflight", cli_preflight)

    started = time.monotonic()
    prompt_input = run([codex, "debug", "prompt-input", case["prompt"]], cwd=fixture_root, timeout=timeout)
    discovery = save_process(case_dir, "prompt-input", prompt_input)
    try:
        visible_prompt_input = "\n".join(text_values(json.loads(prompt_input.stdout)))
    except json.JSONDecodeError:
        visible_prompt_input = prompt_input.stdout
    normalized_input = visible_prompt_input.replace("\\", "/")
    root_path = fixture_root.as_posix().rstrip("/") + "/.agents/skills"
    root_match = re.search(r"- `(r\d+)` = `" + re.escape(root_path) + r"`", normalized_input)
    skill_match = re.search(r"- intentlock:.*?\(file: (r\d+)/intentlock/SKILL\.md\)", normalized_input)
    discovery["canonical_root_listed"] = root_match is not None
    discovery["skill_entry_listed"] = skill_match is not None
    discovery["skill_entry_uses_fixture_root"] = bool(root_match and skill_match and root_match.group(1) == skill_match.group(1))
    (case_dir / "discovery.json").write_text(json.dumps(discovery, indent=2) + "\n", encoding="utf-8")

    sandbox = "workspace-write" if (case.get("context") or {}).get("requires_write", False) else "read-only"
    cmd = [
        codex,
        "exec",
        "--ephemeral",
        "--json",
        "--cd",
        str(fixture_root),
        "--skip-git-repo-check",
        "--sandbox",
        sandbox,
        "--model",
        model,
        "-c",
        'shell_environment_policy.inherit="all"',
        "-c",
        f'model_reasoning_effort="{effort}"',
        case["prompt"],
    ]
    exec_env = isolated_codex_env(fixture_root)
    try:
        execution = run(cmd, cwd=fixture_root, timeout=timeout, env=exec_env)
        exec_result = save_process(case_dir, "exec", execution)
    except subprocess.TimeoutExpired as exc:
        execution = None
        exec_result = {"timeout_seconds": timeout, "timed_out": True}
        write_text(case_dir / "exec.stdout", decode_capture(exc.stdout))
        write_text(case_dir / "exec.stderr", decode_capture(exc.stderr))

    review = [
        f"# Manual review: {case_id}",
        "",
        "Codex CLI currently has no documented skill-activation event. Review the full JSONL trace and output; do not infer activation from keyword occurrence or self-report alone.",
        "",
        f"- Expected activation: `{case['expected'].get('activation')}`",
        f"- Expected activation mode: `{case['expected'].get('activation_mode')}`",
        f"- Prompt-input trace exit code: `{discovery['exit_code']}` (availability evidence only)",
        f"- Execution exit code: `{exec_result.get('exit_code', 'timeout')}`",
        "- Reviewer judgment: **pending**",
        f"- Local CLI preflight exit code: `{cli_availability['exit_code']}`",
        "",
        "## Expected behavior to assess",
        "",
    ]
    review.extend(f"- [ ] {item}" for item in case["expected"].get("behavior", []))
    review.extend(["", "## Evidence files", "", "- `cli-preflight.stdout`", "- `prompt-input.stdout`", "- `exec.stdout` (JSONL event trace)", "- `exec.stderr`"])
    write_text(case_dir / "review.md", "\n".join(review) + "\n")

    remove_fixture(fixture_root, run_dir)
    usage = usage_from_jsonl(case_dir / "exec.stdout")
    metadata = {
        "case_id": case_id,
        "category": case.get("category"),
        "expected": case["expected"],
        "prompt_input": discovery,
        "execution": exec_result,
        "usage_tokens": usage,
        "cli_preflight": cli_availability,
        "sandbox": sandbox,
        "elapsed_seconds": round(time.monotonic() - started, 2),
        "activation_result": "ungraded: CLI exposes no documented activation signal",
        "fixture_path": "removed after trace collection (repo-contained disposable fixture)",
    }
    (case_dir / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    return metadata


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", action="append", dest="case_ids", help="case ID to run; repeat to select several")
    parser.add_argument("--cases-file", type=Path, default=EVALS_DIR / "cases.json")
    parser.add_argument("--output-dir", type=Path, help="trace directory (defaults to evals/results/<UTC timestamp>)")
    parser.add_argument("--model", default="gpt-6-luna")
    parser.add_argument("--effort", default="high")
    parser.add_argument("--timeout", type=int, default=300)
    args = parser.parse_args()

    codex = shutil.which("codex")
    if not codex:
        parser.error("codex CLI was not found on PATH")
    cases = read_cases(args.cases_file)
    selected = set(args.case_ids or [])
    if selected:
        missing = selected - {case["id"] for case in cases}
        if missing:
            parser.error(f"unknown case ID(s): {', '.join(sorted(missing))}")
        cases = [case for case in cases if case["id"] in selected]

    timestamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_dir = (args.output_dir or (EVALS_DIR / "results" / timestamp)).resolve()
    if not run_dir.is_relative_to(EVALS_DIR):
        parser.error("--output-dir must stay inside evals so disposable fixtures remain repo-contained")
    run_dir.mkdir(parents=True, exist_ok=False)
    (run_dir / ".fixtures").mkdir()
    results = []
    for case in cases:
        print(f"Running {case['id']} ...", flush=True)
        results.append(evaluate_case(case, run_dir, codex, args.model, args.effort, args.timeout))

    usage_totals: dict[str, int] = {}
    cases_with_usage = 0
    for case_result in results:
        case_usage = case_result.get("usage_tokens")
        if case_usage is None:
            continue
        cases_with_usage += 1
        for key, value in case_usage.items():
            usage_totals[key] = usage_totals.get(key, 0) + value

    summary = {
        "skill": SKILL_NAME,
        "run_id": timestamp,
        "model": args.model,
        "reasoning_effort": args.effort,
        "cases": results,
        "usage_tokens_total": usage_totals,
        "cases_with_usage": cases_with_usage,
        "usd_cost": "not provided by codex exec JSONL",
        "status": "trace collection complete; manual review required",
        "limitations": [
            "Codex CLI does not emit a documented skill-activation event.",
            "Prompt-input output shows availability/discovery, not model selection.",
            "No activation or behavior pass is inferred automatically.",
        ],
    }
    (run_dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(f"Traces: {run_dir}")
    print("Status: trace collection complete; review each cases/*/review.md against cases/*/exec.stdout")
    return 0 if all(case["execution"].get("exit_code") == 0 for case in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
