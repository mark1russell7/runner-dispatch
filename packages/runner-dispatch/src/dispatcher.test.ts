import { fakeClock, type FakeClock } from "@mark1russell7/algebra/clock";
import { replay, type Transition } from "@mark1russell7/algebra/replay";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createDispatcher, type Dispatcher, type DispatcherOptions, type PassReport } from "./dispatcher.ts";
import { MACHINE_LIFECYCLE, type MachineTimes } from "./lifecycle.ts";
import { decide, type TrustRules } from "./policy.ts";
import type { JobSource, MachineProvider } from "./ports.ts";
import type { RunKey, RunRecord } from "./records.ts";
import { parseMachineName, type DispatchSettings } from "./settings.ts";
import { countingSuffix, fakeWorld, type FakeWorld, type WorldFault, type WorldJobInput, type WorldRequest, type WorldTimes } from "./testing.ts";

const REPO = "octo/app";
const RULES: TrustRules = { repositories: [REPO], events: ["push", "pull_request"], actors: ["octo"] };
const TIMES: MachineTimes = { make: 60, register: 60, idle: 30, job: 600, retry: 5, retryMax: 40, pass: 10 };
const SETTINGS: DispatchSettings = { prefix: "rd", capacity: 3, sizes: ["small", "large"], standard: "small" };
const WORLD: WorldTimes = { boot: 2000, connect: 1000, destroy: 500 };
const M0 = "rd-100-1-00000000";
const M1 = "rd-100-1-00000001";

const runRecord = (runId = 100, over: Partial<RunRecord> = {}): RunRecord => ({
  repository: REPO,
  runId,
  runAttempt: 1,
  event: "push",
  headRepository: REPO,
  actor: "octo",
  triggeringActor: "octo",
  ...over,
});
const FORK: Partial<RunRecord> = { event: "pull_request", headRepository: "evil/app", actor: "evil", triggeringActor: "evil" };
const own = (duration = 4000, runId = 100): WorldJobInput => ({ labels: [`run-${runId}-1`], duration });

interface StageOptions {
  readonly rules?: TrustRules;
  readonly settings?: DispatchSettings;
  readonly times?: MachineTimes;
  readonly world?: WorldTimes;
}
/** This type is a fake world with a dispatcher on it. A test moves the clock between the passes. */
interface Stage {
  readonly clock: FakeClock;
  readonly world: FakeWorld;
  /** This list has the report of each pass, with the number of the start of its dispatcher. */
  readonly reports: { readonly start: number; readonly report: PassReport }[];
  /** This field is the stop switch. `null` makes the read of the switch fail. */
  stop: boolean | null;
  /** This function gives the fault of each request to the world. */
  fault: (request: WorldRequest, target: string) => WorldFault | null;
  /** This method starts a new dispatcher with an empty memory, as a process that starts again. */
  restart(options?: StageOptions): void;
  /** This method does one pass, then it moves the clock. */
  turn(ms?: number): Promise<PassReport>;
  /** This method does passes to a time of the clock. */
  until(time: number, ms?: number): Promise<void>;
  /** This method gives the transitions of each machine, for a replay. */
  trace(): Transition[];
  /** This method gives the ids of the transitions of one machine. */
  path(name: string): string[];
  /** This method gives the counts of failed machines in the memory of the dispatcher. */
  failures(): unknown;
  readonly signal: AbortSignal;
}

const stage = (options: StageOptions = {}): Stage => {
  const clock = fakeClock(0);
  const signal = new AbortController().signal;
  const suffix = countingSuffix();
  let dispatcher: Dispatcher<AbortSignal>;
  let start = 0;
  const made: Stage = {
    clock,
    world: fakeWorld({ clock, times: options.world ?? WORLD, faults: (request, target) => made.fault(request, target) }),
    reports: [],
    stop: false,
    fault: () => null,
    signal,
    restart(next: StageOptions = options): void {
      start += 1;
      dispatcher = createDispatcher({
        rules: next.rules ?? RULES,
        times: next.times ?? TIMES,
        settings: next.settings ?? SETTINGS,
        source: made.world.source,
        provider: made.world.provider,
        now: () => clock.now(),
        suffix,
        stopped: () => {
          if (made.stop === null) throw new Error("The switch is not readable.");
          return made.stop;
        },
      });
    },
    async turn(ms = 5000): Promise<PassReport> {
      const report = await dispatcher.pass(signal);
      made.reports.push({ start, report });
      await clock.advance(ms);
      return report;
    },
    async until(time: number, ms = 5000): Promise<void> {
      while (clock.now() < time) await made.turn(ms);
    },
    trace: () =>
      made.reports.flatMap(({ start: at, report }) =>
        report.steps.map((step) => ({ machine: MACHINE_LIFECYCLE.id, instance: `${at}:${step.machine}`, from: step.from, on: step.on, to: step.to, at: step.at })),
      ),
    failures: () => dispatcher.state().failures,
    path: (name: string) => made.reports.flatMap(({ report }) => report.steps.filter((step) => step.machine === name).map((step) => step.transition)),
  };
  made.restart();
  return made;
};

/** This function examines the trace of a stage: each machine follows the document, from its first state. */
const expectReplay = (at: Stage): void => {
  const trace = at.trace();
  expect(replay(MACHINE_LIFECYCLE, trace, { machine: MACHINE_LIFECYCLE.id })).toEqual([]);
  const first = new Map<string, string>();
  for (const step of trace) if (!first.has(step.instance)) first.set(step.instance, step.from);
  expect([...first.values()].every((from) => from === "asked")).toBe(true);
};
/** This function examines that no report has a one-job configuration. */
const expectNoSecret = (at: Stage): void => {
  const text = JSON.stringify(at.reports);
  for (const secret of at.world.secrets()) expect(text.includes(secret)).toBe(false);
};
const kinds = (at: Stage, name: string): string[] =>
  at.world
    .events()
    .filter((event) => event.name === name)
    .map((event) => event.kind);

describe("createDispatcher", () => {
  const ports = (): { source: JobSource; provider: MachineProvider } => fakeWorld({ clock: fakeClock(0), times: WORLD });
  const options = (over: Partial<DispatcherOptions>): DispatcherOptions => ({
    rules: RULES,
    times: TIMES,
    settings: SETTINGS,
    ...ports(),
    now: () => 0,
    suffix: countingSuffix(),
    stopped: () => false,
    ...over,
  });

  it("refuses rules, times and settings that are not valid, with the problems in the message", () => {
    expect(() => createDispatcher(options({ rules: { ...RULES, repositories: [REPO, "Octo/App"] } }))).toThrow(
      new RangeError('The trust rules of the dispatcher are not valid. The entry 1 of repositories is in the list two times: "Octo/App".'),
    );
    expect(() => createDispatcher(options({ rules: { ...RULES, events: ["workflow_run"] } }))).toThrow(
      new RangeError('The trust rules of the dispatcher are not valid. The event "workflow_run" is in the list of the events, but the policy refuses it for each run.'),
    );
    expect(() => createDispatcher(options({ times: { ...TIMES, pass: 0 } }))).toThrow(
      new RangeError("The times of a machine are not valid. The function parseMachineTimes gives the problems."),
    );
    expect(() => createDispatcher(options({ settings: { ...SETTINGS, standard: "huge" } }))).toThrow(
      new RangeError('The settings of the dispatcher are not valid. The field standard is not a size of the list sizes: "huge".'),
    );
  });

  it("starts with the empty memory", () => {
    expect(createDispatcher(options({})).state()).toEqual({ lives: [], failures: [] });
  });
});

