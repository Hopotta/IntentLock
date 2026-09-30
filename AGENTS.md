# Agent workflow

Before changing repository files, check whether `.intentlock.yml` exists at the repository root. If it does, read `.agents/skills/intentlock/SKILL.md` and follow its workflow, even when the task does not mention IntentLock. This applies to ordinary implementation and refactoring tasks as well as documentation edits under an existing contract. After the edit, run the project's existing test command and then the IntentLock check. Report the test and contract results separately; if either could not run, say so rather than treating the task as complete.

If no contract exists, do not load the IntentLock skill for an ordinary edit. Read it when the user explicitly asks to initialize, check, diagnose, or change an IntentLock contract. For a read-only question that does not ask for verification, the presence of a contract alone does not require the skill.
