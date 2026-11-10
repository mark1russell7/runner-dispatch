# Second AI review of pull requests

The workflow `reusable-codex-review.yml` gives a pull request a second review by an OpenAI model. The default model is `gpt-6.1-sol`. The review only writes comments. It does not fail a pull request.

A model of a different family finds different bugs. Thus this review adds to the Claude review of `AI-REVIEW.md`. It does not replace it. Its review starts with the header "Second opinion (OpenAI `<model>`)", so the two reviews are easy to tell apart.

## What the review does

1. A pull request opens, opens again or becomes ready for review. The workflow starts.
2. The job `review` examines the cost guards. When a guard stops the review, the job summary tells the cause.
3. The job sends the title, the description and the diff of the pull request to the OpenAI Responses API. Each line of the diff has its line number.
4. The model looks for bugs, security problems and breaking API changes. It ignores the style.
5. The model gives a summary and a comment for each real problem. A JSON schema controls the format of the result.
6. The job `post` posts the summary and the comments as one review of the pull request.
7. When the model finds no problem, the summary is "No blocking findings."

A comment on a line that the diff does not show goes into the summary. The job stays green when the review does not finish. An API error, a timeout or an empty balance gives a note in the job summary, and no comment.

## Cost guards

| Guard | Value |
|---|---|
| Events | `opened`, `reopened`, `ready_for_review` and the `ai-review` label. A push to the pull request does not start a review. |
| Draft | A draft pull request gets no review. The `ai-review` label starts a review of a draft. |
| Bots | A pull request from Renovate, Dependabot, `github-actions` or a login that ends in `[bot]` gets no review. |
| Size | A pull request with more than `max-changed-lines` changed lines gets no review. The default is 1500. |
| Long lines | A diff with more than `max-diff-bytes` bytes gets no review. The default is 200000. |
| Output | The model stops after `max-output-tokens` output tokens. The reasoning tokens are a part of them. The default is 25000. |
| Effort | The default reasoning effort is `medium`. |
| Time | The API request stops after 7 minutes. The review step stops after 8 minutes, and the job stops after 10 minutes. |
| Runs | A new run for the same pull request cancels the old run. |
| Secret | The review starts only with the `OPENAI_API_KEY` secret. A pull request from a fork gets no secrets, so it gets no review. |

## Cost

The price list of OpenAI on 2026-10-25, in USD for 1M tokens (the standard tier, for prompts up to 272K tokens):

| Model | Input | Cached input | Output |
|---|---|---|---|
| `gpt-6.1-sol` | $2.00 | $0.10 | $10.00 |
| `gpt-6-sol` | $2.00 | $0.20 | $10.00 |

The reasoning tokens are output tokens. The cost guards keep each prompt far below 272K tokens. The estimate for one review with `gpt-6.1-sol`:

| Pull request | Input tokens | Output tokens | Cost |
|---|---|---|---|
| A usual pull request, 200 changed lines | approximately 6000 | 3000 to 8000 | $0.04 to $0.09 |
| The limit of the cost guards | approximately 70000 | 25000 | approximately $0.40 |

The footer of each review and the job summary show the real cost and the token counts. The script has the prices of `gpt-6.1-sol` and `gpt-6-sol`. For a different model, it shows only the token counts.

The three trial repositories had 241 pull requests from people from 2026-09-25 to 2026-10-25: `client` 175, `crawler` 40 and `vex` 26. Thus the trial costs approximately $10 to $22 each month. The maximum is approximately $100.

## Why not `openai/codex-action`

`openai/codex-action` is the official action of OpenAI. Its newest tag is `v1.13` (commit `bdf19a4a223ec2549a3e2274a0cf61556bc07675`). It starts `codex exec`, and Codex reads files with a shell.

- In each protected mode, the action refuses `--disable` and each `features.*` setting in `codex-args`. Thus the shell tool of Codex (`features.shell_tool`) stays on.
- Only `safety-strategy: unsafe` accepts these options. In that mode, Codex has `sudo`, and it can read the API key from the memory of the runner.
- Codex reads the `AGENTS.md` file of the checkout. The author of the pull request controls that file.
- The action gives only the last message of Codex. It does not give the token counts, so the job cannot show a cost.