describe("a dispatcher on a fake world: one job", () => {
  it("makes one machine for a job, sees each step of its life, and destroys it after the job", async () => {
    const at = stage();
    at.world.addRun(runRecord(), [own(4000)]);

    const first = await at.turn();
    expect(first).toEqual({
      at: 0,
      read: 0,
      listed: true,
      viewed: [REPO],
      jobs: [{ repository: REPO, runId: 100, runAttempt: 1, jobId: 1, status: "queued", runner: null }],
      asked: [{ machine: M0, at: 0 }],
      stopped: false,
      steps: [],
      adopted: [],
      destroys: [],
      removals: [],
      made: [{ name: M0, size: "small", repository: REPO, runId: 100, runAttempt: 1 }],
      waits: [],
      failures: [],
      lives: [{ machine: { name: M0, size: "small", repository: REPO, runId: 100, runAttempt: 1 }, life: { state: "asked", at: 0, fired: 0 } }],
      cut: false,
    });
    expect(at.world.runners()).toEqual([{ runnerId: 2, name: M0, scope: REPO, labels: ["run-100-1", "small"], online: true, busy: true }]);

    const second = await at.turn();
    expect(second.steps.map((step) => [step.transition, step.at])).toEqual([
      ["made", 5000],
      ["registered", 5000],
      ["started", 5000],
    ]);
    expect(second.made).toEqual([]);

    const third = await at.turn();
    expect(third.steps.map((step) => [step.transition, step.at])).toEqual([["completed", 10_000]]);
    expect(third.destroys).toEqual([M0]);
    expect(at.world.machines()).toEqual([]);

    const fourth = await at.turn();
    expect(fourth.steps.map((step) => [step.transition, step.at])).toEqual([["destroyed", 15_000]]);
    expect(fourth.lives).toEqual([]);

    expect(at.world.jobs()).toEqual([
      { repository: REPO, jobId: 1, runId: 100, runAttempt: 1, labels: ["run-100-1"], status: "completed", runner: M0, ran: true, result: "success", refusals: [] },
    ]);
    expect(at.world.events().map((event) => [event.at, event.kind])).toEqual([
      [0, "registered"],
      [0, "asked"],
      [2000, "operating"],
      [3000, "online"],
      [3000, "job-started"],
      [7000, "job-ended"],
      [10_000, "destroy-asked"],
      [10_500, "gone"],
    ]);
    expect(at.world.runners()).toEqual([]);
    expect(at.world.peak()).toBe(1);
    expectReplay(at);
    expectNoSecret(at);
  });

  it("gives the machine the trust rules and the run for the check on the machine, and the labels of the size", async () => {
    const at = stage();
    const requests: unknown[] = [];
    const { provider } = at.world;
    const spy: MachineProvider = { ...provider, make: (request, signal) => (requests.push(request), provider.make(request, signal)) };
    const dispatcher = createDispatcher({ rules: RULES, times: TIMES, settings: SETTINGS, source: at.world.source, provider: spy, now: () => 0, suffix: countingSuffix(5), stopped: () => false });
    at.world.addRun(runRecord(), [{ labels: ["large", "run-100-1"], duration: 0 }]);
    await dispatcher.pass(at.signal);
    const machine = { name: "rd-100-1-00000005", size: "large", repository: REPO, runId: 100, runAttempt: 1 };
    expect(requests).toEqual([{ machine, configuration: at.world.secrets()[0], check: { rules: RULES, run: { repository: REPO, runId: 100, runAttempt: 1 } } }]);
    expect(at.world.runners().map((runner) => runner.labels)).toEqual([["run-100-1", "large"]]);
  });

  it("makes a machine for each job of a run, and no machine after the last job", async () => {
    const at = stage();
    at.world.addRun(runRecord(), [own(1000), own(9000), own(3000)]);
    await at.until(60_000);
    expect(at.world.jobs().map((job) => [job.runner, job.result])).toEqual([
      [M0, "success"],
      [M1, "success"],
      ["rd-100-1-00000002", "success"],
    ]);
    expect(at.world.events().filter((event) => event.kind === "asked")).toHaveLength(3);
    expect(at.world.machines()).toEqual([]);
    expect(at.world.runners()).toEqual([]);
    expect(at.reports.at(-1)?.report.lives).toEqual([]);
    expectReplay(at);
  });

  it("makes one more machine when a runner of a different size takes a job that names only the run label", async () => {
    const at = stage();
    at.world.addRun(runRecord(), [own(1000), own(9000), { labels: ["run-100-1", "large"], duration: 3000 }]);
    await at.until(60_000);
    expect(at.reports.flatMap(({ report }) => report.made.map((machine) => [machine.name, machine.size]))).toEqual([
      [M0, "small"],
      [M1, "large"],
      ["rd-100-1-00000002", "small"],
      ["rd-100-1-00000003", "large"],
    ]);
    // The runner of the size large has the run label. Thus it took the second job, and the third job got a new machine.
    expect(at.world.jobs().map((job) => [job.runner, job.result])).toEqual([
      [M0, "success"],
      [M1, "success"],
      ["rd-100-1-00000003", "success"],
    ]);
    // The second machine of the size small got no job. It ends when the run has no more job.
    expect(at.path("rd-100-1-00000002")).toEqual(["made", "registered", "no-job", "destroyed"]);
    expect(at.world.machines()).toEqual([]);
    expect(at.world.runners()).toEqual([]);
    expect(at.world.peak()).toBe(3);
    expectReplay(at);
  });
});

