import {
  machineName,
  type DispatchSettings,
  type JobSource,
  type MachineTimes,
  type PassReport,
  type RunRecord,
  type TrustRules,
} from "@mark1russell7/runner-dispatch";
import { countingSuffix, fakeWorld, type FakeWorld, type WorldFault, type WorldJobInput, type WorldRequest, type WorldTimes } from "@mark1russell7/runner-dispatch/testing";
import { CLOSE_BOUND_RULE, daemon, lint, localDev, PROGRESS_RULE, UNIT_BOUND_RULE } from "@mark1russell7/service";
import type { Lifecycle, Scenario } from "@mark1russell7/service";
import { fakeClock, fakeProcess, type FakeClock, type FakeProcess } from "@mark1russell7/service/testing";
import { describe, expect, it } from "vitest";
import { declare, LOOP_NAME, longestGap, loopProblems, PROFILES, PROGRESS_NAME, randomSuffix, type LoopTimes, type Options } from "./index.ts";

const s = (value: number) => ({ value, unit: "s" });

const REPO = "octo/app";
const RULES: TrustRules = { repositories: [REPO], events: ["push"], actors: ["octo"] };
const TIMES: MachineTimes = { make: 60, register: 60, idle: 30, job: 600, retry: 5, retryMax: 40, pass: 10 };
const SETTINGS: DispatchSettings = { prefix: "rd", capacity: 3, sizes: ["small", "large"], standard: "small" };
const WORLD: WorldTimes = { boot: 2000, connect: 1000, destroy: 500 };
// The longest time between two passes is 2 s + the longer of 5 s and 2 s + 1 s: 7 s. The time `pass` is 10 s.
const LOOP: LoopTimes = { sleep: 5, bound: 2, retry: 1, retryMax: 2, close: 0.5 };
const M0 = "rd-100-1-00000000";

// A host with no platform of pods: no probe of a kubelet adds to the windows of the declaration.
const HOST: Scenario = { platform: {}, probes: { readiness: s(0), liveness: s(0) } };

const runRecord = (runId = 100): RunRecord => ({
  repository: REPO,
  runId,
  runAttempt: 1,
  event: "push",
  headRepository: REPO,
  actor: "octo",
  triggeringActor: "octo",
});
const own = (duration = 4000, runId = 100): WorldJobInput => ({ labels: [`run-${runId}-1`], duration });

/** This type is a fake world with the service of the dispatcher on it. A test moves the clock. */
interface Stage {
  readonly clock: FakeClock;
  readonly world: FakeWorld;
  /** This list has the report of each pass. */
  readonly reports: PassReport[];
  /** This list has each failure of the loop: its text, and the count of failures in sequence. */
  readonly errors: (readonly [string, number])[];
  /** This field is the stop switch. */
  stop: boolean;
  /** This function gives the fault of each request to the world. */
  fault: (request: WorldRequest, target: string) => WorldFault | null;
  /** This field is the fake process of the last start. */
  process: FakeProcess;
  /** This method gives the options of the service. */
  options(over?: Partial<Options>): Options;
  /** This method starts a new service on the world, as a process that starts again. */
  start(over?: Partial<Options>): Promise<Lifecycle>;
  /** This method moves the clock in steps, and lets the work of each step end. */
  run(ms: number, step?: number): Promise<void>;
  /** This method asks for the shutdown, and moves the clock until the exit. It gives the exit code. */
  end(life: Lifecycle): Promise<number>;
}

