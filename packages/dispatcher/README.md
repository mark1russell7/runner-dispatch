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

## What the program adds

The program of the service is not in this package yet. It comes with item R5 of the roadmap, and it adds these parts:

- It reads the three documents: the trust rules, the times of a machine and the settings of a dispatcher.
- It gives the service the source of GitHub and the provider of the host.
- It reads the liveness of the service: a probe server of `@mark1russell7/service`, or a watchdog of the supervisor.
- It examines the declaration with `lint` before it starts the service, and it refuses a finding `violated`.

## The tests

Tests start the service on the fake world of `@mark1russell7/runner-dispatch/testing`, with the fake clock of `@mark1russell7/service/testing`:

- A job of a trusted run ends, and the passes come at the times of the loop.
- A pass with a failed request makes the loop wait longer, with the jitter.
- The bound stops a pass, and that pass is a failure.
- A shutdown leaves the machine, and the next start adopts it. The job ends one time.
- The stop switch destroys each machine.
- The liveness fails when a pass does not end, and it recovers after the pass ends.
- `lint` gives no finding `violated` for the declaration with each profile.
