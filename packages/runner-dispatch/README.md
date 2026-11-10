# @mark1russell7/runner-dispatch

The records, the trust rules and the check on the machine of a dispatcher of one-job CI runners. The package is not on npm yet.

A dispatcher gives a runner only to a job of a trusted run. This package has the data of that decision, and the function that decides. It also has the check that a machine does before the first step of a job. It has no network code.

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

## The check on the machine

The dispatcher decides before it makes a machine. The machine decides again, before the first step of a job. The check on the machine does not use the decision of the dispatcher. Thus it stops a job that got the label of a trusted run.

`checkJob(settings, environment, event)` tells if a job can start on a machine. A job passes only when all of these are true:

1. The policy trusts the run of the job, with the record that the machine reads.
2. The event file of the job is an object, and it names the repository of the job.
3. The run of the job is the run that the machine serves.

`readJobRun(environment, event)` reads the record of the run on the machine:

| Field | Source |
| --- | --- |
| `repository` | The variable `GITHUB_REPOSITORY` |
| `runId` | The variable `GITHUB_RUN_ID` |
| `runAttempt` | The variable `GITHUB_RUN_ATTEMPT` |
| `event` | The variable `GITHUB_EVENT_NAME` |
| `actor` | The variable `GITHUB_ACTOR` |
| `triggeringActor` | The variable `GITHUB_TRIGGERING_ACTOR` |
| `headRepository` | The event file of the job |

- For a pull request, the head repository is `pull_request.head.repo.full_name` of the event file.
- An event file with the key `pull_request` is a pull request. An event with a name that starts with `pull_request` is a pull request too.
- A pull request from a fork that no longer exists has no head repository. The check refuses it.
- For each other event, the head repository is `repository.full_name` of the event file.
- An id is a text of decimal digits with no zero at the start. Each other text gives 0, and the policy refuses the record.
- The check does not expand a value. The author of a workflow writes some of the values.
- The functions do not throw. A value with a bad shape gives a job that does not pass.

### The settings of a machine

The dispatcher writes one document of settings for each machine. `parseCheckSettings(value)` reads it:

```json
{
  "format": "machine-check/1",
  "rules": {
    "format": "trust-rules/1",
    "repositories": ["octo/app"],
    "events": ["push", "pull_request", "workflow_dispatch"],
    "actors": ["octo-owner"]
  },
  "run": { "repository": "octo/app", "runId": 12345678901, "runAttempt": 1 }
}
```

The function gives the settings, or the list of the problems. The dispatcher uses it before it sends a document to a machine.

### The job-started program

The runner program starts one script before the first step of each job. The variable `ACTIONS_RUNNER_HOOK_JOB_STARTED` of the runner program names that script. On a machine of the dispatcher, the script starts the program `src/cli/job-started.ts` with one argument:

```sh
#!/bin/sh
exec /opt/actions-runner/externals/node24/bin/node \
  /opt/runner-dispatch/packages/runner-dispatch/src/cli/job-started.ts /etc/runner-dispatch/check.json
```

The argument is the path of the settings file. The program reads the event file from the path in `GITHUB_EVENT_PATH`.

- The runner program has its own Node.js in its folder `externals`. Thus the machine needs no second Node.js for the check.
- Each path of the script is absolute. Thus `PATH` does not select the Node.js or the program.
- When a file of the script is absent, the script fails, and the runner program fails the job.

| Exit code | Meaning |
| --- | --- |
| 0 | The job passed the check, and it starts. |
| 1 | The check refused the job. The log has one line for each reason. |
| 2 | The check cannot use its settings: no argument, a file that it cannot read, or a document that is not valid. |

- The runner program fails the job for each code that is not 0. Thus the check fails closed.
- The program takes the path of the settings only from its argument. No variable changes it.
- The author of a job can read the log of the job. Thus the lines do not show the trust rules.
- Each line starts with fixed words. A value from outside is in quotation marks, with an escape for each character that is not printable ASCII.
- The program needs only Node.js 24 or later and the source files of this package. It has no dependency.
- `jobStarted(args, environment, read)` is the program without its input and output.

### The measured sequence of the runner program

The documentation of GitHub does not state when the job-started script starts, or which variables it gets. A probe measured these facts for the runner program 2.338.2 on Linux:

- The script is the second step of a job. It comes before each image pull, each container and each step of the job.
- When the script fails, the runner program skips them and fails the job.
- The key `env` of a workflow or of a job gives no variable to the script. Thus a job cannot change the input of the check.
- A job cannot change which script the runner program starts.
- The script gets the environment of the runner program. It gets no token of the job.

Then two probes started this program as the script, on the same runner program. The program was that of the commit `648bb37`:

| Settings of the machine | Result |
| --- | --- |
| The run of the job, with rules that trust it | The program gave the code 0 in 114 ms. Each step of the job started. |
| A different run, with rules that do not list the event of the job | The program gave the code 1 in 123 ms, with one line for each of the two rules. The job failed in its second step, and no step started. |

- The runner program 2.338.2 has Node.js 24.22.1 in its folder `externals/node24`. This Node.js started the TypeScript file with no flag and no package.
- The lines of the program are in the log of the job, in the step "Set up runner".
- The two times are those of a GitHub-hosted machine.

No probe measured the runner program on Windows or on macOS. A new version of the runner program can change the sequence, or the folder of its Node.js. Thus these probes must pass for each new version of the runner program, and for each change of this program.

## The tests

Property tests on `fast-check` hold the rules of the policy:

- A run from a fork is not trusted, for each value of the other fields.
- The two refused events are not trusted, also when the rules list them.
- The function agrees with a second statement of the rules.
- A list that loses entries adds no trust.
- A value of each type gives no trust and no error.

Tests hold the check on the machine:

- A pull request from a fork does not pass, for each value of the other fields.
- The job of a different run does not pass.
- The check passes no job that the policy of the dispatcher refuses.
- The check agrees with a second statement, from the facts of a job.
- Two machines with different rules write the same lines when the same rules refuse a job.
- A test starts the program as a process, and it gets the exit codes 0, 1 and 2.