/** This function lets each promise chain of the turn end. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const stage = (start = 0): Stage => {
  const clock = fakeClock(start);
  const made: Stage = {
    clock,
    world: fakeWorld({ clock, times: WORLD, faults: (request, target) => made.fault(request, target) }),
    reports: [],
    errors: [],
    stop: false,
    fault: () => null,
    process: fakeProcess({ clock }),
    options: (over: Partial<Options> = {}): Options => ({
      rules: RULES,
      times: TIMES,
      settings: SETTINGS,
      source: made.world.source,
      provider: made.world.provider,
      stopped: () => made.stop,
      loop: LOOP,
      profile: PROFILES.local,
      onReport: (report) => made.reports.push(report),
      onError: (error, failures) => made.errors.push([error instanceof Error ? error.message : String(error), failures]),
      clock,
      random: () => 0,
      suffix: countingSuffix(),
      ...over,
    }),
    async start(over: Partial<Options> = {}): Promise<Lifecycle> {
      made.process = fakeProcess({ clock });
      let ended = false;
      const run = declare(made.options(over))
        .run({ clock, process: made.process })
        .finally(() => {
          ended = true;
        });
      for (let step = 0; step < 50 && !ended; step += 1) {
        await clock.advance(0);
        await settle();
      }
      return run;
    },
    async run(ms: number, step = 500): Promise<void> {
      for (let moved = 0; moved < ms; moved += step) {
        await clock.advance(Math.min(step, ms - moved));
        await settle();
      }
    },
    async end(life: Lifecycle): Promise<number> {
      const exit = life.shutdown("The test ended.");
      for (let step = 0; step < 200 && life.state !== "exited"; step += 1) {
        await clock.advance(100);
        await settle();
      }
      return exit;
    },
  };
  return made;
};

describe("the times of the loop", () => {
  it("gives the longest time between two passes: the bound, plus the longer of the sleep and the longest wait after a failure", () => {
    expect(longestGap(LOOP)).toBe(7);
    expect(longestGap({ ...LOOP, retryMax: 6 })).toBe(9);
    expect(longestGap({ ...LOOP, sleep: 3 })).toBe(5);
  });

  it("has no problem when the loop keeps the time pass, also at the limit", () => {
    expect(loopProblems(LOOP, 10)).toEqual([]);
    expect(loopProblems(LOOP, 7)).toEqual([]);
    expect(loopProblems({ ...LOOP, retry: 2, retryMax: 2 }, 7)).toEqual([]);
  });

  const bad: readonly (readonly [string, LoopTimes, number, readonly string[]])[] = [
    ["a sleep of 0", { ...LOOP, sleep: 0 }, 10, ["The field sleep is not a number above 0: 0."]],
    ["a bound below 0", { ...LOOP, bound: -1 }, 10, ["The field bound is not a number above 0: -1."]],
    ["a retry that is not a number", { ...LOOP, retry: "1" as unknown as number }, 10, ["The field retry is not a number above 0: a value of the type string."]],
    ["a longest wait with no end", { ...LOOP, retryMax: Infinity }, 10, ["The field retryMax is not a number above 0: Infinity."]],
    ["no close", { ...LOOP, close: undefined as unknown as number }, 10, ["The field close is not a number above 0: a value of the type undefined."]],
    [
      "two fields that are not valid",
      { ...LOOP, sleep: Number.NaN, close: 0 },
      10,
      ["The field sleep is not a number above 0: NaN.", "The field close is not a number above 0: 0."],
    ],
    ["a longest wait below the first wait", { ...LOOP, retry: 2, retryMax: 1 }, 10, ["The field retryMax (1 s) is less than the field retry (2 s)."]],
    ["a sleep that breaks the time pass", { ...LOOP, sleep: 8.5 }, 10, ["The longest time between two passes is 10.5 s. It is more than the time pass of the machines: 10 s."]],
    ["waits after a failure that break the time pass", { ...LOOP, retryMax: 8 }, 10, ["The longest time between two passes is 11 s. It is more than the time pass of the machines: 10 s."]],
    ["a bound that breaks the time pass", { ...LOOP, bound: 5.5 }, 10, ["The longest time between two passes is 10.5 s. It is more than the time pass of the machines: 10 s."]],
    ["a time pass that is not a number", LOOP, Number.NaN, ["The longest time between two passes is 7 s. It is more than the time pass of the machines: NaN s."]],
  ];
  for (const [name, loop, pass, problems] of bad) {
    it(`gives the problems of ${name}`, () => {
      expect(loopProblems(loop, pass)).toEqual(problems);
    });
  }
});

describe("the declaration of the service", () => {
  it("has the profile of a developer and the profile of a host under a supervisor", () => {
    expect(PROFILES).toEqual({ local: localDev, daemon });
  });

  it("names the service, its worker and its check: a log and a probe report show these names", () => {
    expect([declare(stage().options()).describe().name, LOOP_NAME, PROGRESS_NAME]).toEqual(["dispatcher", "passes", "passes-progress"]);
  });

  it("declares its policies, its startup budget and the poll of its check", () => {
    const description = declare(stage().options()).describe();
    expect(description.policies).toEqual({
      readiness: { type: "debounce", interval: s(5), failAfter: 3, recoverAfter: 1 },
      liveness: { type: "window", failAfter: s(45) },
      startup: s(30),
    });
    expect(description.checks.map((check) => [check.dependency, check.ownConnection, check.poll])).toEqual([[null, false, { interval: s(5), jitter: 0.2, timeout: s(1) }]]);
    expect(description.transports.map((transport) => transport.knobs)).toEqual([
      { worker_sleep: s(5), unit_processing_time: s(2), retry_base: s(1), retry_cap: s(2), close_bound: s(0.5), concurrency: { value: 1, unit: "count" } },
    ]);
  });

  for (const [name, profile] of Object.entries(PROFILES)) {
    it(`passes describe() and lint() with the profile ${name}`, () => {
      const description = declare(stage().options({ profile })).describe();
      expect(description.transports.map((transport) => [transport.kind, transport.name])).toEqual([["worker", LOOP_NAME]]);
      expect(description.checks.map((check) => [check.name, check.step, check.gates, check.marks])).toEqual([
        [PROGRESS_NAME, "progress", "liveness", { loops: [LOOP_NAME], stall: s(10) }],
      ]);
      // The bound of a pass is less than the cap of the drain, and the stall time is not less than the longest gap of the loop.
      const findings = lint(description, HOST, []);
      expect(findings.map((finding) => [finding.rule, finding.scope, finding.verdict])).toEqual([
        [PROGRESS_RULE, PROGRESS_NAME, "holds"],
        [UNIT_BOUND_RULE, LOOP_NAME, "holds"],
        [CLOSE_BOUND_RULE, LOOP_NAME, "holds"],
      ]);
    });
  }

  it("tells with lint() a bound of a pass that the drain of the profile can cut", () => {
    // The drain of the profile has a cap of 4 s. A pass of 4 s can end after it.
    const description = declare(stage().options({ loop: { ...LOOP, bound: 4, sleep: 1 } })).describe();
    const findings = lint(description, HOST, []);
    expect(findings.filter((finding) => finding.verdict !== "holds").map((finding) => [finding.rule, finding.verdict])).toEqual([[UNIT_BOUND_RULE, "violated"]]);
  });

  it("refuses times of the loop that do not keep the time pass", () => {
    expect(() => declare(stage().options({ loop: { ...LOOP, sleep: 9 } }))).toThrow(
      new RangeError("The times of the loop are not valid. The longest time between two passes is 11 s. It is more than the time pass of the machines: 10 s."),
    );
  });

  it("refuses the documents that a dispatcher refuses", () => {
    expect(() => declare(stage().options({ settings: { ...SETTINGS, capacity: 0 } }))).toThrow(RangeError);
    expect(() => declare(stage().options({ rules: { ...RULES, events: ["push", "push"] } }))).toThrow(
      new RangeError('The trust rules of the dispatcher are not valid. The entry 1 of events is in the list two times: "push".'),
    );
    expect(() => declare(stage().options({ times: { ...TIMES, pass: 0 } }))).toThrow(RangeError);
  });
});

describe("randomSuffix", () => {
  it("gives 8 digits of base 16 that a machine name takes", () => {
    for (let count = 0; count < 100; count += 1) {
      const suffix = randomSuffix();
      expect(suffix).toMatch(/^[0-9a-f]{8}$/);
      expect(machineName("rd", { runId: 100, runAttempt: 1 }, suffix)).toBe(`rd-100-1-${suffix}`);
    }
  });

  it("is the suffix of a service that names none", async () => {
    const at = stage();
    at.world.addRun(runRecord(), [own()]);
    const life = await at.start({ suffix: undefined });
    await at.run(1000);
    expect(at.reports[0]?.made.map((machine) => machine.name)).toEqual([expect.stringMatching(/^rd-100-1-[0-9a-f]{8}$/)]);
    expect(await at.end(life)).toBe(0);
  });
});

describe("the service on a fake world", () => {
  it("does a job, and each pass starts one sleep after the end of the pass before", async () => {
    const at = stage();
    at.world.addRun(runRecord(), [own(4000)]);
    const life = await at.start();
    await at.run(20_000);
    // The passes of the fake world take no time. Thus a pass starts each 5 s.
    expect(at.reports.map((report) => report.at)).toEqual([0, 5000, 10_000, 15_000, 20_000]);
    expect(at.reports.map((report) => report.steps.map((step) => step.transition))).toEqual([[], ["made", "registered", "started"], ["completed"], ["destroyed"], []]);
    expect(at.world.jobs().map((job) => job.result)).toEqual(["success"]);
    expect(at.world.machines()).toEqual([]);
    expect(at.errors).toEqual([]);
    expect(life.health.verdict().alive).toBe(true);
    expect(life.health.verdict().checks[PROGRESS_NAME]?.last?.outcome).toBe("ok");
    expect(await at.end(life)).toBe(0);
    expect(life.errors).toEqual([]);
    expect(at.process.exits).toEqual([0]);
  });

  it("waits longer after each pass with a failed request, and then it does the sleep again", async () => {
    const at = stage();
    at.fault = (request) => (request === "view" && at.clock.now() < 5000 ? "refuse" : null);
    const life = await at.start();
    await at.run(10_000);
    // The waits are 1 s, 2 s and 2 s: two times longer after each failure, to the longest wait. The jitter is 0.
    expect(at.reports.map((report) => [report.at, report.failures.length])).toEqual([
      [0, 1],
      [1000, 1],
      [3000, 1],
      [5000, 0],
      [10_000, 0],
    ]);
    const text = 'Failed requests of the pass: 1. view octo/app: "The fake world refused the request view.".';
    expect(at.errors).toEqual([
      [text, 1],
      [text, 2],
      [text, 3],
    ]);
    expect(await at.end(life)).toBe(0);
    expect(life.errors).toEqual([]);
  });

  it("adds the jitter to the wait after a failure: the time retry at most", async () => {
    const at = stage();
    at.fault = (request) => (request === "machines" && at.clock.now() < 1000 ? "refuse" : null);
    const life = await at.start({ random: () => 0.5 });
    await at.run(8000);
    expect(at.reports.map((report) => report.at)).toEqual([0, 1500, 6500]);
    expect(await at.end(life)).toBe(0);
  });

  it("tells each failed request of a pass, with 5 requests at most in the text", async () => {
    const at = stage();
    const repositories = ["octo/a", "octo/b", "octo/c", "octo/d", "octo/e", "octo/f"];
    at.fault = (request) => (request === "view" || request === "machines" ? "refuse" : null);
    const life = await at.start({ rules: { ...RULES, repositories } });
    await at.run(500);
    expect(at.reports[0]?.failures).toHaveLength(7);
    expect(at.errors[0]).toEqual([
      "Failed requests of the pass: 7. " +
        'machines: "The fake world refused the request machines.", ' +
        'view octo/a: "The fake world refused the request view.", ' +
        'view octo/b: "The fake world refused the request view.", ' +
        'view octo/c: "The fake world refused the request view.", ' +
        'view octo/d: "The fake world refused the request view.", ' +
        "and 2 more.",
      1,
    ]);
    expect(await at.end(life)).toBe(0);
  });

  it("stops a pass at its bound, and the pass is a failure", async () => {
    const at = stage();
    let waits = 0;
    // The first view does not answer until its signal stops it.
    const source: JobSource<AbortSignal> = {
      ...at.world.source,
      view: (repository, runs, signal) => {
        waits += 1;
        if (waits > 1) return at.world.source.view(repository, runs, signal);
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("The signal stopped the view.")), { once: true });
        });
      },
    };
    const life = await at.start({ source });
    await at.run(9000);
    // The bound is 2 s, then the wait after a failure is 1 s, then the sleep is 5 s.
    expect(at.reports.map((report) => [report.at, report.failures.map((failure) => failure.text)])).toEqual([
      [0, ['"The signal stopped the view."']],
      [3000, []],
      [8000, []],
    ]);
    expect(at.errors).toEqual([["the unit did not end in its unit_processing_time of 2000 ms", 1]]);
    expect(await at.end(life)).toBe(0);
    expect(life.errors).toEqual([]);
  });

  it("counts a pass that its bound cuts as a failure, also when no request failed", async () => {
    const at = stage();
    at.world.addRun(runRecord(), [own()]);
    let views = 0;
    // The first view answers only when its signal stops it, and its answer is good.
    const source: JobSource<AbortSignal> = {
      ...at.world.source,
      view: async (repository, runs, signal) => {
        views += 1;
        if (views === 1) {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        return at.world.source.view(repository, runs, new AbortController().signal);
      },
    };
    const life = await at.start({ source });
    await at.run(4000);
    // The first pass asks for no machine: the bound came before the request. The next pass comes after the wait of a failure.
    expect(at.reports.map((report) => [report.at, report.cut, report.failures.length, report.made.length])).toEqual([
      [0, true, 0, 0],
      [3000, false, 0, 1],
    ]);
    expect(at.errors).toEqual([["the unit did not end in its unit_processing_time of 2000 ms", 1]]);
    expect(await at.end(life)).toBe(0);
  });

  it("leaves the machines at a shutdown, and the next start adopts them", async () => {
    const at = stage();
    at.world.addRun(runRecord(), [own(20_000)]);
    const first = await at.start();
    await at.run(6000);
    expect(at.world.machines().map((machine) => [machine.machine.name, machine.status])).toEqual([[M0, "operating"]]);
    expect(await at.end(first)).toBe(0);
    expect(first.errors).toEqual([]);
    // The shutdown sends no request for the machine: the job continues.
    expect(at.world.machines().map((machine) => [machine.machine.name, machine.status])).toEqual([[M0, "operating"]]);
    expect(at.world.jobs().map((job) => [job.status, job.result])).toEqual([["in_progress", null]]);

    const count = at.reports.length;
    const second = await at.start({ suffix: countingSuffix(1) });
    await at.run(30_000);
    expect(at.reports[count]?.adopted).toEqual([M0]);
    expect(at.world.jobs().map((job) => job.result)).toEqual(["success"]);
    expect(at.world.machines()).toEqual([]);
    expect(at.world.peak()).toBe(1);
    expect(await at.end(second)).toBe(0);
  });

  it("stops a pass in work at a shutdown, and it is not a failure of the loop", async () => {
    const at = stage();
    const source: JobSource<AbortSignal> = {
      ...at.world.source,
      view: (_repository, _runs, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("The signal stopped the view.")), { once: true });
        }),
    };
    // The drain of the profile stops the work 2 s after its start. That is before the bound of this pass: 3 s.
    const life = await at.start({ source, loop: { ...LOOP, bound: 3 } });
    await at.run(500);
    expect(at.reports).toEqual([]);
    expect(await at.end(life)).toBe(0);
    expect(at.reports.map((report) => [report.at, report.failures.map((failure) => failure.text)])).toEqual([[0, ['"The signal stopped the view."']]]);
    expect(at.errors).toEqual([]);
    expect(life.errors).toEqual([]);
  });

  it("tells a pass that the bound stops during a shutdown", async () => {
    const at = stage();
    const source: JobSource<AbortSignal> = {
      ...at.world.source,
      view: (_repository, _runs, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("The signal stopped the view.")), { once: true });
        }),
    };
    // The bound of the pass comes at 2 s. The shutdown starts at 1 s, thus its drain stops the work at 3 s.
    const life = await at.start({ source });
    await at.run(1000);
    expect(await at.end(life)).toBe(0);
    expect(at.reports).toHaveLength(1);
    expect(at.errors).toEqual([["the unit did not end in its unit_processing_time of 2000 ms", 1]]);
    expect(life.errors).toEqual([]);
  });

  it("destroys each machine when the stop switch is on", async () => {
    const at = stage();
    at.world.addRun(runRecord(), [own(20_000)]);
    const life = await at.start();
    await at.run(6000);
    at.stop = true;
    await at.run(10_000);
    expect(at.world.machines()).toEqual([]);
    expect(at.world.jobs().map((job) => job.result)).toEqual(["lost"]);
    expect(at.reports.at(-1)?.stopped).toBe(true);
    expect(await at.end(life)).toBe(0);
  });
});

describe("the liveness of the service", () => {
  it("passes before the first pass, on a clock that does not start at 0", async () => {
    const at = stage(1_000_000);
    const life = await at.start();
    expect(life.health.verdict().checks[PROGRESS_NAME]?.last).toMatchObject({ outcome: "ok", at: 1_000_000 });
    await at.run(12_000, 1000);
    expect(at.reports.map((report) => report.at)).toEqual([1_000_000, 1_005_000, 1_010_000]);
    expect(life.health.verdict().checks[PROGRESS_NAME]?.last?.outcome).toBe("ok");
    expect(await at.end(life)).toBe(0);
  });

  it("fails when a pass does not end, and recovers when the passes come again", async () => {
    const at = stage();
    let release: () => void = () => {};
    let held = true;
    // The view does not answer, and it does not read its signal: the bound cannot stop the pass.
    const source: JobSource<AbortSignal> = {
      ...at.world.source,
      view: (repository, runs, signal) => {
        if (!held) return at.world.source.view(repository, runs, signal);
        return new Promise((_, reject) => {
          release = (): void => reject(new Error("The view ended late."));
        });
      },
    };
    const life = await at.start({ source });
    await at.run(10_000, 1000);
    expect(life.health.verdict().checks[PROGRESS_NAME]?.last?.outcome).toBe("ok");
    expect(life.health.verdict().alive).toBe(true);
    // The stall time is the time pass: 10 s. Then the liveness fails after its window of 45 s.
    await at.run(10_000, 1000);
    expect(life.health.verdict().checks[PROGRESS_NAME]?.last?.outcome).toBe("error");
    expect(life.health.verdict().alive).toBe(true);
    await at.run(50_000, 1000);
    expect(life.health.verdict().alive).toBe(false);
    expect(life.health.probe("liveness").status).toBe(503);

    held = false;
    release();
    await at.run(20_000, 1000);
    expect(life.health.verdict().checks[PROGRESS_NAME]?.last?.outcome).toBe("ok");
    expect(life.health.verdict().alive).toBe(true);
    expect(await at.end(life)).toBe(0);
  });
});
