# @runner-dispatch/dispatcher

The dispatcher of `runner-dispatch`, declared as one service of `@mark1russell7/service`. The package is private, and it is not on npm.

The package declares the service. The entry `src/program.ts` joins it with the source of GitHub and one provider: Proxmox VE or a store of folders.

## The declaration

```ts
import { declare, PROFILES } from "@runner-dispatch/dispatcher";

const builder = declare({
  rules,
  times,
  settings,
  source,
  provider,
  stopped,
  loop: { sleep: 5, bound: 2, retry: 1, retryMax: 2, close: 0.5 },
  profile: PROFILES.daemon,
  onReport: (report) => log(report),
});
const description = builder.describe();
```

- `declare` starts nothing. `describe()` gives the declaration as data, and `run()` starts the service.
- The loop of the passes is the worker `passes` of the service, with one lane.
- `rules`, `times`, `settings`, `source` and `provider` are the parts of a dispatcher of `@mark1russell7/runner-dispatch`.
- `stopped` reads the stop switch. Each request of a pass gets the signal of the pass.
- `onReport` gets the report of each pass. A report has no one-job configuration, thus a log can keep it.
- `onError` gets each pass that failed, with the count of failures in sequence.
- `clock`, `random` and `suffix` are for tests. Give the same clock to `run()`.
- `declare` throws a `RangeError` for trust rules, times, settings or loop times that are not valid.

## The times of the loop

Each time is in seconds, and each time is above 0.

| Field | Value |
| --- | --- |
| `sleep` | The time from the end of a pass to the start of the next pass. |
| `bound` | The most time of one pass. At it, the loop stops the pass, and the pass is a failure. |
| `retry` | The wait after the first pass that failed. Each failure after it makes the wait two times longer. |
| `retryMax` | The longest wait after a pass that failed, before its jitter. The jitter adds the time `retry` at most. |
| `close` | The most time of the close of the loop, at the shutdown of the service. |

The timers of a machine use the time `pass` of the times of a machine: it is the longest time between two passes. Thus the loop keeps this rule:

```text
bound + max(sleep, retryMax + retry) <= pass
```

- `longestGap(loop)` gives the left side of the rule.
- `loopProblems(loop, pass)` gives each problem of the times as one sentence. `declare` refuses times with a problem.
- A pass with a failed request is a failure of the loop. A pass that the signal cut is also a failure.
- After a failure, the loop waits longer before the next pass. The rule holds the cost of that wait.

## The liveness

The check `passes-progress` fails when no pass ended in the time `pass`. It gates the liveness of the service.

- A port that does not read its signal makes a pass that does not end. The loop cannot stop that pass.
- The liveness then fails. A supervisor that reads it starts the process again.
- The new process adopts each machine of the provider. Thus no machine stays without a dispatcher.
- The check passes before the first pass. The startup of the service has its own time.
- The service has no listener. Thus no check gates its readiness.

## The shutdown

- A shutdown stops the loop, and it leaves each machine. The next start finds each machine in the list of the provider.
- The stop switch is the way to destroy each machine.
- `PROFILES.local` is for the computer of a developer. `PROFILES.daemon` is for a host under a supervisor.
- With the profile `daemon`, a second signal has no effect. Thus a pass in work ends.
- The time `bound` is less than the drain time of the profile. If not, the drain can cut a pass.
- The time `close` is less than the time of the profile for the close of the transports.
- `lint` of `@mark1russell7/service` examines these two times in the declaration. It gives the finding `violated` for a time that is too long.

## The program

The entry `src/program.ts` joins the parts into one program. A program is one document `dispatcher-program/1`, with no secret:

```json
{
  "format": "dispatcher-program/1",
  "rules": { "format": "trust-rules/1", "repositories": ["octo/app"], "events": ["push"], "actors": ["octo"] },
  "times": { "format": "machine-times/1", "make": 300, "register": 300, "idle": 120, "job": 3600, "retry": 5, "retryMax": 40, "pass": 60 },
  "settings": { "format": "dispatch-settings/1", "prefix": "rd", "capacity": 2, "sizes": ["small"], "standard": "small" },
  "loop": { "sleep": 15, "bound": 3, "retry": 2, "retryMax": 10, "close": 0.5 },
  "profile": "daemon",
  "stop": "/etc/runner-dispatch/stop",
  "github": { "organization": "octo", "runnerGroup": 3 },
  "proxmox": { "url": "https://pve.example:8006", "pool": "runners", "sizes": { "small": { "node": "pve1", "template": 9000 } } },
  "probes": { "port": 9464 }
}
```