describe("a dispatcher on a fake world: trust", () => {
  it("makes no machine for a run that the policy does not trust", async () => {
    const at = stage();
    at.world.addRun(runRecord(200, FORK), [own(1000, 200)]);
    at.world.addRun(runRecord(201, { actor: "evil" }), [own(1000, 201)]);
    at.world.addRun(runRecord(202, { event: "workflow_dispatch" }), [own(1000, 202)]);
    at.world.addRun(runRecord(203, { triggeringActor: "evil" }), [own(1000, 203)]);
    const report = await at.turn();
    expect(report.made).toEqual([]);
    expect(report.waits.map((wait) => [wait.run.runId, wait.jobs, wait.reason])).toEqual([
      [200, 1, "trust"],
      [201, 1, "trust"],
      [202, 1, "trust"],
      [203, 1, "trust"],
    ]);
    await at.until(120_000);
    expect(at.world.events()).toEqual([]);
    expect(at.world.jobs().every((job) => job.status === "queued" && !job.ran)).toBe(true);
  });

  it("starts no step of a job that took the label of a trusted run, and then does the job of the trusted run", async () => {
    const at = stage();
    // The run of the fork comes first. Thus its job gets the runner of the trusted run.
    const [stolen] = at.world.addRun(runRecord(200, FORK), [{ labels: ["run-100-1"], duration: 1000 }]);
    const [real] = at.world.addRun(runRecord(100), [own(4000)]);
    await at.until(40_000);
    const jobs = new Map(at.world.jobs().map((job) => [job.jobId, job]));
    expect(jobs.get(stolen ?? 0)).toMatchObject({ runner: M0, ran: false, result: "refused", status: "completed" });
    expect(jobs.get(stolen ?? 0)?.refusals.map((refusal) => refusal.rule)).toEqual(["head-repository", "actor", "triggering-actor", "machine"]);
    expect(jobs.get(real ?? 0)).toMatchObject({ runner: M1, ran: true, result: "success" });
    // The source removed the registration of the runner after its one job. Thus the dispatcher ends the machine at once.
    expect(at.path(M0)).toEqual(["made", "no-job", "destroyed"]);
    expect(at.reports[1]?.report.made.map((machine) => machine.name)).toEqual([M1]);
    expect(kinds(at, M0)).toEqual(["registered", "asked", "operating", "online", "job-refused", "destroy-asked", "gone"]);
    expect(at.world.machines()).toEqual([]);
    expect(at.world.runners()).toEqual([]);
    expectReplay(at);
  });

  it("stops the machine of a run when the rules of a new start do not trust the run", async () => {
    const at = stage();
    at.world.addRun(runRecord(), [own(60_000)]);
    await at.until(10_000);
    expect(at.world.jobs()[0]?.status).toBe("in_progress");
    at.restart({ rules: { ...RULES, actors: ["someone"] } });
    const report = await at.turn();
    expect(report.adopted).toEqual([M0]);
    expect(report.steps.map((step) => step.transition)).toEqual(["made", "registered", "started", "stopped"]);
    expect(report.destroys).toEqual([M0]);
    await at.until(30_000);
    expect(at.world.jobs()[0]?.result).toBe("lost");
    expect(at.world.machines()).toEqual([]);
    expect(at.world.runners()).toEqual([]);
  });

  it("stops the machine of a repository that the rules of a new start do not serve", async () => {
    const at = stage();
    at.world.addRun(runRecord(), [own(60_000)]);
    await at.until(10_000);
    at.restart({ rules: { ...RULES, repositories: ["octo/other"] } });
    const report = await at.turn();
    expect(report.steps.map((step) => step.transition)).toEqual(["made", "stopped"]);
    expect(report.destroys).toEqual([M0]);
    await at.turn();
    expect(at.world.machines()).toEqual([]);
  });
});

describe("a dispatcher on a fake world: a new start", () => {
  it("finds the machine of a job in progress, and makes no second machine", async () => {
    const at = stage();
    at.world.addRun(runRecord(), [own(30_000)]);
    await at.until(10_000);
    at.restart();
    const report = await at.turn();
    expect(report.adopted).toEqual([M0]);
    expect(report.steps.map((step) => step.transition)).toEqual(["made", "registered", "started"]);
    expect(report.made).toEqual([]);
    await at.until(60_000);
    expect(at.world.jobs()[0]).toMatchObject({ runner: M0, ran: true, result: "success" });
    expect(at.world.events().filter((event) => event.kind === "asked")).toHaveLength(1);
    expect(at.world.machines()).toEqual([]);
    expectReplay(at);
  });

  it("finds a machine that the provider makes, and counts it for the queued job", async () => {
    const at = stage();
    at.world.addRun(runRecord(), [own(1000)]);
    await at.turn(1000);
    at.restart();
    const report = await at.turn(1000);
    expect(report.adopted).toEqual([M0]);
    expect(report.steps).toEqual([]);
    expect(report.made).toEqual([]);
    expect(report.lives).toEqual([{ machine: { name: M0, size: "small", repository: REPO, runId: 100, runAttempt: 1 }, life: { state: "asked", at: 1000, fired: 0 } }]);
    await at.until(30_000);
    expect(at.world.jobs()[0]?.result).toBe("success");
  });

  it("destroys a machine whose run ended while no dispatcher operated", async () => {
    const at = stage();
    at.world.addRun(runRecord(), [own(1000)]);
    await at.turn(1000);
    at.world.cancelRun(runRecord());
    await at.clock.advance(60_000);
    expect(at.world.machines()).toHaveLength(1);
    at.restart();
    const report = await at.turn();
    expect(report.steps.map((step) => step.transition)).toEqual(["made", "registered", "no-job"]);
    expect(report.destroys).toEqual([M0]);
    expect(report.removals).toEqual([{ repository: REPO, runnerId: 2, name: M0 }]);
    await at.turn();
    expect(at.world.machines()).toEqual([]);
    expect(at.world.runners()).toEqual([]);
  });

  it("removes a registration that has no machine", async () => {
    const at = stage();
    at.world.addRun(runRecord(), [own(1000)]);
    // The provider refuses each request. The answer of the registration is lost, thus the dispatcher has no record of it.
    at.fault = (request) => (request === "register" ? "lose" : null);
    const first = await at.turn();
    expect(first.failures.map((failure) => [failure.request, failure.target])).toEqual([["register", M0]]);
    expect(first.made).toEqual([]);
    expect(at.world.runners().map((runner) => runner.name)).toEqual([M0]);
    at.fault = () => null;
    const second = await at.turn();
    expect(second.removals).toEqual([{ repository: REPO, runnerId: 2, name: M0 }]);
    expect(second.made.map((machine) => machine.name)).toEqual([M1]);
    await at.until(30_000);
    expect(at.world.jobs()[0]).toMatchObject({ runner: M1, result: "success" });
    expect(at.world.runners()).toEqual([]);
  });
});

