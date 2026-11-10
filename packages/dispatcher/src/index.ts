import { randomBytes } from "node:crypto";
import {
  createDispatcher,
  type DispatchSettings,
  type JobSource,
  type MachineProvider,
  type MachineTimes,
  type PassFailure,
  type PassReport,
  type TrustRules,
} from "@mark1russell7/runner-dispatch";
import { daemon, localDev, realClock, service, workerLoop } from "@mark1russell7/service";
import type { CheckFn, Clock, Profile, ServiceBuilder } from "@mark1russell7/service";

const s = (value: number) => ({ value, unit: "s" });

/** This name is the name of the worker of the service: the loop of the passes. */
export const LOOP_NAME = "passes";

/** This name is the name of the check that fails when the loop makes no pass. */
export const PROGRESS_NAME = "passes-progress";

/**
 * These are the profiles of the shutdown, by name. `local` is for the computer of a developer.
 * `daemon` is for a host under a supervisor: a second signal has no effect, thus a pass ends.
 */
export const PROFILES: { readonly local: Profile; readonly daemon: Profile } = { local: localDev, daemon };

/** This record has the times of the loop of the dispatcher, each in seconds. */
export interface LoopTimes {
  /** This field is the time from the end of a pass to the start of the next pass. */
  readonly sleep: number;
  /** This field is the most time of one pass. At it, the loop stops the pass, and the pass is a failure. */
  readonly bound: number;
  /** This field is the wait after the first pass that failed. Each failure after it makes the wait two times longer. */
  readonly retry: number;
  /** This field is the longest wait after a pass that failed, before its jitter. The jitter adds the time `retry` at most. */
  readonly retryMax: number;
  /** This field is the most time of the close of the loop, at the shutdown of the service. */
  readonly close: number;
}

const LOOP_KEYS: readonly (keyof LoopTimes)[] = ["sleep", "bound", "retry", "retryMax", "close"];

const told = (value: unknown): string => (typeof value === "number" ? String(value) : `a value of the type ${typeof value}`);

/**
 * This function gives the longest time between the starts of two passes, in seconds.
 * It is the time `bound` plus the longer of two waits: the sleep, and the longest wait after a failure.
 *
 * @param loop - The times of the loop
 * @returns The longest time between two passes, in seconds
 */
export const longestGap = (loop: LoopTimes): number => loop.bound + Math.max(loop.sleep, loop.retryMax + loop.retry);

/**
 * This function gives the problems of the times of a loop. An empty list tells that the times are valid.
 * The times are valid when the loop keeps the time `pass` of the machines: the timers of a machine use that time.
 *
 * @param loop - The times of the loop, in seconds
 * @param pass - The time `pass` of the times of a machine, in seconds
 * @returns The problems, one sentence for each
 */
export const loopProblems = (loop: LoopTimes, pass: number): string[] => {
  const problems: string[] = [];
  for (const key of LOOP_KEYS) {
    const value: unknown = loop[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) problems.push(`The field ${key} is not a number above 0: ${told(value)}.`);
  }
  if (problems.length > 0) return problems;
  if (loop.retryMax < loop.retry) problems.push(`The field retryMax (${loop.retryMax} s) is less than the field retry (${loop.retry} s).`);
  const gap = longestGap(loop);
  if (!(gap <= pass)) problems.push(`The longest time between two passes is ${gap} s. It is more than the time pass of the machines: ${told(pass)} s.`);
  return problems;
};

/** These are the options of the service: the parts of a dispatcher, the times of its loop and the profile of its shutdown. */
export interface Options {
  /** This field has the trust rules. */
  readonly rules: TrustRules;
  /** This field has the times of a machine. Its time `pass` is also the stall time of the loop. */
  readonly times: MachineTimes;
  /** This field has the settings of the dispatcher. */
  readonly settings: DispatchSettings;
  /** This field is the source of the jobs. Each request gets the signal of its pass. */
  readonly source: JobSource<AbortSignal>;
  /** This field is the provider of the machines. Each request gets the signal of its pass. */
  readonly provider: MachineProvider<AbortSignal>;
  /** This function reads the stop switch. It gives `true` when the switch is on. */
  readonly stopped: (signal: AbortSignal) => boolean | Promise<boolean>;
  /** This field has the times of the loop. */
  readonly loop: LoopTimes;
  /** This profile gives the phases of the shutdown and the effect of a second signal. */
  readonly profile: Profile;
  /** This function gets the report of each pass. A report has no one-job configuration, thus a log can keep it. */
  readonly onReport: (report: PassReport) => void;
  /** This function gets each pass that failed, with the count of failures in sequence. */
  readonly onError?: ((error: unknown, failures: number) => void) | undefined;
  /** This clock is the clock of the loop and of the dispatcher. Give the same clock to `run()`. The default is `realClock`. */
  readonly clock?: Clock | undefined;
  /** This function gives the random numbers of the jitter, from 0 up to 1. The default is `Math.random`. */
  readonly random?: (() => number) | undefined;
  /** This function gives the last part of the name of a new machine. The default is `randomSuffix`. */
  readonly suffix?: (() => string) | undefined;
}

