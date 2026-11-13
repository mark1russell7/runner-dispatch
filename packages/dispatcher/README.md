# @runner-dispatch/dispatcher

The dispatcher of `runner-dispatch`, declared as one service of `@mark1russell7/service`. The package is private, and it is not on npm.

The package declares the service, and it has no program yet. The program comes with the first real source and the first real provider (items R4 and R5 of the roadmap).

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
- Each size of the settings has a template in `proxmox.sizes`. The field `proxmox.files` changes the two paths in the machine.
- The field `probes` is optional. It starts a probe server of `@mark1russell7/service/http` on its port, with the default host `127.0.0.1`.

The two secrets come from the environment: `RUNNER_DISPATCH_GITHUB_TOKEN` and `RUNNER_DISPATCH_PROXMOX_TOKEN`. `readSecrets` names a variable in a problem, but not its value.

`prepareProgram` starts nothing. It does these steps:

1. With an organization, it checks the runner group before the first pass. A group that admits a repository with no service, or a public repository, stops the program.
2. It makes the client of GitHub, the client of Proxmox VE with its transport, the source and the provider.
3. It declares the service, and it examines the declaration with `lint` on a host with no platform of pods. A finding `violated` stops the program.

`runProgram` then starts the service. The program writes JSON lines: the check of the runner group, the findings of `lint`, each pass that changes something and each failure. No line has a token or a one-job configuration.

The transport of `src/transport.ts` sends each exchange with `httpRequest` of `@procedures/http`:

- It sends an exchange only to the origin of the URL of Proxmox VE. The host policy lets it reach only that host and port.
- It does not follow a redirect, thus the token goes to no other host.
- Give the certificate authority of the host to `NODE_EXTRA_CA_CERTS`.

The command line of the program comes in part 3 of item R5. It uses the REST client of `@procedures/gh`.

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