describe("a dispatcher on a fake world: the stop switch", () => {
  it("makes no machine and destroys each machine in one pass", async () => {
    const at = stage();
    at.world.addRun(runRecord(100), [own(60_000)]);
    await at.until(10_000);
    at.world.addRun(runRecord(101), [own(1000, 101), own(1000, 101)]);
    await at.turn(1000);
    expect(at.world.machines().map((machine) => machine.status)).toEqual(["operating", "making", "making"]);

    at.stop = true;
    const report = await at.turn(1000);
    expect(report.stopped).toBe(true);
    expect(report.steps.map((step) => [step.machine, step.transition])).toEqual([
      [M0, "stopped"],
      ["rd-101-1-00000001", "stopped"],
      ["rd-101-1-00000002", "stopped"],
    ]);
    expect([...report.destroys].sort()).toEqual([M0, "rd-101-1-00000001", "rd-101-1-00000002"]);
    expect(report.made).toEqual([]);
    expect(at.world.machines()).toEqual([]);
    expect(at.world.jobs()[0]?.result).toBe("lost");

    at.world.addRun(runRecord(102), [own(1000, 102)]);
    const next = await at.turn();
    expect(next.made).toEqual([]);
    expect(next.waits.map((wait) => [wait.run.runId, wait.jobs, wait.reason])).toEqual([
      [101, 2, "stop"],
      [102, 1, "stop"],
    ]);
    expect(next.lives).toEqual([]);
    await at.until(120_000);
    expect(at.world.events().filter((event) => event.kind === "asked" && event.at >= 11_000)).toEqual([]);
    expect(at.world.runners()).toEqual([]);

    at.stop = false;
    await at.until(180_000);
    expect(at.world.jobs().slice(1).map((job) => job.result)).toEqual(["success", "success", "success"]);
    expectReplay(at);
  });

  it("destroys a machine that it finds at a new start with the switch on", async () => {
    const at = stage();
    at.world.addRun(runRecord(), [own(60_000)]);
    await at.until(10_000);
    at.stop = true;
    at.restart();
    const report = await at.turn();
    expect(report.adopted).toEqual([M0]);
    expect(report.steps.map((step) => step.transition)).toEqual(["made", "registered", "started", "stopped"]);
    expect(report.destroys).toEqual([M0]);
    expect(at.world.machines()).toEqual([]);
  });

  it("makes no machine, and keeps each machine, when it cannot read the switch", async () => {
    const at = stage();
    at.world.addRun(runRecord(100), [own(60_000)]);
    await at.until(10_000);
    at.world.addRun(runRecord(101), [own(1000, 101)]);
    at.stop = null;
    const report = await at.turn();
    expect(report.stopped).toBeNull();
    expect(report.failures).toEqual([{ request: "stop-switch", target: "", text: '"The switch is not readable."' }]);
    expect(report.made).toEqual([]);
    expect(report.destroys).toEqual([]);
    expect(report.waits.map((wait) => [wait.run.runId, wait.reason])).toEqual([[101, "stop"]]);
    expect(at.world.machines().map((machine) => machine.status)).toEqual(["operating"]);
  });

  it("reads a switch that gives a promise, and refuses a value that is not true or false", async () => {
    const world = fakeWorld({ clock: fakeClock(0), times: WORLD });
    world.addRun(runRecord(), [own()]);
    const signal = new AbortController().signal;
    const base = { rules: RULES, times: TIMES, settings: SETTINGS, source: world.source, provider: world.provider, now: () => 0, suffix: countingSuffix() };
    const on = await createDispatcher({ ...base, stopped: () => Promise.resolve(true) }).pass(signal);
    expect([on.stopped, on.made.length]).toEqual([true, 0]);
    const odd = await createDispatcher({ ...base, stopped: () => "no" as unknown as boolean }).pass(signal);
    expect(odd.stopped).toBeNull();
    expect(odd.failures).toEqual([{ request: "stop-switch", target: "", text: '"The stop switch gave a value that is not true or false."' }]);
    expect(odd.made).toEqual([]);
    const off = await createDispatcher({ ...base, stopped: () => Promise.resolve(false) }).pass(signal);
    expect([off.stopped, off.made.length]).toEqual([false, 1]);
  });
});