- The fields `rules`, `times` and `settings` are the three documents of the package `@mark1russell7/runner-dispatch`.
- The loop keeps the time `pass` of the machines. `parseProgram` gives a problem for a loop that breaks it.
- The drain of each profile has a cap of 4 s. Thus the bound of a pass is less than 4 s, or `lint` finds it `violated`.
- The field `stop` is the path of the stop file. When the file is there, the stop switch is on.
- With an organization, the field `runnerGroup` is necessary. The field `github.url` has the default `https://api.github.com`.
- The document has one provider: the field `proxmox` or the field `folder`. Refer to [the folder provider and the rounds](#the-folder-provider-and-the-rounds).
- Each size of the settings has a template in `proxmox.sizes`. The field `proxmox.files` changes the two paths in the machine.
- The field `probes` is optional. It starts a probe server of `@mark1russell7/service/http` on its port, with the default host `127.0.0.1`.

The two secrets come from the environment: `RUNNER_DISPATCH_GITHUB_TOKEN` and `RUNNER_DISPATCH_PROXMOX_TOKEN`. `readSecrets` names a variable in a problem, but not its value.
A program with the folder provider needs only `RUNNER_DISPATCH_GITHUB_TOKEN`.

`prepareProgram` starts nothing. It does these steps:

1. With an organization, it checks the runner group before the first pass. A group that admits a repository with no service, or a public repository, stops the program.
2. It makes the client of GitHub, the source and the provider: the client of Proxmox VE with its transport, or the store of the folders.
3. It declares the service, and it examines the declaration with `lint` on a host with no platform of pods. A finding `violated` stops the program.

`runProgram` then starts the service. The program writes JSON lines: the check of the runner group, the findings of `lint`, each pass that changes something and each failure. No line has a token or a one-job configuration.

The transport of `src/transport.ts` sends each exchange with `httpRequest` of `@procedures/http`:

- It sends an exchange only to the origin of the URL of Proxmox VE. The host policy lets it reach only that host and port.
- It does not follow a redirect, thus the token goes to no other host.
- Give the certificate authority of the host to `NODE_EXTRA_CA_CERTS`.

## The command line

The entry `src/bin.ts` is the command of the program:

```sh
export RUNNER_DISPATCH_GITHUB_TOKEN=...
export RUNNER_DISPATCH_PROXMOX_TOKEN=...
node src/bin.ts /etc/runner-dispatch/program.json --check
node src/bin.ts /etc/runner-dispatch/program.json
node src/bin.ts /etc/runner-dispatch/program.json --round
```

- With `--check`, the command prepares the program and writes its log lines. It then writes the line `{"event":"checked"}` and stops before the first pass.
- With `--round`, the command does one round of passes, then it stops. Refer to [the folder provider and the rounds](#the-folder-provider-and-the-rounds).
- Without an option, the command starts the service. A `SIGTERM` or a `SIGINT` starts the shutdown of the service.
- The exit code 0 is a stop with no error, a check with no problem or a settled round. The exit code 1 is a problem, and 2 is a bad command.
- The exit code 3 is a round with no settled pass.
- Each log line goes to stdout as one line of JSON. Each problem goes to stderr, with each problem of the document and of the tokens together.
- The line `machine-measure` has the record of a machine at the end of its life, with its spans. The line `job-measure` has the record of a job at its end.

The command makes the ports of Node.js in `src/cli.ts`:

- `restGitHubApi` puts the GitHub API of the dispatcher on the REST client of `@procedures/gh`. The client sends a conditional request for a stored answer, and it keeps the limits of the rate of GitHub.
- The transport of `src/transport.ts` sends each exchange to Proxmox VE.
- `nodeFolderStore` of `src/folders.ts` is the store of the folder provider.
- `fileExists` examines the stop file. An error that is not `ENOENT` makes the pass fail, and the stop switch does not change.
- Each line of each output goes through `redactSecrets` of `@mark1russell7/text/redact` with the two tokens. Thus an error text from a library also has no token.

## The folder provider and the rounds

A program with the field `folder` in place of the field `proxmox` uses the folder provider of `@mark1russell7/runner-dispatch/folder`:

```json
"folder": { "root": "/var/lib/runner-dispatch/folders" }
```

- `nodeFolderStore` of `src/folders.ts` keeps one folder for each machine in the root folder.
- Each write goes through `writeFileAtomic` of `@procedures/fs/files`. A file gets the mode `0o600`, and a folder gets the mode `0o700`.
- The store refuses each name that is not the name of a folder of a machine.
- The program does not read `RUNNER_DISPATCH_PROXMOX_TOKEN`.

A starter on the same host starts the runner of each folder. The README of `@mark1russell7/runner-dispatch` has the rules of the starter.
The dispatcher and the starter share only the folders. Thus a job operates in a process with no token.

With `--round`, the command does passes until a pass is settled, then it stops. A settled pass has these properties:

- The pass read the stop switch, and the signal did not cut it.
- The pass made no step, adopted no machine and sent no request. No request failed.
- Each machine is in the state `asked`. It waits for its starter.

Thus the next pass changes nothing until a different process acts. More about a round:

- A round does at most `ROUND_PASSES` (30) passes. The sleep of the loop comes between two passes.
- The line `{"event":"round"}` has the count of passes, the end and the count of failed passes. The end is `settled`, `bound` or `signal`.
- A new round adopts each machine of the folders, because the memory of a round ends with its process.
- A pass that adopts a machine is not settled. Thus a round after an earlier round does two passes, or more.

Thus a CI job can do a round with the token in one step, and start the runners in a later step with no secret.

## The starter

The entry `src/starter-bin.ts` is the command `runner-dispatch-starter`. It starts the runner program of each folder that waits, one at a time:

```sh
node src/starter-bin.ts /var/lib/runner-dispatch/folders --runner /opt/actions-runner \
  --check /opt/runner-dispatch/node_modules/@mark1russell7/runner-dispatch/build/cli/job-started.js
```

`startRunners` of `src/starter.ts` obeys the rules of the starter in the README of `@mark1russell7/runner-dispatch`:

- The command needs no token, and it reads no secret of the dispatcher.
- It writes `started` with the flag `wx`. Thus two starters do not start the same folder.
- It reads and removes `configuration` before the start.
- It stops a runner at the file `stop`, at the time `--deadline` or at a `SIGINT` or a `SIGTERM`.
- A stop sends `SIGINT` to the process group of the runner. After the time `--grace`, it sends `SIGKILL`.
- It writes `exited` after each end. The record `starter-exited/1` has the reason `end`, `start`, `stop`, `deadline` or `signal`.
- It starts one runner at a time, because one folder of the runner program holds one runner.

The environment of the runner program:

- The runner gets only `PATH`, `HOME`, `USER`, `LANG` and `TMPDIR` of the starter. Thus no secret of the starter goes to a job.
- The configuration goes in `ACTIONS_RUNNER_INPUT_JITCONFIG`, not in an argument. The list of processes shows each argument.
- The runner program removes that variable from its environment when it reads it.
- `ACTIONS_RUNNER_HOOK_JOB_STARTED` names a hook script in a temporary folder with the mode `0o700`.
- The hook script starts the check with fixed absolute paths. Thus a variable of a job cannot change the check or its settings.

Each line of stdout is one line of JSON: `started`, `output`, `exited`, `taken`, `problem` and the last line `starter`. Each line of the runner output goes through `redactSecrets`, with each configuration that the starter read.

The exit codes are 0 when no folder waits or after a signal, 1 for a problem and 2 for a bad command.

A limit: a starter that stops with no signal, as at a `SIGKILL`, leaves `started` with no `exited`. The runner can operate after that stop, because it leads its own process group. A later starter does not start that folder again, and the folder stays until an operator removes it.

## The summary of the measures

The entry `src/measures-bin.ts` reads the logs of the program and writes the summary `measure-summary/1` of `summarizeMeasures`:

```sh
node src/bin.ts /etc/runner-dispatch/program.json > dispatch.log
node src/measures-bin.ts dispatch.log --level 0.5 --level 0.95 > summary.json
```

- The command takes each line `machine-measure` and `job-measure` of each file. It does not use the lines of other events.
- A line that is not JSON, or a record with a wrong field, does not go into the summary. The command tells their count on stderr.
- A machine goes into the summary one time, and so does a job. Thus two logs of one program do not count a record two times.
- The summary goes to stdout as JSON. The levels are 0.5, 0.9 and 0.99 when the command has no option `--level`.
- The exit code 0 is a summary. The exit code 1 is a file that the command cannot read, and 2 is a bad command.

## The probe of a credential

The entry `src/probe-bin.ts` sends the requests of the dispatcher to GitHub with one real token. It measures four facts:

| Fact | The measure |
| --- | --- |
| The permissions of each request | The header `x-accepted-github-permissions` and the status of each request |
| The cost of an answer 304 | The count of the used requests before and after each conditional request |
| The labels of a one-job runner | The labels that GitHub gives to a new runner |
| The runner groups of the organization | Each group, and a probe group with the visibility `selected` |

```sh
export RUNNER_DISPATCH_GITHUB_TOKEN=...
node src/probe-bin.ts --repository octo/app
node src/probe-bin.ts --repository octo/app --organization octo --group
```

Do not write the token on the command line: the history of the shell keeps each command. Copy the token, and send it to stdin with `--token-stdin`. The option `--out` writes the record as UTF-8, with no redirect of the shell:

```powershell
# PowerShell
Get-Clipboard | node src/probe-bin.ts --token-stdin --repository octo/app --out probe.json
```

```sh
# Git Bash: node.exe, because the alias node of Git Bash starts winpty, and winpty refuses a redirect of stdin or stdout.
# cat reads the clipboard: a redirect of /dev/clipboard gives a program of Windows an empty stdin.
cat /dev/clipboard | node.exe src/probe-bin.ts --token-stdin --repository octo/app --out probe.json
```

- The probe makes one runner with the label `runner-dispatch-probe`, and removes it at once. No job names this label.
- The record keeps only the id of the runner. Thus the record has no one-job configuration and no token.
- With `--group`, the probe makes a runner group in the organization for the runner. It removes the runner first, then the group.
- A stop with Ctrl+C stops the steps, but the probe still removes its runner and its group.
- The record `github-probe/1` goes to stdout as JSON, or to the file of `--out`. The exit code 1 tells that a runner or a group stays on GitHub.
- With `--token-stdin`, a terminal on stdin is a mistake, and the probe stops before a request. A text with a space or two lines is not a token.
- When GitHub refuses the token with an answer 401, the probe stops after its first request, before it makes a runner or a group. It writes no record, and the exit code is 1.

The primary limit of a token is the limit of its user. Thus each other client of the user adds noise to the measure of an answer 304:

- The probe reads the rate two times, sends the list of runs, and sends the same list again with its `ETag`. Then it reads the rate again.
- A read of the rate costs nothing. Thus with no other client, the two reads are equal, and the first list adds 1.
- Each conditional request must add the same count, and the last read must be equal to the last conditional request.
- Else the measure has no read. Requests of another client in one gap of the sequence give no read, and not a wrong cost.
- The probe repeats a round with noise, at most 3 times. The field `rounds` of the record has the count.

The docs of GitHub do not fix the format of the header of the permissions. Thus the record keeps the text of the header, and also its sets. A semicolon separates two sets, and a comma separates two permissions of one set.

### The result of a run

A run on 2026-11-15 used a fine-grained token, one repository and its organization on the Free plan, with `--group`. Each of its 23 requests got the expected status, and the probe removed its runner and its group.

| Requests | Status | The permission that GitHub names |
| --- | --- | --- |
| The queued runs, one run and its jobs | 200 | `actions=read` |
| The repository | 200 | `metadata=read` |
| The runners and the runner groups of the organization | 200 | `organization_self_hosted_runners=read` |
| One group, its repositories and its runners, and one runner | 200 | `organization_self_hosted_runners=read` |
| A new runner group, and a new one-job runner | 201 | `organization_self_hosted_runners=write` |
| The removal of the runner, and the removal of the group | 204 | `organization_self_hosted_runners=write` |
| The rate | 200 | `allows_permissionless_access=true` |

Thus the fine-grained token of a dispatcher for an organization needs three permissions:

| Permission | Level | Where |
| --- | --- | --- |
| Actions | Read | Each served repository |
| Metadata | Read | Each served repository |
| Self-hosted runners | Read and write | The organization |

The run also gave these facts:

- An answer 304 costs nothing. Each of the 5 conditional requests added 0 to the count of the used requests, in one round with no noise.
- A one-job runner gets only the labels of the request, with the type `read-only`. GitHub added no default label, for example `self-hosted`.
- Thus a job gets a one-job runner only when its `runs-on` names a label of the request.
- Before the run, the organization had one runner group: `Default`, with the visibility `all`. This group does not admit public repositories.
- The Free plan permitted a new group with the visibility `selected`, and a one-job runner in this group. `checkRunnerGroup` found no problem in the group.

The header `x-ratelimit-used` had two series of values in this run:

- The requests of the repository, the reads of the rate and the new group counted in one series.
- The other requests of the runners and the groups of the organization counted in a second series.
- The probe does not tell the cause. The measure of an answer 304 uses requests of the first series only.

No run measured the path with no organization, where the runners are those of one repository.

## The tests

Tests start the service on the fake world of `@mark1russell7/runner-dispatch/testing`, with the fake clock of `@mark1russell7/service/testing`:

- A job of a trusted run ends, and the passes come at the times of the loop.
- A pass with a failed request makes the loop wait longer, with the jitter.
- The bound stops a pass, and that pass is a failure.
- A shutdown leaves the machine, and the next start adopts it. The job ends one time.
- The stop switch destroys each machine.
- The liveness fails when a pass does not end, and it recovers after the pass ends.
- `lint` gives no finding `violated` for the declaration with each profile.

Tests hold the program:

- `parseProgram` gives a problem for each bad field, and `readSecrets` gives no value of a secret in a problem.
- A runner group that admits too much stops the program before the declaration.
- A loop that the drain of the profile can cut gives a finding `violated`, and it stops the program.
- A program on a fake world, a fake GitHub and a fake Proxmox VE makes a machine for a job. The machine gets the one-job configuration, and no log line has it.
- The probe server answers the liveness on its port, and the shutdown closes the port.
- The transport refuses another origin and a redirect, and it gives the reason phrase of an error.
- 17 changes of the checks of the program and the transport make the tests fail.

Tests hold the command line:

- `parseCommand` reads each form of the command, and it refuses each bad command with the exit code 2.
- These give the exit code 1: a file that the command cannot read, a file that is not JSON, and a bad document or token.
- A check writes the lines of the runner group and of the declaration, then the line `checked`. It starts nothing.
- An error text with a token, in each form, gets the mark `[secret]` in place of the token.
- A program on fakes makes a machine for a job, and a `SIGTERM` gives the exit code 0. No output has a token or a one-job configuration.
- `restGitHubApi` sends the token, the user agent and the query, and it gives the stored answer for a 304.
- `fileExists` gives `false` for a file that is not there, and it gives each other error to the caller.
- A round with `--round` gives the exit code 0 when it is settled or at a `SIGTERM`, and 3 with no settled pass.
- A round with the folder provider needs no token of Proxmox VE. No output has the one-job configuration.

Tests hold the rounds and the folders:

- A round with no job ends after one pass. For a queued job, the first pass writes a folder, and the second pass is settled.
- A new round adopts the machine of an earlier round, and it makes no second machine.
- The folder of a runner that exited goes away in the next round.
- A round ends at its count of passes. A signal stops it before a pass or during a sleep.
- `nodeFolderStore` writes, reads, lists and removes in a temporary folder. It refuses a bad name and a stopped signal.
- `nodeFolderStore` makes a file only when the file is not there, and it removes one file of a folder.

Tests hold the starter:

- The starter writes `started` and removes `configuration` before the start. The configuration is in the environment of the runner.
- It starts one runner at a time, in the order of the names. It does not start a folder that a different starter took.
- The file `stop`, the deadline and the signal stop the runner, with `SIGINT` to its group, then `SIGKILL`.
- A failed start, an empty configuration and a failed request give the reason `start`. No log line has the configuration.
- The command gives the runner a clean environment and the hook of its folder. No output line has the configuration.

The shared fakes of the tests are in `src/fixtures.ts`.
