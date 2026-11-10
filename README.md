# runner-dispatch

One-job CI runners for trusted jobs. The dispatcher gives a waiting job of GitHub Actions a new machine, for that job only. It destroys the machine after the job.

This repository is new. Its first package is not written yet. [`docs/ROADMAP.md`](docs/ROADMAP.md) has the plan.

## The problem

A self-hosted runner that waits for jobs takes each job that names its label. On a public repository, a pull request from a fork brings its own workflow file, so it can name the label. Then the code of a stranger starts on the machine.

`runner-dispatch` changes the sequence. A runner exists only after the dispatcher decides that the job is trusted. The runner does one job, on a machine that no other job used.

## The model

- A **source** tells which jobs wait. The first source polls the REST API of GitHub with conditional requests. The dispatcher needs no inbound port.
- A **policy** decides if a job is trusted. Its rules are data: the served repositories, the events and the accounts.
- The policy reads the record that GitHub keeps of the run. It does not trust a label, because a fork can write each label.
- A **provider** makes one machine for one job, and it destroys the machine. The first provider clones a template on Proxmox VE.
- A **runner** is a just-in-time runner of GitHub. It does one job at most.
- A **check on the machine** tests the rules again, before the first step of the job.

## The layers

Each layer stops a job that is not trusted, and no layer needs a different layer.

1. The repository asks its owner before a job of an outside contributor starts. This is a setting of GitHub.
2. The policy gives a runner only to a trusted job.
3. The check on the machine fails a job that is not the job of the machine.
4. Each job has its own machine, with no credential and no route to a private network.
5. One switch stops the dispatcher and destroys each machine.

## The packages

This package is the plan. It does not exist yet.

| Package | What it has |
| --- | --- |
| `@mark1russell7/runner-dispatch` | The records of a run, a job and a machine, the policy, the sources, the providers and the dispatcher service. |

Other packages give the general parts:

- `@mark1russell7/service` gives the loops, the backoff and the retries.
- `@mark1russell7/algebra` gives the state machine of a machine and its timers, as data.
- `@procedures/gh` gives the calls of the GitHub API.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm lint:ste
```

The license is MIT.