describe("a dispatcher on a fake world: requests that fail", () => {
  it("makes no decision for a repository whose view failed, and tells the failure", async () => {
    const at = stage();
    at.world.addRun(runRecord(), [own(60_000)]);
    await at.until(10_000);
    at.world.addRun(runRecord(101), [own(1000, 101)]);
    at.fault = (request) => (request === "view" ? "refuse" : null);
    const report = await at.turn();
    expect(report.failures).toEqual([{ request: "view", target: REPO, text: '"The fake world refused the request view."' }]);
    expect([report.steps, report.made, report.destroys, report.removals, report.waits]).toEqual([[], [], [], [], []]);
    expect(report.lives.map((each) => each.life.state)).toEqual(["busy"]);
  });

  it("makes no machine, and takes no machine as destroyed, when the list of the provider failed", async () => {
    const at = stage();
    at.world.addRun(runRecord(), [own(60_000)]);
    await at.until(10_000);
    at.world.addRun(runRecord(101), [own(1000, 101)]);
    at.fault = (request) => (request === "machines" ? "refuse" : null);
    const report = await at.turn();
    expect(report.failures).toEqual([{ request: "machines", target: "", text: '"The fake world refused the request machines."' }]);
    expect([report.steps, report.made, report.destroys]).toEqual([[], [], []]);
    expect(report.waits.map((wait) => [wait.run.runId, wait.reason])).toEqual([[101, "provider"]]);
  });

  it("waits longer after each machine of a run that the provider does not make, and starts again after a job", async () => {
    const at = stage();
    at.world.addRun(runRecord(), [own(1000), own(1000)]);
    at.fault = (request) => (request === "make" ? "refuse" : null);
    const asked: number[] = [];
    const held: number[] = [];
    while (at.clock.now() <= 60_000) {
      const report = await at.turn(1000);
      if (report.failures.some((failure) => failure.request === "make")) asked.push(report.at);
      if (report.waits.some((wait) => wait.reason === "backoff")) held.push(report.at);
    }
    // Two jobs give two requests in a pass. Each request that fails adds to the count of the run: 2, 4, then the longest wait.
    expect(asked).toEqual([0, 10_000, 50_000]);
    expect(held).toHaveLength(61 - 3);
    expect(at.reports[0]?.report.steps.map((step) => [step.transition, step.from])).toEqual([
      ["failed", "asked"],
      ["failed", "asked"],
    ]);
    expect(at.reports[0]?.report.destroys).toHaveLength(2);
    expect(at.world.machines()).toEqual([]);
    expect(at.world.runners()).toEqual([]);

    at.fault = () => null;
    await at.until(120_000, 1000);
    expect(at.world.jobs().map((job) => job.result)).toEqual(["success", "success"]);
    expect(at.failures()).toEqual([]);
    expectReplay(at);
    expectNoSecret(at);
  });

  it("does not write the one-job configuration of a failed request to the report", async () => {
    const at = stage();
    const { provider } = at.world;
    const loud: MachineProvider = { ...provider, make: (request) => Promise.reject(new Error(`cloud-init failed with ${request.configuration} in the user data`)) };
    const dispatcher = createDispatcher({ rules: RULES, times: TIMES, settings: SETTINGS, source: at.world.source, provider: loud, now: () => 0, suffix: countingSuffix(), stopped: () => false });
    at.world.addRun(runRecord(), [own()]);
    const report = await dispatcher.pass(at.signal);
    expect(report.failures).toEqual([{ request: "make", target: M0, text: '"cloud-init failed with [configuration] in the user data"' }]);
    expect(at.world.secrets()).toHaveLength(1);
    expect(JSON.stringify(report).includes(at.world.secrets()[0] ?? "none")).toBe(false);
    expect(JSON.stringify(dispatcher.state()).includes(at.world.secrets()[0] ?? "none")).toBe(false);
  });

  it("tells a failure that is not an error with a fixed text", async () => {
    const at = stage();
    const { provider } = at.world;
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const odd: MachineProvider = { ...provider, machines: () => Promise.reject({ secret: "value" }) };
    const dispatcher = createDispatcher({ rules: RULES, times: TIMES, settings: SETTINGS, source: at.world.source, provider: odd, now: () => 0, suffix: countingSuffix(), stopped: () => false });
    const report = await dispatcher.pass(at.signal);
    expect(report.failures).toEqual([{ request: "machines", target: "", text: "The request failed with a value that is not an error." }]);
  });

  it("asks the provider again to destroy a machine, with longer waits, until the machine is not there", async () => {
    const at = stage();
    at.world.addRun(runRecord(), [own(1000)]);
    at.fault = (request) => (request === "destroy" ? "refuse" : null);
    await at.until(60_000, 1000);
    expect(at.world.jobs()[0]?.result).toBe("success");
    // The job ends at 4000. The waits are 5, 10 and 20 seconds, and the next wait is 40 seconds.
    const asked = at.reports.filter(({ report }) => report.destroys.length > 0).map(({ report }) => report.at);
    expect(asked).toEqual([4000, 9000, 19_000, 39_000]);
    expect(at.reports.flatMap(({ report }) => report.failures)).toEqual(Array(4).fill({ request: "destroy", target: M0, text: '"The fake world refused the request destroy."' }));
    expect(at.path(M0)).toEqual(["made", "registered", "started", "completed", "destroy-again", "destroy-again", "destroy-again"]);
    expect(at.world.machines()).toHaveLength(1);
    at.fault = () => null;
    await at.until(90_000, 1000);
    expect(at.reports.filter(({ report }) => report.destroys.length > 0).map(({ report }) => report.at)).toEqual([4000, 9000, 19_000, 39_000, 79_000]);
    expect(at.path(M0).slice(-2)).toEqual(["destroy-again", "destroyed"]);
    expect(at.world.machines()).toEqual([]);
  });

  it("destroys a machine that stopped, and makes a new machine for the job after the wait", async () => {
    const at = stage();
    at.world.addRun(runRecord(), [own(1000)]);
    await at.turn(2500);
    at.world.halt(M0);
    const report = await at.turn(2500);
    expect(report.steps.map((step) => step.transition)).toEqual(["failed"]);
    expect(report.destroys).toEqual([M0]);
    expect(report.removals).toEqual([{ repository: REPO, runnerId: 2, name: M0 }]);
    expect(report.waits.map((wait) => wait.reason)).toEqual(["backoff"]);
    await at.until(40_000);
    expect(at.world.jobs()[0]).toMatchObject({ runner: M1, result: "success" });
  });

  it("sees a machine that the provider lost, with a job and with no job", async () => {
    const at = stage();
    at.world.addRun(runRecord(), [own(60_000)]);
    await at.until(10_000);
    at.world.lose(M0);
    // The source tells that the job ended. Thus the dispatcher sees the end of the job, then that the machine is not there.
    const busy = await at.turn();
    expect(busy.steps.map((step) => [step.transition, step.from, step.to])).toEqual([["completed", "busy", "done"]]);
    expect(busy.removals).toEqual([{ repository: REPO, runnerId: 2, name: M0 }]);
    const after = await at.turn();
    expect(after.steps.map((step) => [step.transition, step.from, step.to])).toEqual([["destroyed", "done", "destroyed"]]);
    expect(after.lives).toEqual([]);
    expect(at.world.jobs()[0]?.result).toBe("lost");
    expect(at.world.runners()).toEqual([]);
    expect(at.failures()).toEqual([]);

    at.world.addRun(runRecord(101), [own(60_000, 101)]);
    await at.turn(2500);
    await at.turn(100);
    at.world.lose("rd-101-1-00000001");
    const idle = await at.turn(1000);
    expect(idle.steps.map((step) => [step.transition, step.from, step.to])).toEqual([["lost", "made", "destroyed"]]);
    expect(idle.removals.map((removal) => removal.name)).toEqual(["rd-101-1-00000001"]);
    expect(idle.waits.map((wait) => wait.reason)).toEqual(["backoff"]);
    expect(at.failures()).toEqual([{ run: { repository: REPO, runId: 101, runAttempt: 1 }, count: 1, at: at.reports.at(-1)?.report.at }]);
  });

  it("destroys the machine of a run that was cancelled", async () => {
    const at = stage();
    at.world.addRun(runRecord(), [own(60_000), own(60_000)]);
    await at.turn(1000);
    at.world.cancelRun(runRecord());
    const report = await at.turn();
    expect(report.steps.map((step) => step.transition)).toEqual(["no-job", "no-job"]);
    expect(report.removals.map((removal) => removal.name)).toEqual([M0, M1]);
    await at.turn();
    expect(at.world.machines()).toEqual([]);
    expect(at.world.runners()).toEqual([]);
    expect(at.world.jobs().map((job) => [job.ran, job.result])).toEqual([
      [false, "cancelled"],
      [false, "cancelled"],
    ]);
  });

  it("refuses a name that a machine has, and makes no second machine with it", async () => {
    const world = fakeWorld({ clock: fakeClock(0), times: WORLD });
    world.addRun(runRecord(), [own(), own()]);
    const dispatcher = createDispatcher({ rules: RULES, times: TIMES, settings: SETTINGS, source: world.source, provider: world.provider, now: () => 0, suffix: () => "0000beef", stopped: () => false });
    const report = await dispatcher.pass(new AbortController().signal);
    expect(report.made.map((machine) => machine.name)).toEqual(["rd-100-1-0000beef"]);
    expect(report.failures).toEqual([{ request: "register", target: "run-100-1", text: '"The suffix function gave the name of a machine that is there."' }]);
    expect(world.machines()).toHaveLength(1);
    // The name is in the memory of the dispatcher. Thus the next pass refuses it before a request to the source.
    const again = await dispatcher.pass(new AbortController().signal);
    expect([again.made, again.failures]).toEqual([[], report.failures]);
    const bad = createDispatcher({ rules: RULES, times: TIMES, settings: SETTINGS, source: world.source, provider: world.provider, now: () => 0, suffix: () => "BEEF", stopped: () => false });
    const next = await bad.pass(new AbortController().signal);
    expect(next.failures.map((failure) => [failure.request, failure.target, failure.text])).toEqual([["register", "run-100-1", '"The suffix of a machine name is not 8 digits of base 16 in small letters."']]);
  });
});

