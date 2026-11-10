# Shared CI workflows

The template holds the CI, the release and the Pages workflows of the repositories of mark1russell7. Each repository keeps short caller workflows. The callers use the shared workflows from GitHub, so a change in the template gets to each repository.

| File | Type | What it does |
|---|---|---|
| `.github/workflows/reusable-ci.yml` | Workflow | Installs with pnpm and starts the standard scripts of `package.json`. |
| `.github/workflows/reusable-release-build.yml` | Workflow | Builds and packs the published packages, and writes the plan of the tags. |
| `.github/actions/npm-publish` | Action | Publishes the tarballs to npm with trusted publishing (OIDC) and provenance. |
| `.github/workflows/reusable-release-tag.yml` | Workflow | Makes a git tag and a GitHub release for each published version. |
| `.github/workflows/reusable-mutation.yml` | Workflow | Starts the mutation tests of each package with Stryker, with a gate for each package. |
| `.github/workflows/reusable-pages.yml` | Workflow | Builds a site, adds the Releases page and the Status page, and deploys it to GitHub Pages. |
| `.github/actions/security-scan` | Action | Scans the dependencies and the code with the dependency review, osv-scanner and CodeQL, in one job. |
| `.github/workflows/reusable-security.yml` | Workflow | Deprecated. The same scans in three jobs ("Security", "The old workflow"). |
| `.github/workflows/reusable-ai-review.yml` | Workflow | Gives a pull request a review by Claude on request (the `ai-review` label), comment only (`AI-REVIEW.md`). |
| `.github/workflows/reusable-codex-review.yml` | Workflow | Gives a pull request a second review by an OpenAI model, comment only (`CODEX-REVIEW.md`). |

## CI

The job of `reusable-ci.yml` installs the dependencies with pnpm. The version of pnpm comes from `packageManager` in `package.json`. Then the job starts each script of the list that `package.json` has. It skips the other scripts. Thus most repositories need no inputs:

```yaml
jobs:
  ci:
    uses: mark1russell7/template/.github/workflows/reusable-ci.yml@<commit> # main
```

The job starts all the scripts, also after a failure. Then it fails with the names of the failed scripts. The summary of the run shows a table of the scripts.

| Input | Default | What it sets |
|---|---|---|
| `scripts` | `format:check typecheck lint check:conventions test build check:boundaries check:api lint:ste` | The scripts, in sequence. `check:conventions` is the conventions check of `@mark1russell7/conventions`. `check:boundaries` is the import check of `@mark1russell7/boundaries`. `check:api` is the check of the public API of `@mark1russell7/api-report`. |
| `recursive-scripts` | `build` | The scripts that run in each package when the root `package.json` does not have them. |
| `node-versions` | `["26"]` | The Node.js versions of the matrix, as JSON. |
| `os` | `["ubuntu-latest"]` | The runners of the matrix, as JSON. |
| `setup` | (empty) | A command after the install, before the scripts. |
| `cue-version` | (empty) | The version of the cue CLI, for example `0.15.1`. The action `setup-cue` installs it before the install, with retries and a sha256 check. Do not download the CLI in `setup` (the rule `setup-cue`). |
| `run` | (empty) | A command after the scripts. |
| `env` | `{}` | The environment variables of the job, as a JSON object. |
| `working-directory` | `.` | The folder of `package.json`. |
| `fetch-depth` | `2` | The commits of the checkout. `0` gets the whole history. With `2`, the checkout of a pull request has the parents of its merge commit. On a pull request, the job then deepens the checkout to the merge base, so `check:conventions` reads each commit of the change and the versions at the merge base. On a push to the default branch, the job fetches the commit before the push, for the rule `unreleased-change`. |
| `timeout-minutes` | `15` | The time limit of each job of the matrix. The job `coverage` has its own limit. |
| `changesets` | `true` | The changeset check on a pull request (refer to the next section). |
| `changeset-ignore` | (empty) | More globs of files that need no changeset. |
| `coverage` | `false` | The job `coverage` starts the tests of each package with Vitest again, with coverage. A failure fails the CI (refer to "Coverage"). |
| `coverage-floor` | `0` | The lowest percent of each measure of each package. `0` is no floor. |
| `coverage-on-main` | `true` | With `coverage: false`, a push to the default branch of a public repository still gives the coverage, not strict. It does not fail the CI (refer to "Coverage"). |
| `coverage-timeout-minutes` | `30` | The time limit of the job `coverage`. Each step of the job stops 2 minutes before it. |
| `coverage-scripts` | (empty) | The scripts before the tests in the job `coverage`. The default takes each `build` or `build:*` script before `test` in `scripts`. |

### Coverage

With `coverage: true`, the job `coverage` starts `vitest run` with coverage in each package whose `test` script starts Vitest. The job has the first runner and the first Node.js version of the matrix. It starts at the same time as the job `checks`, so the coverage does not make the checks slower.

