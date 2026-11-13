# runner-dispatch

One-job CI runners for trusted jobs. The dispatcher gives a waiting job of GitHub Actions a new machine, for that job only. It destroys the machine after the job.

The first package has the records, the trust rules, the check on the machine and the life of a machine. It also has the passes of a dispatcher and the GitHub source for runners of a repository or of an organization. The second package declares the dispatcher as a service. The provider of Proxmox VE and the program of the service are also not written yet. [`docs/ROADMAP.md`](docs/ROADMAP.md) has the plan.

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

## The credential

The dispatcher asks GitHub for the one-job configuration of each runner. The permission of that request decides what a stolen credential can do. The permission pages of the GitHub REST documentation give these rules for a fine-grained token and for a GitHub App:

| Where the runner registers | The permissions of the dispatcher | What the credential can also do |
| --- | --- | --- |
| A repository | `Administration` write and `Actions` read on each served repository | Change each setting of the repository, and delete it. |
| An organization | The organization permission "Self-hosted runners" write, and `Actions` read on the served repositories | Make and remove runners. It cannot change a repository. |

- Thus an organization gives the smaller credential. There, the dispatcher can be a GitHub App with only these two permissions.
- For a repository of a personal account, give the credential only the served repositories.
- A machine of a job does not get the credential. It gets only the one-job configuration of its runner.
- The source supports runners of a repository and runners of an organization.
- A runner of an organization can take a job of each repository that its runner group admits. `checkRunnerGroup` examines that the group admits only the served repositories.

## The packages

| Package | What it has |
| --- | --- |
| [`@mark1russell7/runner-dispatch`](packages/runner-dispatch) | The records of a run, a job and a machine, the trust rules as data, the policy, the check on the machine with its job-started program, and the life of a machine as a state machine. It also has the settings of a dispatcher, the two ports, the plan of a pass, the GitHub source and a fake world for tests. It is not on npm yet. |
| [`@runner-dispatch/dispatcher`](packages/dispatcher) | The dispatcher as one service of `@mark1russell7/service`: the loop of the passes, its times, its liveness check and its shutdown. The program comes with the first source and the first provider. It is private. |

Other packages give the general parts:

- `@mark1russell7/service` gives the loops, the backoff and the retries.
- `@mark1russell7/algebra` gives the state machine of a machine and its timers, as data.
- `@procedures/gh` gives the calls of the GitHub API. The GitHub source sends its requests through such a client.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm lint:ste
```

The license is MIT.
