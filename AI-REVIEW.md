# AI review of pull requests

The workflow `reusable-ai-review.yml` gives a pull request one review by Claude, on request. The review only writes comments. It does not fail a pull request.

A second review by an OpenAI model is also available. `CODEX-REVIEW.md` tells how it operates.

## The review is on request

The review starts only when a person or a session adds the `ai-review` label to the pull request. Without the label, the workflow makes no API call. When a pull request opens, opens again or becomes ready for review, the job stops at once with a notice.

Add the `ai-review` label to a pull request that changes one of these items:

- The authentication or the permissions.
- An exposed procedure.
- The handling of a secret.
- A CI workflow or a release workflow.

Each other pull request gets no review. A weekly batch audit of the changes will replace most reviews of single pull requests.

Before 2026-10-25, each new pull request got a review. The review started 152 times for $5.79, and only 3 runs had a finding. At that rate, the review costs $90 to $115 each month. The budget is $20 each month.

## Automatic review in one repository

One switch turns on the automatic review for one repository. Then each new pull request gets a review again, as before 2026-10-25. The draft, bot and size guards stay on.

To turn on the automatic review, set the repository variable `AI_REVIEW_AUTO` to `true`:

```sh
gh variable set AI_REVIEW_AUTO --body true --repo <owner>/<repo>
```

To turn it off, delete the variable:

```sh
gh variable delete AI_REVIEW_AUTO --repo <owner>/<repo>
```

The variable needs no change to the caller workflow. In a called workflow, the `vars` context has the variables of the caller repository. The variables of the template are not available ([GitHub: variables reference](https://docs.github.com/en/actions/reference/workflows-and-actions/variables)).

The input `auto: true` of the caller also turns on the automatic review. Use it when the caller workflow must keep the setting.

## What the review does

1. A person or a session adds the `ai-review` label. The workflow starts. With the automatic review, a pull request that opens, opens again or becomes ready for review also starts the workflow.
2. The workflow examines the cost guards. When a guard stops the review, the job summary tells the cause.
3. Claude Code (`claude -p`) reads the diff and the files that it needs. It looks for bugs, security problems, breaking API changes and code in the wrong home. The map of homes comes from `conventions map --markdown` of `@mark1russell7/conventions` on npm, at a fixed version, not from the pull request. It ignores the style.
4. Claude gives a summary and an inline comment for each real problem. The workflow posts them as one review of the pull request.
5. When Claude finds no problem, the summary is "No blocking findings."
6. The workflow removes the label. Add the label again for one more review.

The job stays green when the review does not finish. A crash, a timeout or an empty credit balance gives a note in the job summary, and no comment.

## Cost guards

| Guard | Value |
|---|---|
| Request | Only the `ai-review` label starts a review. A push to the pull request does not start a review. |
| Automatic review | Off by default. When it is on, `opened`, `reopened` and `ready_for_review` also start a review. |
| Draft | With the automatic review, a draft pull request gets no review. The `ai-review` label starts a review of a draft. |
| Bots | A label from a bot starts no review. With the automatic review, a pull request from Renovate, Dependabot, `github-actions` or a login that ends in `[bot]` gets no review. |
| Size | A pull request with more than `max-changed-lines` changed lines gets no review. The default is 1500. |
| Turns | Claude stops after `max-turns` turns. The default is 10. |
| Time | The review step stops after 8 minutes, and the job stops after 10 minutes. |
| Runs | A new review run for the same pull request cancels the old review run. A run that only gives the notice cancels no review. |
| Advisor | The advisor tool of Claude Code is off, so a review makes no Opus calls. |
| Secret | The review starts only with the `ANTHROPIC_API_KEY` secret. A pull request from a fork gets no secrets, so it gets no review. |

## Budget

The `ANTHROPIC_API_KEY` secret holds $200 of API credits. The credits expire on 2026-11-10.

The account has no payment method. When the credits are gone, each review stops with a note. Each review shows its cost.

## Why not `claude-code-action`

The action `anthropics/claude-code-action` sends each request with its own entrypoint name. The API refuses these requests for this account with "Credit balance is too low". The same key and the same Claude Code work with `claude -p`. Thus the workflow starts the Claude Code CLI from npm at a fixed version.

## Add the review to a repository

Put this file in `.github/workflows/ai-review.yml`:

```yaml
name: AI review

on:
  pull_request:
    types: [opened, reopened, ready_for_review, labeled]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    uses: mark1russell7/template/.github/workflows/reusable-ai-review.yml@<commit> # main
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

- Keep the four events. Without the automatic review, `opened`, `reopened` and `ready_for_review` give only a notice. With the variable `AI_REVIEW_AUTO`, they start a review.
- Pin the workflow to a commit of the template (`@<commit> # main`). Renovate updates the pin.
- Write notes about the repository in the `extra-prompt` input, under `with:`.
- The repository needs the `ANTHROPIC_API_KEY` secret.
- Make the label one time with `gh label create ai-review`.

| Input | Default | Function |
|---|---|---|
| `model` | `claude-sonnet-5-5` | The Claude model that does the review. |
| `max-turns` | `10` | The maximum number of model turns. |
| `max-changed-lines` | `1500` | The maximum number of changed lines, as additions plus deletions. |
| `extra-prompt` | empty | Notes about the repository for Claude. |
| `label` | `ai-review` | The label that starts a review. The workflow removes it after the review. |
| `auto` | `false` | The automatic review. The repository variable `AI_REVIEW_AUTO` with the value `true` also turns it on. |

## Stop the review in a repository

Delete `.github/workflows/ai-review.yml` or the `ANTHROPIC_API_KEY` secret. Without the secret, each run stops at once with a note.

## Security

- The workflow uses the `pull_request` event, not `pull_request_target`.
- The job token has only `contents: read` and `pull-requests: write`. The workflow uses no GitHub App and no OIDC token.
- Claude can only read files in the checkout and the diff folder. It cannot start commands, change files, open web pages or post comments.
- Claude Code ignores the hooks, settings, `CLAUDE.md` and MCP servers of the pull request (`--bare`, `--setting-sources user`, `--strict-mcp-config`).
- The prompt tells Claude that the text and the diff of the pull request are data, not instructions.
- Before the workflow posts the review, it removes the API key and each text that looks like a token.