- Before the tests, the job installs, starts the command `setup` and the build scripts. These are each `build` or `build:*` script before `test` in `scripts`, or the scripts of `coverage-scripts`.
- The job has its own time limit, `coverage-timeout-minutes` (30). The install, the command `setup`, the scripts and the tests stop at a deadline 2 minutes before that limit. Each package that the deadline stopped fails the step, and the message names it.
- A job that reaches its time limit gets the result `cancelled`, also with `continue-on-error`, and the CI fails. A step that stops at the deadline fails only the step. Thus the job ends with its summary and its artifact.
- The script `deadline.ts` of the action `coverage` holds the deadline. At the deadline, it sends `TERM` to the processes of the step, and `KILL` 10 seconds later. It works on Linux, macOS and Windows.
- Node.js starts `deadline.ts` and `coverage.ts` from 22.18. With an older first version in `node-versions`, the steps have no deadline and give a warning. The step `Coverage` measures nothing: strict, it fails, and not strict, it gives a warning.
- The summary gives the time of the job and its limit. A time above 80 % of the limit gives a warning.

- The summary of the job gets a table: the statements, branches, functions and lines of each package.
- The artifact `coverage` has `coverage-summary.json` and `coverage-final.json` of each package.
- A package with no summary fails the step. Its tests failed, or it does not have `@vitest/coverage-v8`.
- A package whose tests fail also fails the step, after the summary. The thresholds of its Vitest config can cause this. The message names the package and the exit code.
- With `coverage-floor`, a package with a measure under the floor fails the step. The message names the package and the measure.

With `coverage: false` and `coverage-on-main: true` (the default), a push to the default branch of a public repository also starts the job, not strict (a private repository pays for its minutes, so it uses `coverage: true`). It skips a package with no `@vitest/coverage-v8`, and it gives a warning for a failure. The job has `continue-on-error`, so a failure or a stop at the deadline does not fail the CI. The gate of `release.yml` does not start it, so a release does not wait for the coverage. So each repository has the artifact `coverage` on main, and a tool can read which exported functions no test starts.

Each package with Vitest needs `@vitest/coverage-v8` in its `devDependencies`, with the version of its Vitest. The configuration of the coverage in `vitest.config.ts` (for example `include` and `exclude`) stays. The action sets only the reporters and the folder `coverage`.

The secret `CONVENTIONS_PRIVATE_PATTERNS` is optional. It has private regular expressions, one on each line. The rule `no-local-paths` of `check:conventions` finds each of them in the files and in the commit messages of the change. It also finds them in the title and the body of the pull request. A break of a private pattern shows only the line of the pattern in the secret, not the text. The job also masks each line of the secret in the log. A caller gives the secret by name, or with `secrets: inherit`:

```yaml
jobs:
  ci:
    uses: mark1russell7/template/.github/workflows/reusable-ci.yml@<commit> # main
    secrets:
      CONVENTIONS_PRIVATE_PATTERNS: ${{ secrets.CONVENTIONS_PRIVATE_PATTERNS }}
```

A pull request from a fork gets no secret, so the private patterns are not examined there.

### The changeset check

On a pull request, the job `changesets` examines the changesets (`.github/actions/changeset-check`). A repository with no `.changeset/config.json` passes. The job fails in these cases:

- A published package changes, and no changeset names it. Markdown, tests, fixtures and a change of only `devDependencies` or `scripts` in `package.json` need no changeset.
- A changeset names a package that the repository does not have, or it does not parse.
- A changeset gives `major` to a `0.x` package. changesets makes `1.0.0` from it. Before `1.0`, a breaking change is a `minor`. A decided `1.0` release adds the label `release-1.0`.

In a fixed group, a changeset of one member sets the version of all members. The other members that change get a note, not an error. The summary shows each package, its changeset and the release of each fixed group. Before `1.0`, a `minor` of a group is a breaking change, and the note asks for a migration note.

A change with no release has an empty changeset (`pnpm changeset --empty`) or the label `no-changeset`. The version pull request of changesets (`changeset-release/*`) is skipped.

A repository with more checks adds its own jobs next to the job `ci`. An example with inputs:

```yaml
jobs:
  ci:
    uses: mark1russell7/template/.github/workflows/reusable-ci.yml@<commit> # main
    with:
      scripts: build test typecheck
      node-versions: '["22", "24"]'
      os: '["ubuntu-latest", "windows-latest", "macos-latest"]'
      run: npm pack --dry-run
```

### The check of the ruleset

Each workflow of the merge gate has one summary job, with the name `<Name> OK`. The template has two: `ci-ok` (name `CI OK`) of `ci.yml` and `security-ok` (name `Security OK`) of `security.yml`. A summary job needs each other job of its file (`Security OK` has no other job, and does the scans itself, as "Security" tells). It starts also after a failure (`if: ${{ !cancelled() }}`). After a cancel it does not ask for a runner. It concludes `cancelled`, which does not pass the ruleset, and the next run does not wait behind it.

A summary job passes only when each job passed. A job can be skipped only when the list `ALLOW_SKIP` of the summary job names it. For example, outside the template, the `if` of `presets` skips it. Each other skipped job fails the summary. An empty `needs` also fails it, because a job that did not start is not a pass.

The ruleset names only the summary checks. Thus it does not change when a job is added. `gh pr merge --auto` merges only after the whole gate. A ruleset that names only some jobs lets `--auto` merge before the other jobs end.