describe("a dispatcher on a fake world: the signal and the capacity", () => {
  it("starts no request of the plan after the signal stops the pass", async () => {
    const at = stage();
    at.world.addRun(runRecord(), [own()]);
    const controller = new AbortController();
    const { source } = at.world;
    const slow: JobSource = { ...source, view: async (...request) => source.view(...request).finally(() => controller.abort()) };
    const dispatcher = createDispatcher({ rules: RULES, times: TIMES, settings: SETTINGS, source: slow, provider: at.world.provider, now: () => 0, suffix: countingSuffix(), stopped: () => false });
    const report = await dispatcher.pass(controller.signal);
    expect(report.cut).toBe(true);
    expect([report.made, report.failures]).toEqual([[], []]);
    expect(at.world.events()).toEqual([]);
    const whole = await dispatcher.pass(new AbortController().signal);
    expect([whole.cut, whole.made.length]).toEqual([false, 1]);
  });

  it("leaves a registration with no machine when the signal stops a request for a machine, and removes it in the next pass", async () => {
    const at = stage();
    at.world.addRun(runRecord(), [own()]);
    const controller = new AbortController();
    const { source } = at.world;
    const slow: JobSource = { ...source, register: async (...request) => source.register(...request).finally(() => controller.abort()) };
    const dispatcher = createDispatcher({ rules: RULES, times: TIMES, settings: SETTINGS, source: slow, provider: at.world.provider, now: () => 0, suffix: countingSuffix(), stopped: () => false });
    const report = await dispatcher.pass(controller.signal);
    expect([report.cut, report.made, report.lives]).toEqual([true, [], []]);
    expect(at.world.runners().map((runner) => runner.name)).toEqual([M0]);
    expect(at.world.machines()).toEqual([]);
    const next = await dispatcher.pass(new AbortController().signal);
    expect(next.removals.map((removal) => removal.name)).toEqual([M0]);
    expect(next.made.map((machine) => machine.name)).toEqual([M1]);
  });

  it("does not start a pass before the pass before it ends", async () => {
    const at = stage();
    const dispatcher = createDispatcher({ rules: RULES, times: TIMES, settings: SETTINGS, source: at.world.source, provider: at.world.provider, now: () => 0, suffix: countingSuffix(), stopped: () => false });
    const first = dispatcher.pass(at.signal);
    await expect(dispatcher.pass(at.signal)).rejects.toThrow(new Error("The pass before this pass did not end."));
    expect((await first).cut).toBe(false);
    expect((await dispatcher.pass(at.signal)).cut).toBe(false);
  });

  it("has no more machines than its capacity, and gives the machines to the runs in turn", async () => {
    const at = stage();
    at.world.addRun(runRecord(101), [own(20_000, 101), own(20_000, 101), own(20_000, 101)]);
    at.world.addRun(runRecord(100), [own(20_000), own(20_000), own(20_000)]);
    const report = await at.turn();
    expect(report.made.map((machine) => machine.runId)).toEqual([100, 101, 100]);
    expect(report.waits.map((wait) => [wait.run.runId, wait.jobs, wait.reason])).toEqual([
      [100, 1, "capacity"],
      [101, 2, "capacity"],
    ]);
    await at.until(200_000);
    expect(at.world.jobs().map((job) => job.result)).toEqual(Array(6).fill("success"));
    expect(at.world.peak()).toBe(3);
    expect(at.world.machines()).toEqual([]);
    expectReplay(at);
  });

  it("serves two repositories, and a view that fails holds only its repository", async () => {
    const rules: TrustRules = { ...RULES, repositories: [REPO, "octo/lib"] };
    const at = stage({ rules });
    at.world.addRun(runRecord(100), [own(1000)]);
    at.world.addRun(runRecord(300, { repository: "octo/lib", headRepository: "octo/lib" }), [own(1000, 300)]);
    at.fault = (request, target) => (request === "view" && target === REPO ? "refuse" : null);
    const report = await at.turn();
    expect(report.made.map((machine) => [machine.repository, machine.runId])).toEqual([["octo/lib", 300]]);
    expect(report.failures.map((failure) => [failure.request, failure.target])).toEqual([["view", REPO]]);
    at.fault = () => null;
    await at.until(40_000);
    expect(at.world.jobs().map((job) => job.result)).toEqual(["success", "success"]);
    expect(at.world.machines()).toEqual([]);
  });
});

