# @mark1russell7/runner-dispatch

The records and the trust rules of a dispatcher of one-job CI runners. The package is not on npm yet.

A dispatcher gives a runner only to a job of a trusted run. This package has the data of that decision, and the function that decides. It has no network code.

## The records

| Record | What it is |
| --- | --- |
| `RunRecord` | The part of a workflow run that the policy reads: the repository, the id, the number of the try, the event, the head repository and the two actors. |
| `JobRecord` | One job of a run that waits for a runner, with the labels that it asks for. |
| `MachineRecord` | One machine that a provider makes for the jobs of one run. |

GitHub keeps each field of `RunRecord`. A fork cannot change them. A fork can write each label of a job, so the policy does not read a label.

## The policy

`decide(rules, run)` tells if a run is trusted. The rules are data:

```ts
import { decide, type TrustRules } from "@mark1russell7/runner-dispatch";

const rules: TrustRules = {
  repositories: ["octo/app"],
  events: ["push", "pull_request", "workflow_dispatch"],
  actors: ["octo-owner"],
};

const decision = decide(rules, {
  repository: "octo/app",
  runId: 12345678901,
  runAttempt: 1,
  event: "pull_request",
  headRepository: "stranger/app",
  actor: "stranger",
  triggeringActor: "stranger",
});
// decision.trusted is false. decision.refusals names the rules "head-repository", "actor" and "triggering-actor".
```

A run is trusted only when all of these are true:

1. The record is complete.
2. The repository is in `repositories`.
3. The event is in `events`.
4. The event is not `pull_request_target` or `workflow_run`. The policy refuses these two events, also when the rules list them.
5. The head repository is the repository. Thus the policy does not trust a run from a fork.
6. The actor of the run is in `actors`.
7. The actor of this try of the run is in `actors`.

The decision has each rule that refused the run, with one sentence for a log.

- The function compares the names of accounts and repositories without the case of ASCII letters, as GitHub does.
- A character that only looks like a letter is a different character.
- The function compares an event with its exact text.
- An empty list permits no run.
- The function does not throw. A record or rules with a bad shape give a run that is not trusted.

### The two refused events

A run of `pull_request_target` or `workflow_run` has the repository as its head repository. But a pull request from a fork can start it, and its workflow can read the code of the fork. Thus rule 5 does not stop it, and rule 4 does.

### The account that vouches

The rules trust an account, not a commit. When a trusted account pushes to a branch, the run has the code of that branch. The account vouches for it.

## A document of trust rules

`parseTrustRules(value)` reads a document, for example from a JSON file:

```json
{
  "format": "trust-rules/1",
  "repositories": ["octo/app"],
  "events": ["push", "pull_request", "workflow_dispatch"],
  "actors": ["octo-owner"]
}
```

The function gives the rules, or the list of the problems. It reports an unknown field and a name with a bad shape. It also reports an entry that is in a list two times, and a refused event in `events`.

## The run label

`runLabel({ runId, runAttempt })` gives the label `run-<id>-<try>` of the runner of one run. `parseRunLabel` reads only a label that `runLabel` gives.

- The dispatcher gives the label to the runner. The workflow names it in `runs-on`, so GitHub sends the jobs of that run to the runner.
- A fork can write the same label. Thus the label is not a proof.
- `sameRun(a, b)` compares the repository, the id and the try of two records. The check on the machine uses it to compare a job with its machine.

## The tests

Property tests on `fast-check` hold the rules:

- A run from a fork is not trusted, for each value of the other fields.
- The two refused events are not trusted, also when the rules list them.
- The function agrees with a second statement of the rules.
- A list that loses entries adds no trust.
- A value of each type gives no trust and no error.