- Add each new job of the gate to `needs` of `ci-ok`.
- `release.yml` uses `ci.yml` with `contents: read` only. A called job cannot get more permissions than its caller. Thus a gate job that needs more (the scans need `security-events: write`, a download of an artifact of another run needs `actions: read`) stays in its own workflow, with its own summary job.
- A gate workflow must start on each pull request, with no `paths` filter. Otherwise its summary check does not start, and the ruleset blocks the pull request. To skip the work, use the action `changes` and an `if` on the other jobs ("A gate with paths").
- Set the ruleset once with `node scripts/workflows/ruleset-ci-ok.ts <owner/repo> --apply`. Without `--apply`, it only prints the changes. It reads the checks of the newest of the last 5 pull requests into the default branch where "CI OK" passed. It adds each check with a name `<Name> OK` that passed there and that no ruleset names. It skips a repository where "CI OK" did not pass on any of the 5. A check that starts only on a push to `main` is not added, because it does not start on a pull request.
- To make the summary checks the only checks of the ruleset, add `--only-summary`. Then the script also removes each check that started in the same workflow run as that "CI OK", because "CI OK" covers it. It deletes a ruleset with no rule left. Then a repository can join or split the jobs of its CI, and its ruleset stays correct.

### One run for each commit

A commit on a branch with an open pull request starts `push` and `pull_request`. Thus a workflow with no limit on `push` starts two times for each commit. The rule `push-main-only` of `@mark1russell7/conventions` stops this, and `pnpm exec conventions fix` writes the change. A workflow that starts on the two events has this form:

```yaml
on:
  push:
    branches: [main]
  pull_request:
  # A person starts a run on a branch with no pull request: gh workflow run ci.yml --ref <branch>
  workflow_dispatch:
```

`branches` names the default branch. The rule reads it from the event file of the run, and then from `origin/HEAD`. If it finds neither, it uses `main`.

| Trigger | What the rule does |
|---|---|
| `push` with no filter, or with only `paths` or `paths-ignore` | The fix adds `branches`. The path filter stays. |
| `push` with `branches: ["**"]` or `branches: ["*"]` | The fix writes the default branch. |
| `push` with `branches` and `tags` | The fix keeps `tags`, so a tag push stays. |
| `push` with only `tags` or `tags-ignore` | No break, because GitHub starts this trigger on no branch. |
| `push` with no filter in a workflow that reads `refs/tags` or `github.ref_type` | The fix adds `branches` and `tags: ["**"]`, so the tag run stays. The rule also reads the local workflows that the file calls. |
| `push` and `release` with no `pull_request` | No break. Only the two events together start a commit two times. |
| `pull_request.types` with no `synchronize` | No break. Such a trigger does not start on a new commit, so `push` gives the only run. |
| `pull_request_target` | No break. It uses the code of the base, so only `push` tests the branch. |
| `workflow_call` or `schedule` next to the triggers | They stay as they are. |
| `on: [push, pull_request]` | The fix writes the block form. A comment stays on its line. |
| A caller of a shared workflow | The same as each other workflow. The fix does not change the jobs. |

The fix gives a break with no edit, and a person chooses the change, in these cases:

- `push` has `branches-ignore`.
- `branches` names another branch, for example `[main, develop]`.
- The workflow reads another branch, for example `github.ref == 'refs/heads/develop'`.
- `on` or `push` has the flow form of a map, for example `on: { push: {}, pull_request: {} }`.
- The file is `release.yml`. The fix does not change this file.

For a long-lived branch, add its name to the option `branches` of the rule, with a reason. To keep a workflow out of the rule, use `ignore`, with a reason.

The limit has these results:

- A branch with no pull request gets no automatic run. Start a run with `gh workflow run`.
- GitHub does not start `pull_request` on a pull request with a merge conflict. Correct the conflict to get a run.
- A pull request into a branch that `on.pull_request.branches` does not name gets no run. Start a run with `gh workflow run`.
- A tag push no longer starts a CI that does not read the tag.
- The checks of a pull request do not change. `CI OK` and `Security OK` come from the run for `pull_request`, and the ruleset stays as it is.

A run from `workflow_dispatch` is the same as a run from a push to `main`, with these points:

- The concurrency group of `ci.yml` is the group of the commit, and `cancel-in-progress` is `false`. A newer push does not cancel the run. A run of the same commit waits for the first run.
- The job `changesets` skips, because its `if` asks for `pull_request`. The job `ci` stays green, as on a push to `main`.
- The steps "Deepen to the merge base" and "Fetch the commit before the push" skip.
- The action `changes` gives a match, as for each event other than a pull request.
- The rules of `conventions` that read a range of commits skip, because a run of `workflow_dispatch` has no base.
- After a CI run of `workflow_dispatch` on `main`, a caller of `reusable-pages.yml` on `workflow_run` of CI deploys only the head of `main`.

### A gate with paths

A gate that is only about some files (a bench of the core, a corpus) starts on each pull request too. Two shared actions do the rest:

- `changes` reads the files of the pull request and gives `match`. It has the patterns of `on.pull_request.paths`: `*` does not match `/`, `**` matches each part of a path, and `!` takes files out. Each event other than a pull request is a match.
- `gate-summary` is the step of the summary job. It passes when each job passed. When `changes` gives `match: false`, a skipped gate job passes too. A failure, a cancel or another skip fails it.