describe("a dispatcher on a fake world: the requests of a pass", () => {
  const LIB = "octo/lib";
  const BOTH: TrustRules = { ...RULES, repositories: [REPO, LIB] };
  const base = { rules: RULES, times: TIMES, settings: SETTINGS, stopped: () => false };

  it("names to the source the run of each machine of its repository, one time", async () => {
    const clock = fakeClock(0);
    let fault: WorldRequest | null = null;
    const world = fakeWorld({ clock, times: WORLD, faults: (request) => (request === fault ? "refuse" : null) });
    const asked: (readonly [string, readonly RunKey[]])[] = [];
    const source: JobSource = {
      ...world.source,
      view: (repository, runs, signal) => {
        asked.push([repository, [...runs]]);
        return world.source.view(repository, runs, signal);
      },
    };
    const suffix = countingSuffix();
    const start = (): Dispatcher => createDispatcher({ ...base, rules: BOTH, source, provider: world.provider, now: () => clock.now(), suffix });
    const signal = new AbortController().signal;
    const app: RunKey = { repository: REPO, runId: 100, runAttempt: 1 };
    const lib: RunKey = { repository: LIB, runId: 300, runAttempt: 1 };
    world.addRun(runRecord(100), [own(60_000), own(60_000)]);
    world.addRun(runRecord(300, { repository: LIB, headRepository: LIB }), [own(60_000, 300)]);

    // The memory is empty, and the provider has no machine.
    const first = start();
    expect((await first.pass(signal)).made).toHaveLength(3);
    expect(asked.splice(0)).toEqual([
      [REPO, []],
      [LIB, []],
    ]);
    // The memory and the provider have the three machines. Two machines have one run.
    const each = [
      [REPO, [app]],
      [LIB, [lib]],
    ];
    await first.pass(signal);
    expect(asked.splice(0)).toEqual(each);
    // The provider gives no list. Thus the runs come from the memory.
    fault = "machines";
    await first.pass(signal);
    expect(asked.splice(0)).toEqual(each);
    // A dispatcher that starts again has an empty memory. Thus the runs come from the list of the provider.
    fault = null;
    expect((await start().pass(signal)).adopted).toHaveLength(3);
    expect(asked.splice(0)).toEqual(each);
  });

  it("gives the signal of the pass to the stop switch", async () => {
    const world = fakeWorld({ clock: fakeClock(0), times: WORLD });
    const got: unknown[] = [];
    const dispatcher = createDispatcher<AbortSignal>({
      ...base,
      source: world.source,
      provider: world.provider,
      now: () => 0,
      suffix: countingSuffix(),
      stopped: (signal) => {
        got.push(signal);
        return false;
      },
    });
    const signal = new AbortController().signal;
    await dispatcher.pass(signal);
    expect(got).toHaveLength(1);
    expect(got[0]).toBe(signal);
  });

  it("starts the life of a machine at the time of the request for the machine, not at the time of the pass", async () => {
    const world = fakeWorld({ clock: fakeClock(0), times: WORLD });
    world.addRun(runRecord(), [own()]);
    let now = 1000;
    const { source } = world;
    // The registration of the runner uses 700 ms. The timer of the machine starts after it.
    const slow: JobSource = {
      ...source,
      register: (...request) => {
        now += 700;
        return source.register(...request);
      },
    };
    const dispatcher = createDispatcher({ ...base, source: slow, provider: world.provider, now: () => now, suffix: countingSuffix() });
    const report = await dispatcher.pass(new AbortController().signal);
    expect(report.at).toBe(1000);
    expect(report.lives.map((each) => [each.machine.name, each.life.state, each.life.at])).toEqual([[M0, "asked", 1700]]);
  });

  /** This function makes a stage with a machine that stopped, its registration, and a queued job of a second run. */
  const halted = async (): Promise<Stage> => {
    const at = stage();
    at.world.addRun(runRecord(), [own(1000)]);
    await at.turn(2500);
    at.world.halt(M0);
    at.world.addRun(runRecord(101), [own(1000, 101)]);
    return at;
  };

  it("removes the registrations and destroys the machines, then it asks for the machines", async () => {
    const at = await halted();
    const calls: string[] = [];
    const watch = async <Result>(name: string, request: () => Promise<Result>): Promise<Result> => {
      calls.push(`${name} starts`);
      try {
        return await request();
      } finally {
        calls.push(`${name} ends`);
      }
    };
    const { source, provider } = at.world;
    const watchedSource: JobSource = {
      ...source,
      register: (...request) => watch("register", () => source.register(...request)),
      remove: (...request) => watch("remove", () => source.remove(...request)),
    };
    const watchedProvider: MachineProvider = {
      ...provider,
      make: (...request) => watch("make", () => provider.make(...request)),
      destroy: (...request) => watch("destroy", () => provider.destroy(...request)),
    };
    const dispatcher = createDispatcher({ ...base, source: watchedSource, provider: watchedProvider, now: () => at.clock.now(), suffix: countingSuffix(1) });
    const report = await dispatcher.pass(at.signal);
    expect([report.removals.map((removal) => removal.name), report.destroys, report.made.map((machine) => machine.name)]).toEqual([[M0], [M0], ["rd-101-1-00000001"]]);
    // A removal starts before a destroy: a runner with no registration takes no job while the provider destroys its machine.
    expect(calls).toEqual(["remove starts", "destroy starts", "remove ends", "destroy ends", "register starts", "register ends", "make starts", "make ends"]);
  });

  it("starts no destroy and no removal after the signal stops the pass, and the next passes send them", async () => {
    const at = await halted();
    const controller = new AbortController();
    const { source } = at.world;
    const slow: JobSource = { ...source, view: async (...request) => source.view(...request).finally(() => controller.abort()) };
    const dispatcher = createDispatcher({ ...base, source: slow, provider: at.world.provider, now: () => at.clock.now(), suffix: countingSuffix(1) });
    const before = at.world.events().length;
    const report = await dispatcher.pass(controller.signal);
    expect([report.cut, report.destroys, report.removals, report.made, report.failures]).toEqual([true, [], [], [], []]);
    expect(at.world.events()).toHaveLength(before);
    // The life of the machine is in the state done. Thus the removal comes in the next pass, and the destroy comes at the timer.
    const next = await dispatcher.pass(at.signal);
    expect([next.cut, next.removals.map((removal) => removal.name), next.destroys]).toEqual([false, [M0], []]);
    await at.clock.advance(5000);
    const last = await dispatcher.pass(at.signal);
    expect(last.steps.filter((step) => step.machine === M0).map((step) => step.transition)).toEqual(["destroy-again"]);
    expect(last.destroys).toContain(M0);
  });

  it("tells a removal that failed, and sends it again in the next pass", async () => {
    const at = await halted();
    at.fault = (request) => (request === "remove" ? "refuse" : null);
    const report = await at.turn(1000);
    expect(report.removals).toEqual([{ repository: REPO, runnerId: 2, name: M0 }]);
    expect(report.failures).toEqual([{ request: "remove", target: M0, text: '"The fake world refused the request remove."' }]);
    at.fault = () => null;
    const next = await at.turn(1000);
    expect(next.removals).toEqual([{ repository: REPO, runnerId: 2, name: M0 }]);
    expect(next.failures).toEqual([]);
    expect(at.world.runners().map((runner) => runner.name)).not.toContain(M0);
  });
});

