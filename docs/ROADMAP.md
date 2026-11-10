# Roadmap

This file is the plan of runner-dispatch. The Status page of the site reads it, and the tracker of the project mirrors it.

| ID | Item | Status | Summary |
| --- | --- | --- | --- |
| R1 | The first package: the records and the policy | done | `@mark1russell7/runner-dispatch` has the records of a run, a job and a machine, the run label, and the trust rules as a document. The policy is a function from the record of a run to trusted or not trusted, with each reason. Property tests hold it: a run from a fork is not trusted, for each value of the other fields. |
| R2 | The check on the machine | open | The job-started script of the runner. It tests the policy again from the event file of the job, and it compares the run with the run of the machine. A probe measured the sequence for the runner program 2.338.2: the script is the second step of a job, before each image pull and each step, and its failure skips them. The documentation does not state this sequence. Thus the probe becomes a test, and each new version of the runner program must pass it. |
| R3 | The state machine of a machine | open | The states of one machine and its timers, as data on `@mark1russell7/algebra`: asked, made, registered, busy, done, destroyed. Each path ends in destroyed. |
| R4 | The GitHub source | open | It polls the queued jobs of the served repositories with conditional requests. It makes the one-job configuration of a runner, for a repository or for an organization. The README gives the permissions of each place. A test with a real credential measures the smallest permissions. |
| R5 | The Proxmox provider | open | It clones a template, gives the machine its configuration through cloud-init, and destroys the machine. |
| R6 | The dispatcher service | open | The loop joins the source, the policy and the provider, on `@mark1russell7/service`. It has a stop switch. After a restart, it finds each machine, and no machine stays without a job. |
| R7 | The tests of the gate | open | Tests on real jobs: a fork that names the label, a fork that takes the label of a trusted run, the sequence of the check, `pull_request_target`, the stop switch, the network of a machine, a clean machine after a job, and a stop of the dispatcher in the middle of a job. |
| R8 | The measures | open | The queue time, the start time of a machine and the job time of each job, as records. |
| R9 | The first release to npm | open | The package gets its build, its `publishConfig` and its API report, and it loses `private`. The release needs the bootstrap of a new package (`RELEASING.md`). It comes before the first deployment of the service. |