Thus the workflow sends one request to the Responses API with the `fetch` function of Node.js. The request has no tools. The model cannot start commands, read files or write. It sees only the text that the workflow sends. The API path `/v1/responses` sets the API version, so no package needs a pin.

## Get a new review

1. Add the label `ai-review` to the pull request.
2. The workflow removes the label after the review. Add the label again for one more review.

The `ai-review` label also starts a new Claude review. For a label of the second review only, set the input `label`, for example `label: codex-review`.

## Add the review to a repository

Put this file in `.github/workflows/codex-review.yml`:

```yaml
name: AI second opinion

on:
  pull_request:
    types: [opened, reopened, ready_for_review, labeled]

permissions:
  contents: read
  pull-requests: write

jobs:
  codex:
    uses: mark1russell7/template/.github/workflows/reusable-codex-review.yml@<commit> # main
    secrets:
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

- Pin the workflow to a commit of the template (`@<commit> # main`). Renovate updates the pin.
- Write notes about the repository in the `extra-prompt` input, under `with:`.
- Without the `OPENAI_API_KEY` secret, each run stops at once with a note. Thus the file can come before the key.
- Make the label one time with `gh label create ai-review`.

| Input | Default | Function |
|---|---|---|
| `model` | `gpt-6.1-sol` | The OpenAI model that does the review. |
| `reasoning-effort` | `medium` | The reasoning effort: `low`, `medium`, `high`, `xhigh` or `max`. Empty uses the default of the model. |
| `max-output-tokens` | `25000` | The maximum number of output tokens, with the reasoning tokens. |
| `max-changed-lines` | `1500` | The maximum number of changed lines, as additions plus deletions. |
| `max-diff-bytes` | `200000` | The maximum size of the diff in bytes. |
| `label` | `ai-review` | The label that starts a new review. |
| `extra-prompt` | empty | Notes about the repository for the model. |

## The API key

The owner makes the API key and sets the secret. A Claude session does not do these steps.

1. Make a project for the reviews in the OpenAI platform.
2. In the project settings, open **Limits**. Set a monthly spend limit, and turn on **Enforce a hard limit**.
3. Make a secret key of the project. Set its permissions to **Restricted**, with write access to the Responses API only.
4. Set the secret in each repository of the trial:

```sh
gh secret set OPENAI_API_KEY -R mark1russell7/<repo>
```

The command asks for the key. Thus the key does not go into the shell history.

At the hard limit, the API refuses each request with HTTP 429 (`project_spend_limit_exceeded`). Then each review stops with a note, and the pull request stays green.

## Trial

The trial operates for one month in three busy repositories: `client`, `crawler` and `vex`.

1. Add `codex-review.yml` to the three repositories, and set the `OPENAI_API_KEY` secret.
2. The sessions read both reviews of each pull request. They correct the real problems and reply to the false findings.
3. After one month, the cost review compares the two reviews:
   - the findings of each review that the sessions acted on, with a fix or a reply,
   - the real problems that only one of the reviews found,
   - the cost of each review, from the footers and from the usage page of each provider.
4. The result decides: keep the second review, add it to more repositories, or remove it.

## Stop the review in a repository

Delete `.github/workflows/codex-review.yml` or the `OPENAI_API_KEY` secret. Without the secret, each run stops at once with a note.

## Security

- The workflow uses the `pull_request` event, not `pull_request_target`.
- The job `review` holds the API key, with `contents: read` and `pull-requests: read` only.
- The job `post` holds `pull-requests: write`, and no API key. It does not send data to the model.
- No job checks out the code of the pull request. The jobs get only the script of the template, at the commit of the workflow file, with no saved credentials.
- The request to the model has no tools. The model cannot start commands, read files, open web pages or post comments.
- The prompt tells the model that the text and the diff of the pull request are data, not instructions.
- Before the job `review` gives its result to the job `post`, it removes the API key and each text that looks like a token. The job `post` removes the token texts again.
- The request sets `store: false`. Thus OpenAI does not keep the response for later retrieval through the API.