/**
 * This function gives the last part of the name of a new machine: 8 digits of base 16.
 * The digits come from the random source of the system.
 *
 * @returns The 8 digits
 */
export const randomSuffix = (): string => randomBytes(4).toString("hex");

const SHOWN_FAILURES = 5;

/** This function tells the failed requests of a pass in one text, with 5 requests at most. */
const failureText = (failures: readonly PassFailure[]): string => {
  const shown = failures.slice(0, SHOWN_FAILURES).map((each) => `${each.target === "" ? each.request : `${each.request} ${each.target}`}: ${each.text}`);
  const more = failures.length - shown.length;
  return `Failed requests of the pass: ${failures.length}. ${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}.`;
};

/**
 * This function declares the dispatcher as one service. It starts nothing: `describe()` gives the declaration as data.
 * The loop of the passes is a worker of the service, with one lane.
 *
 * - A pass with a failed request is a failure of the loop. The loop then waits longer before the next pass.
 * - The check `passes-progress` fails when no pass ended in the time `pass`. It gates the liveness of the service.
 * - A shutdown leaves each machine. The next start of the service finds each machine in the list of the provider.
 *
 * @param options - The parts of a dispatcher, the times of its loop and the profile of its shutdown
 * @returns The builder of the service
 * @throws RangeError when the trust rules, the times of a machine, the settings or the times of the loop are not valid
 */
export const declare = (options: Options): ServiceBuilder => {
  const clock = options.clock ?? realClock;
  const dispatcher = createDispatcher<AbortSignal>({
    rules: options.rules,
    times: options.times,
    settings: options.settings,
    source: options.source,
    provider: options.provider,
    now: () => clock.now(),
    suffix: options.suffix ?? randomSuffix,
    stopped: options.stopped,
  });
  const problems = loopProblems(options.loop, options.times.pass);
  if (problems.length > 0) throw new RangeError(`The times of the loop are not valid. ${problems.join(" ")}`);

  // The mark is the time of the start of the first pass, then the time of the end of the last pass.
  let mark: number | null = null;
  const stall = options.times.pass * 1000;
  const progress: CheckFn = () => (mark === null || clock.now() - mark <= stall ? "ok" : "error");

  const loop = workerLoop(
    {
      worker_sleep: s(options.loop.sleep),
      unit_processing_time: s(options.loop.bound),
      retry_base: s(options.loop.retry),
      retry_cap: s(options.loop.retryMax),
      close_bound: s(options.loop.close),
      concurrency: { value: 1, unit: "count" },
    },
    {
      iteration: async ({ signal }): Promise<void> => {
        mark ??= clock.now();
        try {
          const report = await dispatcher.pass(signal);
          options.onReport(report);
          if (report.cut) throw new Error("The signal stopped the pass before each request started.");
          if (report.failures.length > 0) throw new Error(failureText(report.failures));
        } finally {
          mark = clock.now();
        }
      },
      clock,
      random: options.random,
      onError: options.onError,
    },
  );

  return (
    service("dispatcher")
      .worker(LOOP_NAME, loop.knobs, loop)
      .check(
        {
          name: PROGRESS_NAME,
          dependency: null,
          step: "progress",
          ownConnection: false,
          gates: "liveness",
          poll: { interval: s(5), jitter: 0.2, timeout: s(1) },
          marks: { loops: [LOOP_NAME], stall: s(options.times.pass) },
        },
        progress,
      )
      // The service has no listener, thus no check gates its readiness.
      .readiness({ type: "debounce", interval: s(5), failAfter: 3, recoverAfter: 1 })
      .liveness({ type: "window", failAfter: s(45) })
      .startup(s(30))
      .profile(options.profile)
  );
};