describe("a dispatcher on a fake world: each scenario", () => {
  type Kind = "trusted" | "fork" | "stranger" | "event" | "retry-by-stranger";
  const RECORD: Readonly<Record<Kind, Partial<RunRecord>>> = {
    trusted: {},
    fork: FORK,
    stranger: { actor: "evil", triggeringActor: "evil" },
    event: { event: "workflow_dispatch" },
    "retry-by-stranger": { triggeringActor: "evil" },
  };
  type Label = "own" | "own-large" | "own-gpu" | "stolen" | "none";
  const labelsOf = (label: Label, runId: number): string[] => {
    if (label === "own") return [`run-${runId}-1`];
    if (label === "own-large") return [`run-${runId}-1`, "large"];
    if (label === "own-gpu") return [`run-${runId}-1`, "gpu"];
    if (label === "stolen") return ["run-100-1"];
    return ["ubuntu-latest"];
  };
  /** This function tells if the dispatcher serves a job: its run is trusted, and it names the label of its run and no label that is not a size. */
  const servedOf = (run: Kind, job: Label, runId: number): boolean =>
    run === "trusted" && (job === "own" || job === "own-large" || (job === "stolen" && runId === 100));
  const kind = fc.constantFrom<Kind>("trusted", "trusted", "trusted", "fork", "stranger", "event", "retry-by-stranger");
  const label = fc.constantFrom<Label>("own", "own", "own", "own-large", "own-gpu", "stolen", "none");
  const scenario = fc.record({
    runs: fc.array(
      fc.record({
        at: fc.integer({ min: 0, max: 60 }).map((seconds) => seconds * 1000),
        kind,
        jobs: fc.array(fc.record({ label, duration: fc.integer({ min: 0, max: 20_000 }) }), { minLength: 1, maxLength: 3 }),
      }),
      { minLength: 1, maxLength: 5 },
    ),
    faults: fc.array(fc.constantFrom<WorldFault | null>(null, null, null, "refuse", "lose"), { maxLength: 80 }),
    restarts: fc.array(fc.integer({ min: 0, max: 90 }).map((seconds) => seconds * 1000), { maxLength: 2 }),
    capacity: fc.integer({ min: 1, max: 4 }),
    period: fc.constantFrom(1000, 5000, 10_000),
  });
  type Scenario = typeof scenario extends fc.Arbitrary<infer T> ? T : never;
  const LIMIT = 3_000_000;

  /** This function plays a scenario to the time that the world has no more work, and it gives the stage. */
  const play = async (given: Scenario, stopAt: number | null): Promise<{ at: Stage; calm: boolean; stopPass: number | null }> => {
    const at = stage({ settings: { ...SETTINGS, capacity: given.capacity } });
    let used = 0;
    at.fault = () => {
      used += 1;
      return given.faults[used - 1] ?? null;
    };
    const pending = given.runs.map((run, index) => ({ ...run, runId: 100 + index })).sort((a, b) => a.at - b.at);
    const restarts = [...given.restarts].sort((a, b) => a - b);
    const last = Math.max(...pending.map((run) => run.at), ...restarts, stopAt ?? 0);
    const serves: boolean[] = [];
    const served = (): boolean => at.world.jobs().every((job, index) => serves[index] !== true || job.status === "completed");
    let stopPass: number | null = null;
    let calm = false;
    while (at.clock.now() <= LIMIT) {
      const now = at.clock.now();
      while (pending[0] !== undefined && pending[0].at <= now) {
        const run = pending.shift();
        if (run === undefined) break;
        at.world.addRun(runRecord(run.runId, RECORD[run.kind]), run.jobs.map((job) => ({ labels: labelsOf(job.label, run.runId), duration: job.duration })));
        for (const job of run.jobs) serves.push(servedOf(run.kind, job.label, run.runId));
      }
      while (restarts[0] !== undefined && restarts[0] <= now) {
        restarts.shift();
        at.restart({ settings: { ...SETTINGS, capacity: given.capacity } });
      }
      if (stopAt !== null && now >= stopAt && at.stop === false) {
        at.stop = true;
        stopPass = now;
      }
      const report = await at.turn(given.period);
      const quiet = at.world.machines().length === 0 && at.world.runners().length === 0 && report.lives.length === 0;
      if (now >= last && used >= given.faults.length && quiet && (stopAt !== null || served())) {
        calm = true;
        break;
      }
    }
    return { at, calm, stopPass };
  };
  const trustedRuns = (given: Scenario): Set<number> => new Set(given.runs.flatMap((run, index) => (run.kind === "trusted" ? [100 + index] : [])));

  /** This function examines the rules that hold in each scenario, with faults or with no fault. */
  const expectSafe = (given: Scenario, at: Stage): void => {
    const trusted = trustedRuns(given);
    // No machine for a run that the policy does not trust.
    for (const event of at.world.events()) {
      if (event.kind !== "asked") continue;
      expect(trusted.has(parseMachineName("rd", event.name)?.runId ?? 0)).toBe(true);
    }
    for (const job of at.world.jobs()) {
      // No step of a job of a run that is not trusted starts, also with the label of a trusted run.
      if (!trusted.has(job.runId)) expect(job.ran).toBe(false);
      // A machine does only a job of its run.
      if (job.ran) expect(parseMachineName("rd", job.runner ?? "")?.runId).toBe(job.runId);
    }
    expect(at.world.peak()).toBeLessThanOrEqual(given.capacity);
    expectReplay(at);
    expectNoSecret(at);
    for (const { report } of at.reports) {
      expect(report.made.every((machine) => decide(RULES, runRecord(machine.runId, RECORD[given.runs[machine.runId - 100]?.kind ?? "fork"])).trusted)).toBe(true);
      expect(report.lives.length).toBeLessThanOrEqual(given.capacity);
    }
  };

  it("does each served job of a trusted run one time when no request fails, also after a new start", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (given) => {
        const { at, calm } = await play({ ...given, faults: [] }, null);
        expect(calm).toBe(true);
        expectSafe(given, at);
        const jobs = at.world.jobs();
        given.runs.forEach((run, index) => {
          const mine = jobs.filter((job) => job.runId === 100 + index);
          run.jobs.forEach((job, place) => {
            if (servedOf(run.kind, job.label, 100 + index)) expect(mine[place]).toMatchObject({ status: "completed", ran: true, result: "success" });
            else expect(mine[place]?.ran).toBe(false);
          });
        });
        // Each machine did one job at most.
        const starts = at.world.events().filter((event) => event.kind === "job-started" || event.kind === "job-refused");
        expect(new Set(starts.map((event) => event.name)).size).toBe(starts.length);
      }),
      { numRuns: 1000, seed: 20261110 },
    );
  }, 120_000);

  it("ends each served job and keeps no machine and no registration after the requests stop to fail", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (given) => {
        const { at, calm } = await play(given, null);
        expect(calm).toBe(true);
        expectSafe(given, at);
        const jobs = at.world.jobs();
        given.runs.forEach((run, index) => {
          const mine = jobs.filter((job) => job.runId === 100 + index);
          run.jobs.forEach((job, place) => {
            if (!servedOf(run.kind, job.label, 100 + index)) return;
            expect(mine[place]?.status).toBe("completed");
            expect(["success", "lost"]).toContain(mine[place]?.result);
          });
        });
        // No machine comes back: three more passes make nothing.
        const before = at.world.events().length;
        for (let pass = 0; pass < 3; pass += 1) await at.turn(given.period);
        expect(at.world.events()).toHaveLength(before);
      }),
      { numRuns: 2000, seed: 20261110 },
    );
  }, 240_000);

  it("makes no machine after the pass that reads the stop switch on, and keeps no machine", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, fc.integer({ min: 0, max: 80 }), async (given, seconds) => {
        const { at, calm, stopPass } = await play(given, seconds * 1000);
        expect(calm).toBe(true);
        expectSafe(given, at);
        expect(stopPass).not.toBeNull();
        expect(at.world.events().filter((event) => event.kind === "asked" && event.at >= (stopPass ?? 0))).toEqual([]);
        for (const { report } of at.reports) {
          if (report.at < (stopPass ?? 0)) continue;
          expect(report.stopped).toBe(true);
          expect(report.made).toEqual([]);
          expect(report.lives.every((each) => each.life.state === "done")).toBe(true);
        }
      }),
      { numRuns: 1000, seed: 20261110 },
    );
  }, 240_000);

  it("asks the provider in the stop pass to destroy each machine, when no request fails", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, fc.integer({ min: 0, max: 80 }), async (given, seconds) => {
        const { at, stopPass } = await play({ ...given, faults: [], restarts: [] }, seconds * 1000);
        const stop = at.reports.find(({ report }) => report.at === stopPass)?.report;
        const asked = new Set(at.world.events().filter((event) => event.kind === "destroy-asked" && event.at <= (stopPass ?? 0)).map((event) => event.name));
        const there = at.world.events().filter((event) => event.kind === "asked" && event.at <= (stopPass ?? 0)).map((event) => event.name);
        const gone = new Set(at.world.events().filter((event) => event.kind === "gone" && event.at <= (stopPass ?? 0)).map((event) => event.name));
        expect(stop?.stopped).toBe(true);
        for (const name of there) expect(asked.has(name) || gone.has(name)).toBe(true);
      }),
      { numRuns: 1000, seed: 20261110 },
    );
  }, 240_000);
});