```yaml
on:
  pull_request:
  push:
    branches: [main]
    paths: ["packages/core/src/**"]
  workflow_dispatch:

jobs:
  changes:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: read
    outputs:
      match: ${{ steps.changes.outputs.match }}
    steps:
      - id: changes
        uses: mark1russell7/template/.github/actions/changes@<commit> # main
        with:
          paths: |
            packages/core/src/**
            .github/workflows/bench.yml

  bench:
    needs: changes
    if: needs.changes.outputs.match == 'true'
    runs-on: ubuntu-latest
    steps:
      - run: pnpm bench

  bench-ok:
    name: Bench OK
    if: ${{ !cancelled() }}
    needs: [changes, bench]
    runs-on: ubuntu-latest
    permissions: {}
    steps:
      - uses: mark1russell7/template/.github/actions/gate-summary@<commit> # main
        with:
          needs: ${{ toJSON(needs) }}
```

A `push` filter can stay, because the ruleset reads only pull requests. With the patterns of the old filter, the gate runs on the same pull requests as before. `changes` also reads the old name of a moved file, so a move out of the gate paths starts the gate too. A pull request with 3000 files or more always starts the gate, because the API gives no more files. The conventions rule `gate-trigger` finds a pull request trigger with `paths` or `paths-ignore`. `actions-test.yml` of the template is an example.

## Release

The `release.yml` of a repository keeps four jobs:

1. `verify` uses the `ci.yml` of the repository.
2. `build` uses `reusable-release-build.yml`.
3. `publish` is a job of `release.yml`. Its one step is the action `npm-publish`.
4. `tag` uses `reusable-release-tag.yml`.

```yaml
  publish:
    name: Publish to npm
    needs: build
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions:
      id-token: write
    outputs:
      published: ${{ steps.publish.outputs.published }}
    steps:
      - id: publish
        uses: mark1russell7/template/.github/actions/npm-publish@<commit> # main
```

### Why the publish job stays in `release.yml`

The trusted publisher of each package on npm names the repository and the workflow file `release.yml`. A change to a trusted publisher needs the 2FA of the owner.

