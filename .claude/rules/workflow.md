<!-- Shared rule (stacks: base). Maintained outside this repository; local edits are overwritten. -->

# Task workflow

1. **Start** — understand the task from the user or the reviewer. Write the acceptance criteria before writing code; if the task has none, propose them and get them confirmed. If the requirement is ambiguous, ask; do not guess.
2. **Branch** — before the first edit, switch to a branch for the task created from the repository's base branch (`AGENTS.md` → Commands → Base branch). Without a given name use `wip-<short-topic>`.
3. **Implement** — the smallest change that satisfies the criteria. Follow the rules. Stay inside this repository's area; what another repository must do is a message to its owner, not an edit there.
4. **Verify** — run the verification gates (`AGENTS.md` → Commands). Tests must check the acceptance criteria, not the implementation you just wrote (`testing` rule).
5. **Simplify** — KISS / DRY / YAGNI pass over the whole diff (`kiss-dry-yagni` rule). Re-run the affected checks.
6. **Review** — the change is reviewed by someone who did not write it. Fix or answer every finding. Merge only after the reviewer approves.
7. **Document** — knowledge notes, ADRs, `AGENTS.md` and package READMEs (`documentation` rule).
8. **Report** — what changed, the checks run with their outcome, what is left, and every question to the user that is still unanswered (from the repository's `docs/questions.md`, asked again). Follow-ups go to the plan file, not into code. Before the turn ends, the repository's `docs/now.md` is rewritten and its other three session files are brought up to date (`documentation` rule, "The plan file").

Problems noticed outside the task's scope are not fixed silently and not dropped: report them and add them to the plan file. A question to the user is not dropped either when it stays unanswered (missed, scrolled away, cannot be answered yet): it goes into the repository's `docs/questions.md` with its date and is asked again (`documentation` rule, "The plan file").

## CI minutes

The GitHub Actions budget of the organisation is limited and shared by all repositories; package publishing alone takes most of it. Until the user says otherwise:

- Verify locally: run the repository's checks (build, tests, lint) on your machine and name them in the PR description with their outcome. A green local run is the gate for review.
- Do not start workflows by hand and do not re-run them without the user's yes. Releases are batched: publish only what a consumer needs now.
- Put `[skip ci]` into commit messages and the merge commit of changes that do not need CI (docs, agent rules, config without effect on the build).
- Test workflows run only by hand (`workflow_dispatch`), by the user's decision of 2026-11-12; there are no `pull_request` or `push` triggers for tests. Do not add triggers or new jobs; changing workflow triggers is the user's decision. A production deploy on push to its branch stays as it is.
- The CI topic is closed: it is not raised with the user and does not go into the plan file; the documentation about tests is not edited because of it.

## Commit and PR are the consequence of finished work, not its goal

The user's rule (2026-11-19), repeated many times: a commit and a pull request come at the very end, after the work is done and checked. They are not a requirement for finishing and not a next step to offer.

- Work is finished when what the user asked for is done and verified (it runs, it is checked, the docs are updated). Then the commit follows, and the PR when the task calls for one.
- Never list "commit", "push", "open a PR" or "PR not opened" as an open item, a tail or a question to the user while real work is left; and never ask "shall I open the PR?" instead of doing the remaining work.
- A report of what is left names unfinished work (unchecked deploy, unverified behaviour, open bugs), not the commit or PR that will follow it.

## No workarounds: fix the cause in the right place

The user's rule (2026-11-19), for every project. When something does not fit (a value in the wrong shape, a double conversion, a type that does not match, a test that fails for a reason outside the test), do not patch around it where it shows up.

- Find the cause first: is it our code (and whose: this repository, another package, another session's change) or the technology we use (a library, a driver, a framework default)?
- Fix it at the one place where it belongs: the source of the wrong value, or a single normalizer at the boundary where data enters (a DTO transform, a column transformer, a driver setting). Never a second conversion in each consumer, never `if (typeof x === "string") JSON.parse(x)` sprinkled over readers.
- If someone else's change is wrong (another session, a package), decide and put it right, in this repository at once and by a message to the owner for theirs; do not adapt our code to the mistake. Record the decision (an ADR when a reader could take the fix for a mistake).
- A workaround the user explicitly accepts for now is recorded in the plan file with the real fix it waits for.

## Fail fast: a quick check before every slow stage

A slow stage must never be the first thing to find an error a quick check finds in seconds (a build that runs half an hour and then fails on a lint error or a typo). Before each slow stage, run its quick check on **only the files you changed** (`git diff --name-only` against the base plus untracked files), and start the slow stage only when the quick check is green. The order is always: quick checks first, then the slow stages, the cheapest first; stop at the first failure, fix, and restart from the quick check of that stage.

| Stage (slow) | Quick check before it (seconds) |
|---|---|
| Format (prettier over the repo) | `prettier --check` on the changed files |
| Lint (eslint / solhint over the repo) | eslint / solhint on the changed files only |
| Typecheck (`tsc` over a project) | `tsc --noEmit` of the changed package only (its `tsconfig`), or the IDE / `tsc` on the changed files; for Solidity, `hardhat compile` (incremental: recompiles only changed sources) |
| Build (`nest build`, webpack, `build:full`, lerna build) | lint + typecheck of the changed files and packages are green; build the changed package alone (`lerna run build --scope <pkg>`) before the whole monorepo |
| Tests, affected (the specs the change touches) | lint + typecheck of the changed files green; the code compiles |
| Tests, full suite (once per commit) | the affected specs green, lint + typecheck green, the build of the changed packages green |
| Codegen / migrations / contract artifacts | the source compiles; run the generator for the changed module only first |
| Publish / release | full suite and build green on the exact commit being released; `git status` clean; `npm pack --dry-run` (or `lerna changed`) shows the expected files and versions |
| Static analysis (slither, audits) | `hardhat compile` green; run it on the changed contracts first (`slither <file>` / a filter) |

- Before the first slow stage in a repository, find out which quick variant each tool offers there (the package scripts, a `--scope`, a file argument, an incremental flag) and use it; if a stage has no quick variant, say so before starting the slow one.
- In the script that runs the stages (`long-running` rule, Variant 1), the quick checks are the first `[k/N]` steps, each with its exit code, and the script stops (`exit 1`) on the first failing step instead of going on to the next stage.
- Name in the report which quick checks ran before each slow stage.

## Releases: fix everything first, release once

The user's rule (2026-11-19): fixing happens many times, releasing happens once.

- Priority order of work: all planned fixes and changes first, in every repository of the batch (lower levels first); then the checks; the release (version + publish) only at the very end, once per repository.
- Never release after a single small fix while other planned changes for the same package are still open. If a lower package must be published for a higher one to build, finish every change planned for that lower package first, then publish it once.
- Before any release, list what is still planned for each repository of the batch; if anything is open, do it first.
- A release is never a step to offer in the middle of work; it is the last step.

## Sessions

One agent session owns each area: **Packages** (every `@ethberry/*` package), **Framework** (the `framework` app, the main consumer), **Contracts** (repositories `contracts-<network>` — what the framework deploys, e.g. `ethberry/contracts-evm` with the package `@ethberry/framework-contracts` — and `library-<network>` — the building blocks, e.g. `ethberry/library-evm` with the packages `@ethberry/contracts-*`; a session of its own per network: EVM, Tron, Solana, TON), **Review** (coordination, review, order of work, the `framework` docs). The user decides finally.

- An area is changed only by its owner; another session writes to Review what it needs and why. Anything another side consumes (a package API, an ABI, EIP-712 types, an artifact path) is agreed with the consumer before it is implemented.
- Review's ok counts as the user's for commits, pushes, merges and branches; those questions never go to the user. Product, data, credential and destructive decisions do.
- A shared checkout, its `node_modules` and a running stand are touched only with the ok of the session they belong to.

## Definition of Done

- Every acceptance criterion is met and has a test or a recorded manual check that proves it.
- Lint, typecheck/build and the relevant tests were **run** and **passed** in this session, with the command named in the report.
- No new lint suppressions, `any`, double casts (`as unknown as`), `@ts-ignore`, skipped or focused tests, or raised timeouts introduced to get green.
- KISS / DRY / YAGNI pass done.
- Public interfaces (package exports, HTTP contracts, ABIs, events, DTOs, migrations) are backward compatible, or the break is a major version and is stated in the report and the changelog.
- Documentation updated.

## Reporting

Keep three statements apart: **test written**, **test run**, **test passed**. "Verified" means a check ran and passed in this session. When a check was not run, say so and why. When a check failed, show the failing output.

## Git

- Never write code on the base branch or on someone else's branch. Check `git branch --show-current` right before every commit and push; if it is not the task's branch, stop.
- Commit messages follow conventional commits (`fix:`, `feat:`, `feat!:` / `BREAKING CHANGE:` for a major, `chore:`, `docs:`, `test:`), one logical change per commit.
- A pull request targets the base branch. Its description says what changes and why, how it was verified (commands and results), and what is not verified.
- Do not force-push shared branches and do not rewrite pushed history. Tags are not deleted without the user's yes.
- Pull requests are merged with **squash** (one commit per PR on the base branch).
- Work in the repository's main checkout on a task branch: no git worktrees, temporary clones or side checkouts. Uncommitted changes found there are shown to the user, not routed around.
- Before merging in a monorepo, run the root test command (all projects) and name the project count in the PR.
- After a merge, delete the task branch locally; the remote branch is deleted by Review, from a checked list (repository, branch, merged PR, unique commits). A squash-merged branch is not an ancestor of the base branch, so `git branch -d` and "is it merged?" checks by commits say no: check by the pull request instead (`gh pr list --state merged --head <branch>`), then `git push origin --delete <branch>` and `git branch -D <branch>`. A branch with unmerged work that is still wanted stays.
- Uncommitted changes of another session in a shared checkout are not yours: do not stash, reset or commit them.
