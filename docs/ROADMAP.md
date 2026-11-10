# Roadmap

This file is the plan of runner-dispatch. The Status page of the site reads it, and the tracker of the project mirrors it.

| ID | Item | Status | Summary |
| --- | --- | --- | --- |
| R1 | The first package: the records and the policy | open | Make `@mark1russell7/runner-dispatch` with `pnpm package add`. It has the records of a run, a job and a machine. The policy is a function from the record of a run to trusted or not trusted, with the reason. Property tests hold it: a run from a fork is not trusted, for each value of the other fields. |
| R2 | The check on the machine | open | The job-started script of the runner. It tests the policy again from the event file of the job, and it compares the run with the run of the machine. A test measures that no step and no image pull come before it. |
| R3 | The state machine of a machine | open | The states of one machine and its timers, as data on `@mark1russell7/algebra`: asked, made, registered, busy, done, destroyed. Each path ends in destroyed. |
| R4 | The GitHub source | open | It polls the queued jobs of the served repositories with conditional requests. It makes the one-job configuration of a runner. |
| R5 | The Proxmox provider | open | It clones a template, gives the machine its configuration through cloud-init, and destroys the machine. |
| R6 | The dispatcher service | open | The loop joins the source, the policy and the provider, on `@mark1russell7/service`. It has a stop switch. After a restart, it finds each machine, and no machine stays without a job. |
| R7 | The tests of the gate | open | Tests on real jobs: a fork that names the label, a fork that takes the label of a trusted run, the sequence of the check, `pull_request_target`, the stop switch, the network of a machine, a clean machine after a job, and a stop of the dispatcher in the middle of a job. |
| R8 | The measures | open | The queue time, the start time of a machine and the job time of each job, as records. |