- npm compares the trusted publisher with the calling workflow, not with the shared workflow that holds `npm publish` ([npm docs, trusted publishers](https://docs.npmjs.com/trusted-publishers)).
- The npm docs do not tell how npm accepts a shared workflow of a different repository. The question is open ([npm/documentation#1755](https://github.com/npm/documentation/issues/1755)).
- A composite action operates in the job that uses it. Thus the OIDC token and the provenance statement stay the same as before.

Thus the job that holds `id-token: write` stays in `release.yml`, and only its steps are shared. The other jobs need no OIDC token. They are shared workflows.

### The security of the release

- `release.yml` starts with `permissions: {}`. Each job gets only the permissions that it needs.
- The jobs `build` and `verify` run the code of the repository with `contents: read` only.
- The first step of the job `build` stops the run when the commit is not on `main`. Thus a manual run on a different branch publishes nothing (`RELEASING.md`).
- The job `publish` holds `id-token: write`. It does no checkout and no install. It starts only the pinned action.
- The job `tag` holds `contents: write`, from its caller job. It starts no code of the repository.
- Renovate does not change `release.yml`. The release session moves its pins (`RELEASING.md`).

### Inputs of the release

Most repositories need no inputs. A repository with more release steps uses these inputs. Each default keeps the standard release.

| Workflow or action | Input | Default | What it sets |
|---|---|---|---|
| `reusable-release-build.yml` | `require-main` | `true` | The check that the commit is on `main`. Only `actions-test.yml` sets `false`. |
| `reusable-release-build.yml` | `node-version` | `26` | The Node.js version of the build. |
| `reusable-release-build.yml` | `node-version-file` | (empty) | A file with the Node.js version, for example `.nvmrc`. It replaces `node-version`. |
| `reusable-release-build.yml` | `build` | (empty) | The build command. Empty starts the root `build` script, or else the `build` script of each published package and its dependencies. |
| `reusable-release-build.yml` | `after-pack` | (empty) | A command after `pack.ts` and `tags.ts`, before the upload of the artifacts. |
| `npm-publish` | `new-packages` | `error` | `warning`: a package that is not on npm gives a warning, and the step does not fail. |
| `npm-publish` | `node-version` | `26` | The Node.js version of npm. |
| `reusable-release-tag.yml` | `published` | (empty) | The versions that the job `publish` published. |

The command `after-pack` operates in the build job, with `contents: read` only:

- `RELEASE_DIR` is the folder of `packages.txt` and the tarballs. `TAGS_FILE` is the plan of the tags.
- The command can test the tarballs, add files to the artifact `release`, and change the plan.
- Each line `name=value` that it writes to `GITHUB_OUTPUT` goes into the output `after-pack` of the workflow. This output is a JSON object.
- A later job reads a value with `fromJSON(needs.build.outputs.after-pack).<name>`.

Each entry of the plan of the tags has `name`, `version`, `tag`, `prerelease` and `notes`. The job `tag` also reads three optional fields:

- `title`: the title of the GitHub release. The default is the tag.
- `tarballs`: an array of package names. The release gets the tarball of each package as a file.
- `latest`: `true` makes the release of this entry the latest release of the repository (`--latest`). The other releases of the run get `--latest=false`.

At most one entry sets `latest`. A prerelease does not become the latest release. When no entry sets `latest`, the job gives no `--latest` flag, the same as before.

The `tags.ts` of the template does not write these fields. The `tags.ts` of a repository can write them. The command `after-pack` can also add them.

### More jobs in `release.yml`

A step that needs `id-token: write` stays in `release.yml`, for example a publish to the MCP registry. It does not go into a shared workflow:

- Put it in a job after the job `publish`, with only the permissions that it needs.
- The job does no checkout and no install. It reads its files from the artifact `release`.
- The output `published` of the job `publish` and the output `after-pack` of the job `build` tell the job when to operate.

## Mutation

The workflow `reusable-mutation.yml` starts the mutation tests of a repository with [Stryker](https://stryker-mutator.io) and `@mark1russell7/rigor-mutation`. A mutation test changes the source a little (a mutant) and starts the tests. The score is the percent of the mutants that the tests detect.

The lane file `mutation.json` of the repository names the packages, their globs, their parts and their gates. The README of `@mark1russell7/rigor-mutation` tells its format. The repository has these `devDependencies`: `@mark1russell7/rigor-mutation`, `@stryker-mutator/core` and `@stryker-mutator/vitest-runner`, 10.1.0 or later. Stryker 10.0 started no test on each mutant with Vitest 5. The workflow needs `@mark1russell7/rigor-mutation` 0.1.8 or later. The job `plan` fails with an older version.

The job `plan` checks the disabled mutants (`rigor-mutation disables`) and the relative paths of each package (`rigor-mutation load-check`). Then it gives the selections. Stryker copies the folder of each package, so a relative path that leaves the folder finds no file in the copy. A test file that does not load fails no test, so the plan fails before any runner starts. The job `mutate` starts Stryker for each selection on its own runner. Then it applies the gate of the package. A selection under its gate fails, and the message names it. The artifact `mutation-<selection>` has the HTML and JSON reports.

Stryker stops after `stop-minutes`, before the time limit of the job. Then the job writes "no score" to the summary, uploads the report and fails. The job `gate` starts after each `mutate` job, also after a failure. It reads the reports of all the selections in one `scores` command (`--reports`) and applies the gate again. A selection with no report fails, and the gate names it.

The gate of a package with parts applies to each part. With `"gateOver": "package"` in the lane, the job `gate` applies it to the sum of the mutants of all the parts. A part that has no report makes the package a no read. The job `mutate` of a part then applies no gate (`--alone`).

A score is a read of the tests only when the run read all of them. Thus `Score` and the job `gate` also fail a selection when its report does not read a test file on the disk (`--test-files`). The field `notRead` of the package in the lane names each exception, with its reason.

Four inputs change a run.

- `test-counts` names a file with the last good count of the tests of each selection. A count that fell by more than `maxTestFall` percent of the lane fails the selection. The default is 20. The job `gate` uploads the new counts as the artifact `mutation-test-counts`. Commit the file after a good run.

- `dry-run` starts only the tests of each selection under Stryker, with no mutant. Start it on a pull request that changes the lane files or the test config. A selection whose tests fail under Stryker then fails before the long run. A dry run has no score, so `Score` and the job `gate` do not run.
- `changed` names the changed files, from the folder of the lane file. Only the runs with a changed file start, and each run mutates only its changed files. A plan with no run starts no job `mutate`.
- `report-only` writes the scores, but a score under the gate fails nothing. A run of the changed files of a night is a sample of the package, so it is report only. The weekly run of all files keeps the gate.

A mutation run is long. Thus a repository starts it from a scheduled workflow, not from each pull request. The workflow states its size in its `env`. A check compares the real run with these values:

```yaml
on:
  schedule:
    - cron: "<minute> 4 * * 1"
  workflow_dispatch:
env:
  STATED_JOBS: 3
  STATED_JOB_MINUTES: 90
  STATED_REASON: one runner for each part of the package
jobs:
  mutation:
    uses: mark1russell7/template/.github/workflows/reusable-mutation.yml@<commit> # main
```

`STATED_JOBS` is the number of jobs, with the job `plan`. `STATED_JOB_MINUTES` is the sum of the minutes of the jobs.

| Input | Default | What it sets |
|---|---|---|
| `selections` | (empty) | The packages or parts to mutate, separated by spaces or commas. Empty gives each part of each package with parts, and each other package. |
| `lane` | `mutation.json` | The lane file. |
| `concurrency` | `4` | The test processes of Stryker on each runner. |
| `timeout-minutes` | `120` | The time limit of each selection. Divide a package into parts when one selection needs more. |
| `stop-minutes` | `0` | The time after which Stryker stops. `0` gives `stopMinutes` of the lane, at most `timeout-minutes` minus 10. |
| `dry-run` | `false` | Start only the tests, with no mutant and no gate. |
| `changed` | (empty) | The changed files, separated by commas or lines. Only their runs start. It takes an empty `selections`. |
| `report-only` | `false` | Write the scores, but do not fail a score under the gate. |
| `test-counts` | (empty) | The file of the last good test counts. A fall of a count fails the selection. Empty compares no count. |
| `node-version` | `26` | The Node.js version. |
| `working-directory` | `.` | The folder of the root `package.json`. |

The gates are in the lane file, not in an input. Thus a local run and CI use the same gate.

## Pages

`reusable-pages.yml` has three jobs. The job `ref` decides if the commit of the event builds and deploys. It starts no code of the repository.

The job `build` checks out the commit of the event, with no ref of its own. It installs, builds the site, adds the pages of `site-pages` and uploads the Pages artifact. It gets only read permissions. The job `deploy` deploys the artifact. It starts no code of the repository.

```yaml
on:
  push:
    branches: [main]
  # After a release, so that the Releases page has the new version (the rule pages-after-release)
  workflow_run:
    workflows: [Release]
    types: [completed]
    branches: [main]
  schedule:
    - cron: "17 */3 * * *"
  workflow_dispatch:

permissions: {}

# A deployment in progress always ends. A newer run replaces only a run that waits (the rule main-runs-finish).
concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  pages:
    uses: mark1russell7/template/.github/workflows/reusable-pages.yml@<commit> # main
    permissions:
      contents: read
      actions: read
      issues: read
      pull-requests: read
      checks: read
      statuses: read
      pages: write
      id-token: write
    with:
      build: pnpm --filter @crawler/site run build
      out: packages/site/dist
      env: '{"SITE_BASE": "/${{ github.event.repository.name }}", "ASTRO_TELEMETRY_DISABLED": "1"}'
      roadmap: docs/ROADMAP.md
      packages: polite-crawler,polite-crawler-mcp
```

- A repository that publishes a package also starts Pages after a release, with `workflow_run` of `Release`, and on each day. A release starts no Pages run by itself, so the Releases page is behind npm until the next build. The rule `pages-after-release` of `@mark1russell7/conventions` examines both triggers, and `conventions fix` writes them.
- The job `ref` writes its decision and the reason to the step summary of the run.
- A push to `main` deploys its commit. A pull request and a push to a different branch only build.
- A schedule, a run by hand, a repository dispatch and a run after a release build the head of `main`. They deploy it when its CI passed, or while its CI runs and `pending` is `head`.
- A red head of `main` deploys nothing. The site keeps its last deploy and does not go back to an older commit.
- A run after CI deploys only when the commit of CI is the head of `main`. Else the CI run of the newer commit deploys it.
- A caller on `workflow_run` after CI is also correct. A failed CI run, a CI run of a pull request and a CI run of a push to a different branch build nothing. The job `build` examines the branch, so the filter `branches: [main]` of the caller is not necessary.
- The input `pending` is `head` by default. With `pending: green`, a head whose CI runs deploys nothing.
- The inputs of `site-pages` go to the action: `site-pages-version`, `roadmap`, `base`, `packages`, `changesets`, `group`, `css`, `site-name` and `data-only`.
- `site-pages: false` builds the site without the Releases page and the Status page.
- Without `roadmap`, the Status page shows only the open pull requests and issues. The rule `roadmap-parses` of `@mark1russell7/conventions` thus needs `roadmap` in each call, or `site-pages: false`.
- `site-check: true` checks the built pages in a headless Chromium before the upload. A failed check stops the deploy. The next list tells the check.
- The check opens each page of `site-check-pages` (default: the home) at the widths 360, 400 and 1280, in light and dark.
- A page fails when it is wider than the screen, or an element goes past the right edge.
- A page also fails when it shows no text, or a text area hides its text.
- A page also fails when a box with `overflow-x: hidden` or `clip` cuts text.
- A page also fails when a table in a box that scrolls goes out of view at a phone width.
- The attribute `data-overflow-ok` marks a box that is meant to scroll or to clip. The `README.md` of `site-pages` tells the rule and what does not count.
- A console error, an exception or a failed request also fails the page.
- A page that links to other sites of its origin names their paths in the meta tag `site-check-other-paths`. The `README.md` of `site-pages` tells the rule.
- `site-check-probe` is a JavaScript or TypeScript file that tests the interactive core of the home. Its checks run at each width. The check removes the types of a `.ts` file, so the site needs no build step for its probe. `site-pages check --help` tells its functions.
- `site-check-probe` also takes a probe for other pages, as `<page>=<file>` pairs separated by commas, for example `test-probe.js, /structures/=src/structures-probe.ts`. A file with no page is the probe of the first page. A page with no probe has none.
- The check uses the Chromium of `playwright-core` at `site-check-playwright`, from the action `setup-playwright`. The artifact `site-check` has the screenshots and `report.json`.
- Two calls of `reusable-pages.yml` in one run need two values of `artifact-prefix`. The prefix goes before the names `github-pages` and `site-check` of the artifacts.
- A download by name gets only the latest artifact of the name. `download-artifact` also finds by ID only the latest artifact of each name. Thus two artifacts of one name in one run are a fault.
- The check runs from `packages/site-pages/src/check` of the template commit of the workflow. It needs Node.js 22.18 or later.
- A site with its own Pages workflow uses the action `site-check` before the upload of the Pages artifact. The inputs have the same names, and `out` is the built site.
- A site with its own Pages workflow uses the action `data-stamps` for the freshness gate. Its input `stamps` is the file of stamps in the built site.
- A scheduled build or a build after a release can build an older green commit. When that commit does not have the file of stamps yet, the gate warns and skips. When the build is of the commit of the workflow, a missing file fails the gate.
- The workflow `site-audit.yml` of the template checks the live home of each public site each Monday. Start it by hand from the Actions tab.
- The audit does not fail for a bad site. Its artifact `site-audit` has the screenshots, `report.json` of each site and `audit.json`.
- The job `nav` of the audit starts `site-pages nav` on each site. Its artifact `site-nav` has the screenshots, `report.json` of each site and `nav.json`.
- Each pull request starts `site-audit.yml`, so its check "Site audit OK" is always there. A pull request that changes `site-audit.yml` or the crawl starts only the job `nav`.
- `site-bar: true` writes the shared site bar into each built HTML page. `site-bar-pages` names the pages of the bar, for example `Demo=demo/,Docs=docs/`. `site-bar-npm` gives the npm link.
- With `site-bar: true`, the crawl `site-pages nav` examines the built site. A page with no bar, a page more than 2 clicks from home or a page with no way back stops the deploy.
- `scroll-cue` (default `true`) gives each code block of each built HTML page the scroll cue of `site-pages cue`. A block wider than its box shows a fade at the edge with more content.
- A code block with `data-overflow-ok` keeps no cue. `scroll-cue: false` stops the step.
- `deploy: false` builds and uploads the artifact, with no deploy.
- `indexnow-key` sends the URLs of `sitemap.xml` to the IndexNow engines after each deploy that is not scheduled.
- The site must serve `<key>.txt` with the key. The key is public. A failure of the job `indexnow` does not fail the deploy.
- `github-token: true` gives the build `GITHUB_TOKEN`, with the read permissions of the build job.
- The workflow gets the actions of the same template commit as the workflow file. A second checkout gets them.
- Each public repository has a site. The rule `pages-site` of `@mark1russell7/conventions` needs a call of this workflow without `deploy: false`.
- The Pages source of the repository is "GitHub Actions". To set it, start `gh api -X POST repos/<owner>/<repo>/pages -f build_type=workflow` one time.

## Security

The action `security-scan` has three scans in one job. On a pull request, a scan fails only for a new finding at or above `fail-on-severity`. On a push, a schedule or a manual run, the scans upload their findings to code scanning. Then they do not fail. Thus the Security tab shows the old findings, and the old findings do not block a pull request.

| Scan | On a pull request | On a push, a schedule or a manual run |
|---|---|---|
| `dependency-review` | GitHub compares the dependencies of the base and of the pull request. The scan fails for a new dependency with a known vulnerability. | The scan does not start. |
| `osv-scanner` | The scan reads the lockfiles of the base and of the pull request. It fails for a vulnerability that only the pull request has. | The scan reads all the lockfiles and uploads the results. |
| `codeql` | CodeQL analyzes the source with no build. The scan fails for a new alert on a line that the pull request adds or changes. | CodeQL analyzes the source and uploads the results. |

CodeQL first downloads the bundle of the version of `codeql-action`. If that download fails (for example, GitHub gave HTTP 504 again and again on 2026-11-08), the action waits 60 seconds. Then it starts CodeQL again, with a second download of the same bundle. If the second start also fails, the scan fails. The step summary names the bundle and the start that passed. A start with no download is not possible, because `codeql-action` ignores `tools: toolcache` in a run of a push or a pull request.

An alert of CodeQL that is already open on the base branch is not new. The step groups the alerts by rule, file and message. A group is new only when the pull request has more alerts of it than the base branch has open. Thus a second alert of a known group fails. The step reads the open alerts of the base branch from the code-scanning API, with `security-events: read`. If it cannot read them, the step fails.

### A private repository

In a private repository, the dependency review and the code-scanning API need GitHub Advanced Security. A personal account cannot buy it. Thus the inputs `dependency-review`, `codeql` and `osv-upload` have the default `auto`:

- In a public repository, `auto` starts the part.
- In a private repository, `auto` skips the part. osv-scanner runs, and its pull request check stays the same.
- `true` and `false` keep their meaning. A private repository with GitHub Advanced Security sets `true`.
- The first step reads the visibility from the event. The event of a schedule has no repository, so then the step reads the API.

A skip is not a pass. The last step gives a warning for each scan that `auto` skips, and the table of the summary shows `skip`. On a push, a schedule or a manual run, osv-scanner does not upload its results. Then a warning gives the count, and the summary of the run lists the vulnerable packages.

Each scan starts also when an earlier scan failed. The last step of the action fails when a scan fails, and its error names that scan. The summary of the run shows a table of the scans. If the inputs start a scan and no step of it starts, the last step also fails.

The job is the summary job `Security OK` ("The check of the ruleset"). One job asks for one runner. Before, the scans had three jobs and a summary job, and each job waited in the queue for its runner. The scans start one after the other, so a run takes approximately 15 seconds more.

The job of the caller gives the permissions and the time limit. A composite action cannot set `timeout-minutes` for its job:

```yaml
on:
  pull_request:
  push:
    branches: [main]
  schedule:
    - cron: "<minute> 5 * * 1" # the minute that the rule runner-budget gives
  workflow_dispatch:

permissions: {}

concurrency:
  group: security-${{ github.event_name == 'pull_request' && github.ref || github.sha }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

jobs:
  security-ok:
    name: Security OK
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: read
      security-events: write
      actions: read
    steps:
      - uses: mark1russell7/template/.github/actions/security-scan@<commit> # main
```

| Input | Default | What it sets |
|---|---|---|
| `fail-on-severity` | `high` | A pull request fails for a new finding at or above this severity: `low`, `moderate`, `high` or `critical`. |
| `dependency-review` | `auto` | The scan `dependency-review`: `true`, `false` or `auto` ("A private repository"). |
| `dependency-review-scopes` | `runtime, development, unknown` | The scopes of the dependencies that the dependency review examines. |
| `osv` | `true` | The scan `osv-scanner`. |
| `osv-upload` | `auto` | The upload of the results of osv-scanner to code scanning: `true`, `false` or `auto`. |
| `osv-lockfile` | (empty) | The lockfiles of osv-scanner, separated by spaces. Empty scans each lockfile of the repository. |
| `codeql` | `auto` | The scan `codeql`: `true`, `false` or `auto`. |
| `codeql-languages` | `javascript-typescript,actions` | The CodeQL languages. The scan skips a language with no files in the repository. |
| `codeql-build-mode` | `none` | The CodeQL build mode. |

- The action checks out the repository. On a pull request, the checkout is the merge commit, with its base as the first parent.
- `security-events: write` lets the scans upload the results. `actions: read` lets CodeQL and the upload read the run in a private repository. The dependency review needs only `contents: read`.
- No step installs or starts the code of the repository.
- The severity of a finding is its CVSS score or its CodeQL `security-severity`. `high` is 7.0 or more, and `critical` is 9.0 or more.
- A file `osv-scanner.toml` next to a lockfile tells osv-scanner which vulnerabilities to ignore.
- A repository with the default setup of code scanning sets `codeql: false`, because the default setup refuses the results of a CodeQL workflow.
- The last step starts `verdict.ts` with the Node of the runner. Node 22.18 or later runs TypeScript with no build, and the `ubuntu-latest` image has such a Node.

### The old workflow

`reusable-security.yml` is deprecated. It has the same scans in three jobs, and a repository that pins it continues to work. To change to the action, replace the jobs `security` and `security-ok` of the caller with the one job above. Keep the job name `Security OK`, because the ruleset needs that check. A later release of the template removes the workflow.

## Pins and Renovate

A repository pins each shared workflow and action to a commit of `main`:

```yaml
uses: mark1russell7/template/.github/workflows/reusable-ci.yml@<full commit SHA> # main
```

- Renovate reads the comment `# main` and moves the pin to the newest commit of `main` (the preset of `renovate/`). The manager `github-actions` does this since Renovate 43.84.0.
- These updates come in one group, "template workflows and actions", with no wait. The pull request gets the label `train-merge`. The release train merges it when CI passes and no release of the repository is open.
- The group comes on Monday before 06:00 (New York time). A workflow change during a release makes the tag job fail with HTTP 403 (`RELEASING.md`).
- Renovate does not change `release.yml`. The release session moves the pins of `release.yml` with `scripts/release/bump-pins.ts` (`RELEASING.md`).
- A change of the template that must not wait for Renovate goes out with `bump-pins.ts --file <workflow>` (`RELEASING.md`).
- Renovate also moves `CLAUDE_CODE_VERSION` of `reusable-ai-review.yml` to the newest version on npm. A person reviews and merges that pull request.

## The template and new repositories

The workflows of the template call the shared workflows and actions by a local path, for example `./.github/workflows/reusable-ci.yml`. Thus each pull request of the template tests them:

- `ci.yml` tests `reusable-ci.yml`.
- `security.yml` tests the action `security-scan`. The tests of `scripts/workflows/security-scan.test.ts` start no scan. They examine the choice of the scans, the last step and the step that finds the new CodeQL alerts.
- Before the action, `security.yml` checks out the folder `.github/actions` of the template. This step operates only in the template. In a private repository, its partial clone makes the checkout of the base fail.
- `actions-test.yml` tests the actions, `reusable-pages.yml` and the release workflows, with `dry-run`. It publishes nothing. On a pull request, it sets the input `require-main` of the release build to `false`.
- On each pull request, the job `site` of `actions-test.yml` calls `pages.yml`. It builds the site of the template and starts its probe, with no deploy.
- "Actions OK" is a check of the ruleset of `main`, and it needs the job `site`. Thus `gh pr merge --auto` waits for the probe of the site.
- `ci.yml` cannot call `pages.yml`, because `release.yml` calls `ci.yml` with only `contents: read`.
- `ai-review.yml` tests `reusable-ai-review.yml`, and `codex-review.yml` tests `reusable-codex-review.yml`. Without its API key, a review stops at once with a note.
- The tests of `scripts/ai-review/` examine the request, the redaction and the post of the second review, with no network.

The job `publish` of `release.yml` uses the pinned form of `npm-publish`, also in the template. A local action needs a checkout, and that job does no checkout.

The stamp (`scripts/stamp/main.ts`, started by `new-repo.ps1`) copies only the files that its list `KEEP` names. It does not copy the shared workflows, the actions or `actions-test.yml`. It changes each local path and each pin of the template to the pinned form, with the commit of the template that it copies. The job `stamp` of `ci.yml` makes a repository. With no hand edit, that repository must pass its install, its checks, its Pages build and the site check.
