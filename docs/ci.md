# GitHub Actions

IntentLock needs enough Git history to resolve the merge base. Use `actions/checkout` with `fetch-depth: 0`; a shallow checkout can make a valid base ref unavailable. When the contract exists at the selected merge base, IntentLock uses that baseline policy, so a pull request cannot weaken the policy just by editing `.intentlock.yml`.

That policy protection assumes the IntentLock executable and CI workflow are trusted. To enforce policy against untrusted pull requests, run a separately trusted, pinned IntentLock installation and use the baseline policy. Do not build the checker from the pull request checkout: the patch could modify the checker itself. Protect the workflow configuration too.

IntentLock has not yet been published to npm. For a repository consuming a released package, install its published version in the workflow and run:

```yaml
- run: npm install --global intentlock@<trusted-version>
- run: intentlock check --base "origin/${{ github.base_ref }}"
```

IntentLock is not yet published, so the following local-build workflow is only a dogfooding and quality demonstration. It builds the checker from the pull request checkout and must not be treated as a security boundary against an adversarial pull request:

```yaml
name: IntentLock
on:
  pull_request:
jobs:
  intentlock:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - uses: pnpm/action-setup@v4
        with:
          version: 9.15.9
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: node dist/cli.js check --base "origin/${{ github.base_ref }}"
```

Use a trusted base ref and do not opt into `--policy-source worktree` for untrusted pull requests. Any command verifiers in the trusted baseline policy execute repository commands; review those commands as executable code.
