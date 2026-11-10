import { replay, type Transition } from "@mark1russell7/algebra/replay";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MACHINE_LIFECYCLE, MACHINE_STATES, type MachineEvent, type MachineState, type MachineTimes } from "./lifecycle.ts";
import {
  EMPTY_STATE,
  noteStep,
  plan,
  type DispatchConfig,
  type DispatchLife,
  type DispatchState,
  type LifeStep,
  type Observation,
  type Plan,
  type RunFailures,
} from "./plan.ts";
import { decide, type TrustRules } from "./policy.ts";
import type { JobStatus, MachineStatus, ProviderMachine, SourceJob, SourceRun, SourceRunner } from "./ports.ts";
import type { MachineRecord, RunKey, RunRecord } from "./records.ts";
import { parseMachineName, type DispatchSettings } from "./settings.ts";

const REPO = "octo/app";
const RULES: TrustRules = { repositories: [REPO], events: ["push"], actors: ["octo"] };
const TIMES: MachineTimes = { make: 60, register: 60, idle: 30, job: 600, retry: 5, retryMax: 40, pass: 10 };
const SETTINGS: DispatchSettings = { prefix: "rd", capacity: 4, sizes: ["small", "large"], standard: "small" };
const CONFIG: DispatchConfig = { rules: RULES, times: TIMES, settings: SETTINGS };
const KEY: RunKey = { repository: REPO, runId: 100, runAttempt: 1 };
/** This name is a second repository. It is after the name `REPO` in the sequence of the names. */
const OTHER = "octo/base";

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
const job = (status: JobStatus, over: Partial<SourceJob> = {}): SourceJob => {
  const runId = over.runId ?? 100;
  return { repository: REPO, jobId: 1, runId, runAttempt: 1, labels: [`run-${runId}-1`], status, runner: null, ...over };
};
const run = (jobs: readonly SourceJob[], runId = 100, over: Partial<RunRecord> = {}): SourceRun => ({ run: runRecord(runId, over), jobs });
const runner = (name: string, over: Partial<SourceRunner> = {}): SourceRunner => ({ runnerId: 7, name, online: false, busy: false, ...over });
const record = (name: string, over: Partial<MachineRecord> = {}): MachineRecord => ({ name, size: "small", repository: REPO, runId: 100, runAttempt: 1, ...over });
const life = (name: string, state: MachineState, at = 0, over: Partial<MachineRecord> = {}): DispatchLife => ({
  machine: record(name, over),
  life: { state, at, fired: 0 },
});
const listed = (name: string, status: MachineStatus = "operating", over: Partial<MachineRecord> = {}): ProviderMachine => ({
  machine: record(name, over),
  status,
});
const memory = (...lives: DispatchLife[]): DispatchState => ({ lives, failures: [] });

interface Facts {
  readonly now?: number;
  readonly stopped?: boolean | null;
  readonly runs?: readonly SourceRun[] | null;
  readonly runners?: readonly SourceRunner[];
  readonly machines?: readonly ProviderMachine[] | null;
}
/** This function gives the facts of a pass for the one served repository. Runs that are `null` give a view that is not known. */
const seen = (facts: Facts = {}): Observation => ({
  now: facts.now ?? 0,
  stopped: facts.stopped === undefined ? false : facts.stopped,
  views: [{ repository: REPO, view: facts.runs === null ? null : { runs: facts.runs ?? [], runners: facts.runners ?? [] } }],
  machines: facts.machines === undefined ? [] : facts.machines,
});
const A = "rd-100-1-0000000a";
const B = "rd-100-1-0000000b";
const C = "rd-100-1-0000000c";
const events = (result: Plan): readonly (readonly [string, MachineEvent])[] => result.steps.map((step) => [step.machine, step.on]);
const states = (result: Plan): Readonly<Record<string, MachineState>> =>
  Object.fromEntries(result.state.lives.map((each) => [each.machine.name, each.life.state]));

describe("plan: the requests for machines", () => {
  it("asks for nothing when the source has no run", () => {
    expect(plan(EMPTY_STATE, seen(), CONFIG)).toEqual({ state: { lives: [], failures: [] }, steps: [], adopted: [], destroys: [], removals: [], makes: [], waits: [] });
  });

  it("asks for one machine for each queued job that names the run label", () => {
    const jobs = [job("queued", { jobId: 1 }), job("queued", { jobId: 2 }), job("in_progress", { jobId: 3, runner: "other" }), job("completed", { jobId: 4 })];
    const result = plan(EMPTY_STATE, seen({ runs: [run(jobs)] }), CONFIG);
    expect(result.makes).toEqual([
      { run: KEY, size: "small" },
      { run: KEY, size: "small" },
    ]);
    expect(result.waits).toEqual([]);
  });

  it("does not count a machine of the run that waits for a job two times", () => {
    const jobs = [job("queued", { jobId: 1 }), job("queued", { jobId: 2 }), job("queued", { jobId: 3 })];
    const lives = [life(A, "asked"), life(B, "made"), life(C, "busy")];
    const machines = [listed(A, "making"), listed(B), listed(C)];
    const runners = [runner(A, { runnerId: 5 }), runner(B, { runnerId: 6 }), runner(C, { online: true, busy: true })];
    const result = plan(memory(...lives), seen({ runs: [run(jobs)], machines, runners }), CONFIG);
    expect(result.makes).toEqual([{ run: KEY, size: "small" }]);
    expect(result.steps).toEqual([]);
  });

  it("gives each job the size that its labels name, in the sequence of the settings", () => {
    const jobs = [job("queued", { jobId: 1, labels: ["run-100-1", "large"] }), job("queued", { jobId: 2 }), job("queued", { jobId: 3, labels: ["small", "run-100-1"] })];
    expect(plan(EMPTY_STATE, seen({ runs: [run(jobs)] }), CONFIG).makes).toEqual([
      { run: KEY, size: "small" },
      { run: KEY, size: "large" },
      { run: KEY, size: "small" },
    ]);
  });

  it("makes no machine for a job that does not name the label of its run", () => {
    const jobs = [job("queued", { labels: ["self-hosted"] }), job("queued", { jobId: 2, labels: ["run-101-1"] }), job("queued", { jobId: 3, labels: ["small"] })];
    const result = plan(EMPTY_STATE, seen({ runs: [run(jobs)] }), CONFIG);
    expect(result.makes).toEqual([]);
    expect(result.waits).toEqual([]);
  });

  it("makes no machine for a job that names a label that the dispatcher does not serve, and tells the reason", () => {
    const jobs = [job("queued", { labels: ["run-100-1", "gpu"] }), job("queued", { jobId: 2 })];
    const result = plan(EMPTY_STATE, seen({ runs: [run(jobs)] }), CONFIG);
    expect(result.makes).toEqual([{ run: KEY, size: "small" }]);
    expect(result.waits).toEqual([{ run: KEY, jobs: 1, reason: "label", text: "The job names a label that is not the run label or a size of the settings." }]);
  });

  it("makes no machine for a run that the policy does not trust, and gives each refusal", () => {
    const fork = run([job("queued")], 100, { event: "pull_request", headRepository: "evil/app", actor: "evil", triggeringActor: "evil" });
    const result = plan(EMPTY_STATE, seen({ runs: [fork] }), CONFIG);
    expect(result.makes).toEqual([]);
    expect(result.waits).toEqual([{ run: KEY, jobs: 1, reason: "trust", text: decide(RULES, fork.run).refusals.map((each) => each.text).join(" ") }]);
    expect(decide(RULES, fork.run).refusals.map((each) => each.rule)).toEqual(["event", "head-repository", "actor", "triggering-actor"]);
  });

  it("makes no machine for a job of a trusted run that a run that is not trusted shows", () => {
    // A fork writes the label of a trusted run. The job stays a job of the run of the fork, and that run is not trusted.
    const fork = run([job("queued", { runId: 200, labels: ["run-100-1"] })], 200, { actor: "evil", triggeringActor: "evil" });
    const result = plan(EMPTY_STATE, seen({ runs: [fork] }), CONFIG);
    expect(result.makes).toEqual([]);
    expect(result.waits).toEqual([]);
  });

  it("does not count a job that names a different run than the run that shows it", () => {
    const mixed = run([job("queued", { runId: 200, labels: ["run-100-1"] })], 100);
    expect(plan(EMPTY_STATE, seen({ runs: [mixed] }), CONFIG).makes).toEqual([]);
  });

  it("ignores a run with an id that is not valid, and a run of a different repository in the view", () => {
    const zero = run([job("queued", { runId: 0, labels: ["run-0-1"] })], 0);
    const other = run([job("queued", { repository: "octo/other" })], 100, { repository: "octo/other", headRepository: "octo/other" });
    const result = plan(EMPTY_STATE, seen({ runs: [zero, other] }), CONFIG);
    expect(result.makes).toEqual([]);
    expect(result.waits).toEqual([]);
  });

  it("counts a run that the view shows two times only one time", () => {
    const twice = [run([job("queued")]), run([job("queued")])];
    expect(plan(EMPTY_STATE, seen({ runs: twice }), CONFIG).makes).toEqual([{ run: KEY, size: "small" }]);
  });

  for (const [name, facts, reason, text] of [
    ["the stop switch is on", { stopped: true }, "stop", "The stop switch is on, or the dispatcher cannot read it."],
    ["the dispatcher cannot read the stop switch", { stopped: null }, "stop", "The stop switch is on, or the dispatcher cannot read it."],
    ["the provider gave no list", { machines: null }, "provider", "The provider gave no list of its machines."],
  ] as const) {
    it(`makes no machine when ${name}`, () => {
      const result = plan(EMPTY_STATE, seen({ runs: [run([job("queued"), job("queued", { jobId: 2 })])], ...facts }), CONFIG);
      expect(result.makes).toEqual([]);
      expect(result.waits).toEqual([{ run: KEY, jobs: 2, reason, text }]);
    });
  }

  it("makes no machine for a repository whose view is not known", () => {
    const result = plan(EMPTY_STATE, seen({ runs: null }), CONFIG);
    expect(result.makes).toEqual([]);
    expect(result.waits).toEqual([]);
  });

  it("gives the machines to the runs in turn, the oldest run first, to the capacity", () => {
    const three = (runId: number): SourceRun => run([1, 2, 3].map((jobId) => job("queued", { jobId, runId })), runId);
    const result = plan(EMPTY_STATE, seen({ runs: [three(102), three(100), three(101)] }), CONFIG);
    expect(result.makes.map((each) => each.run.runId)).toEqual([100, 101, 102, 100]);
    const text = "The dispatcher has its largest count of machines.";
    expect(result.waits).toEqual([
      { run: { ...KEY, runId: 100 }, jobs: 1, reason: "capacity", text },
      { run: { ...KEY, runId: 101 }, jobs: 2, reason: "capacity", text },
      { run: { ...KEY, runId: 102 }, jobs: 2, reason: "capacity", text },
    ]);
  });

  it("counts each machine that is not destroyed in the capacity, also a machine in the state done", () => {
    const lives = [life(A, "done"), life(B, "busy"), life(C, "registered", 0, { runId: 300 })];
    const machines = [listed(A), listed(B), listed(C, "operating", { runId: 300 })];
    const runs = [run([job("queued"), job("queued", { jobId: 2 }), job("in_progress", { jobId: 3, runner: B })]), run([job("queued", { runId: 300 })], 300)];
    const runners = [runner(B, { online: true, busy: true }), runner(C, { online: true })];
    const result = plan(memory(...lives), seen({ runs, machines, runners }), CONFIG);
    expect(result.makes).toEqual([{ run: KEY, size: "small" }]);
    expect(result.waits).toEqual([{ run: KEY, jobs: 1, reason: "capacity", text: "The dispatcher has its largest count of machines." }]);
  });

  it("frees the capacity in the pass that sees that a machine is not there", () => {
    const settings: DispatchSettings = { ...SETTINGS, capacity: 1 };
    const result = plan(memory(life(A, "done")), seen({ runs: [run([job("queued")])], machines: [] }), { ...CONFIG, settings });
    expect(events(result)).toEqual([[A, "provider.destroyed"]]);
    expect(result.makes).toEqual([{ run: KEY, size: "small" }]);
    expect(result.state.lives).toEqual([]);
  });

  it("gives a machine to the oldest try of a run first", () => {
    const settings: DispatchSettings = { ...SETTINGS, capacity: 1 };
    const second = run([job("queued", { runAttempt: 2, labels: ["run-100-2"] })], 100, { runAttempt: 2 });
    const result = plan(EMPTY_STATE, seen({ runs: [second, run([job("queued")])] }), { ...CONFIG, settings });
    expect(result.makes).toEqual([{ run: KEY, size: "small" }]);
    expect(result.waits).toEqual([{ run: { ...KEY, runAttempt: 2 }, jobs: 1, reason: "capacity", text: "The dispatcher has its largest count of machines." }]);
  });

  it("gives a machine to the repositories in the sequence of their names, when two runs have one id", () => {
    const settings: DispatchSettings = { ...SETTINGS, capacity: 1 };
    const rules: TrustRules = { ...RULES, repositories: [OTHER, REPO] };
    const there = run([job("queued", { repository: OTHER })], 100, { repository: OTHER, headRepository: OTHER });
    const views = [
      { repository: OTHER, view: { runs: [there], runners: [] } },
      { repository: REPO, view: { runs: [run([job("queued")])], runners: [] } },
    ];
    const result = plan(EMPTY_STATE, { now: 0, stopped: false, views, machines: [] }, { rules, times: TIMES, settings });
    expect(result.makes).toEqual([{ run: KEY, size: "small" }]);
    expect(result.waits.map((wait) => [wait.run.repository, wait.jobs, wait.reason])).toEqual([[OTHER, 1, "capacity"]]);
  });

  it("has an empty memory that a caller cannot change", () => {
    expect([Object.isFrozen(EMPTY_STATE), Object.isFrozen(EMPTY_STATE.lives), Object.isFrozen(EMPTY_STATE.failures)]).toEqual([true, true, true]);
  });
});

describe("plan: the events of a life", () => {
  it("gives a life each step that the facts show, in one pass", () => {
    const runs = [run([job("in_progress", { runner: A })])];
    const result = plan(memory(life(A, "asked")), seen({ now: 9000, runs, runners: [runner(A, { online: true, busy: true })], machines: [listed(A)] }), CONFIG);
    const step = (from: MachineState, on: MachineEvent, to: MachineState, transition: string): LifeStep => ({ machine: A, run: KEY, from, on, to, transition, at: 9000 });
    expect(result.steps).toEqual([
      step("asked", "provider.made", "made", "made"),
      step("made", "runner.registered", "registered", "registered"),
      step("registered", "job.started", "busy", "started"),
    ]);
    expect(result.state.lives).toEqual([{ machine: record(A), life: { state: "busy", at: 9000, fired: 0 } }]);
    expect(result.destroys).toEqual([]);
  });

  it("ends a job that started and ended between two passes, and asks the provider to destroy the machine", () => {
    const runs = [run([job("completed", { runner: A }), job("queued", { jobId: 2 })])];
    const result = plan(memory(life(A, "made")), seen({ runs, machines: [listed(A)] }), CONFIG);
    expect(events(result)).toEqual([
      [A, "runner.registered"],
      [A, "job.started"],
      [A, "job.completed"],
    ]);
    expect(result.destroys).toEqual([A]);
    expect(result.makes).toEqual([{ run: KEY, size: "small" }]);
  });

  const live = [run([job("queued")])];
  const single: readonly (readonly [string, MachineState, Facts, readonly MachineEvent[]])[] = [
    ["a machine that operates", "asked", { runs: live, machines: [listed(A)], runners: [runner(A)] }, ["provider.made"]],
    ["a machine that the provider makes", "asked", { runs: live, machines: [listed(A, "making")], runners: [runner(A)] }, []],
    ["a runner that is connected", "made", { runs: live, machines: [listed(A)], runners: [runner(A, { online: true })] }, ["runner.registered"]],
    ["a runner that is not connected", "made", { runs: live, machines: [listed(A)], runners: [runner(A)] }, []],
    ["a runner that has a job", "registered", { runs: live, machines: [listed(A)], runners: [runner(A, { online: true, busy: true })] }, ["job.started"]],
    ["a runner that has no job", "registered", { runs: live, machines: [listed(A)], runners: [runner(A, { online: true })] }, []],
    ["a job in progress", "busy", { machines: [listed(A)], runners: [runner(A, { online: true, busy: true })], runs: [run([job("in_progress", { runner: A })])] }, []],
    ["a job in progress whose runner the source does not show", "busy", { machines: [listed(A)], runs: [run([job("in_progress", { runner: A })])] }, []],
    ["a runner with a job that the list of the jobs does not show", "busy", { machines: [listed(A)], runners: [runner(A, { online: true, busy: true })], runs: [run([job("queued")])] }, []],
    ["a completed job", "busy", { machines: [listed(A)], runners: [runner(A, { online: true, busy: true })], runs: [run([job("completed", { runner: A }), job("queued", { jobId: 2 })])] }, ["job.completed"]],
    ["a runner with no job", "busy", { machines: [listed(A)], runners: [runner(A, { online: true })], runs: [run([job("queued")])] }, ["job.completed"]],
    ["a run that ended", "busy", { machines: [listed(A)] }, ["job.completed"]],
    ["a run that ended, before the machine operates", "asked", { machines: [listed(A, "making")] }, ["job.none"]],
    ["a run that ended, before the provider lists the machine", "asked", { machines: [] }, ["job.none"]],
    ["a run that ended, with a connected runner", "registered", { machines: [listed(A)], runners: [runner(A, { online: true })] }, ["job.none"]],
    ["a machine that stopped", "made", { machines: [listed(A, "stopped")], runs: [run([job("queued")])] }, ["provider.failed"]],
    ["a machine that stopped with a job", "busy", { machines: [listed(A, "stopped")], runs: [run([job("in_progress", { runner: A })])] }, ["provider.failed"]],
    ["a machine that is not there", "made", { machines: [], runs: [run([job("queued")])] }, ["provider.destroyed"]],
    ["a machine that is not there, with a job", "busy", { machines: [], runs: [run([job("in_progress", { runner: A })])] }, ["provider.destroyed"]],
    ["a machine that the provider does not list after the request", "asked", { machines: [], runs: live, runners: [runner(A)] }, []],
    ["a runner with no registration, before the machine operates", "asked", { runs: live, machines: [listed(A, "making")] }, ["job.none"]],
    ["a runner with no registration, on a machine that operates", "asked", { runs: live, machines: [listed(A)] }, ["provider.made", "job.none"]],
    ["a runner with no registration", "made", { runs: live, machines: [listed(A)] }, ["job.none"]],
    ["a runner with no registration, after its connection", "registered", { runs: live, machines: [listed(A)] }, ["job.none"]],
    ["a runner with no registration, when the view is not known", "made", { runs: null, machines: [listed(A)] }, []],
    ["the stop switch", "busy", { stopped: true, machines: [listed(A)], runs: [run([job("in_progress", { runner: A })])] }, ["stop"]],
    ["a stop switch that the dispatcher cannot read", "busy", { stopped: null, machines: [listed(A)], runs: [run([job("in_progress", { runner: A })])] }, []],
    ["a run that the policy does not trust", "registered", { machines: [listed(A)], runs: [run([job("queued")], 100, { actor: "evil" })] }, ["stop"]],
    ["a machine in the state done that is not there", "done", { machines: [] }, ["provider.destroyed"]],
    ["a machine in the state done that is there", "done", { machines: [listed(A)] }, []],
    ["a machine in the state done, after the first wait", "done", { now: 5000, machines: [listed(A)] }, ["timer.destroy"]],
    ["a machine in the state done, after the first wait, with no list", "done", { now: 5000, machines: null }, ["timer.destroy"]],
  ];
  for (const [name, state, facts, wanted] of single) {
    it(`gives a machine in the state ${state} ${wanted.length === 0 ? "no event" : `the event ${wanted.join(", ")}`} for ${name}`, () => {
      const result = plan(memory(life(A, state)), seen(facts), CONFIG);
      expect(events(result).map(([, on]) => on)).toEqual(wanted);
    });
  }

  it("stops a machine of a repository that the rules do not serve", () => {
    const stray = life(A, "registered", 0, { repository: "octo/other" });
    const result = plan(memory(stray), seen({ machines: [listed(A, "operating", { repository: "octo/other" })] }), CONFIG);
    expect(events(result)).toEqual([[A, "stop"]]);
    expect(result.destroys).toEqual([A]);
  });

  it("gives no event that needs a fact that the pass does not have", () => {
    const lives = MACHINE_STATES.filter((state) => state !== "destroyed").map((state, index) => life(`rd-100-1-0000000${index}`, state));
    const result = plan(memory(...lives), { now: 1000, stopped: null, views: [{ repository: REPO, view: null }], machines: null }, CONFIG);
    expect(result).toEqual({ state: { lives, failures: [] }, steps: [], adopted: [], destroys: [], removals: [], makes: [], waits: [] });
  });

  it("fires the timer of each state at the end of its wait, and not before", () => {
    const waits: readonly (readonly [MachineState, number, MachineEvent])[] = [
      ["asked", 60_000, "timer.make"],
      ["made", 60_000, "timer.register"],
      ["registered", 30_000, "timer.idle"],
      ["busy", 600_000, "timer.job"],
      ["done", 5000, "timer.destroy"],
    ];
    for (const [state, wait, fires] of waits) {
      // Each fact is not known. Thus only the timer can give an event.
      const facts = (now: number): Observation => ({ now, stopped: false, views: [{ repository: REPO, view: null }], machines: null });
      expect(plan(memory(life(A, state, 1000)), facts(1000 + wait - 1), CONFIG).steps).toEqual([]);
      const result = plan(memory(life(A, state, 1000)), facts(1000 + wait), CONFIG);
      expect(events(result)).toEqual([[A, fires]]);
      expect(result.destroys).toEqual([A]);
      expect(states(result)).toEqual({ [A]: "done" });
    }
  });

  it("asks the provider again for a machine in the state done, with each wait two times the wait before it", () => {
    let state = memory(life(A, "done", 0));
    const asked: number[] = [];
    for (let now = 0; now <= 200_000; now += 1000) {
      const result = plan(state, seen({ now, machines: [listed(A)] }), CONFIG);
      if (result.destroys.length > 0) asked.push(now);
      state = result.state;
    }
    expect(asked).toEqual([5000, 15_000, 35_000, 75_000, 115_000, 155_000, 195_000]);
  });

  it("gives one event at most to a life after the events that the facts show", () => {
    // The machine stopped, the stop switch is on, the run ended, and the timer fired: one transition to the state done.
    const result = plan(memory(life(A, "made", 0)), seen({ now: 999_000, stopped: true, machines: [listed(A, "stopped")] }), CONFIG);
    expect(events(result)).toEqual([[A, "provider.failed"]]);
    expect(result.destroys).toEqual([A]);
  });

  it("starts the life of a machine that the provider lists and the memory does not have", () => {
    const runs = [run([job("in_progress", { runner: A }), job("queued", { jobId: 2 })])];
    const machines = [listed(A), listed(B, "making"), listed(C, "operating", { runId: 300 })];
    const result = plan(EMPTY_STATE, seen({ now: 4000, runs, runners: [runner(A, { online: true, busy: true }), runner(B, { runnerId: 8 })], machines }), CONFIG);
    expect(result.adopted).toEqual([A, B, C]);
    // The machine C has a run that ended. Thus no machine stays without a job.
    expect(events(result)).toEqual([
      [A, "provider.made"],
      [A, "runner.registered"],
      [A, "job.started"],
      [C, "provider.made"],
      [C, "job.none"],
    ]);
    expect(states(result)).toEqual({ [A]: "busy", [B]: "asked", [C]: "done" });
    // The machine B waits for the queued job. Thus the plan asks for no more machine.
    expect(result.makes).toEqual([]);
    expect(result.destroys).toEqual([C]);
  });

  it("does not start a life when the provider gave no list, and lists a machine one time", () => {
    expect(plan(EMPTY_STATE, seen({ machines: null }), CONFIG).adopted).toEqual([]);
    const twice = plan(EMPTY_STATE, seen({ runs: [run([job("queued")])], runners: [runner(A)], machines: [listed(A, "making"), listed(A, "stopped")] }), CONFIG);
    expect(twice.adopted).toEqual([A]);
    expect(twice.steps).toEqual([]);
  });

  it("keeps the life of the memory for a machine that the provider lists with a different record", () => {
    const result = plan(memory(life(A, "made")), seen({ runs: [run([job("queued")])], runners: [runner(A)], machines: [listed(A, "operating", { runId: 999, size: "large" })] }), CONFIG);
    expect(result.adopted).toEqual([]);
    expect(result.state.lives).toEqual([life(A, "made")]);
  });

  it("takes a connected runner as the proof that the provider made the machine", () => {
    // The list of the provider can be late. A runner that is connected shows that the machine operates.
    const facts = seen({ runs: [run([job("queued")])], runners: [runner(A, { online: true })], machines: [listed(A, "making")] });
    const result = plan(memory(life(A, "asked")), facts, CONFIG);
    expect(events(result)).toEqual([
      [A, "provider.made"],
      [A, "runner.registered"],
    ]);
    expect(states(result)).toEqual({ [A]: "registered" });
  });

  it("fires the timer of a machine with a job whose run the view does not show", () => {
    // The runner has a job, and the view does not have its run. Thus only the timer of the job can end the life.
    const facts = (now: number): Observation => seen({ now, runs: [], runners: [runner(A, { online: true, busy: true })], machines: [listed(A)] });
    expect(plan(memory(life(A, "busy", 1000)), facts(600_999), CONFIG).steps).toEqual([]);
    const result = plan(memory(life(A, "busy", 1000)), facts(601_000), CONFIG);
    expect(events(result)).toEqual([[A, "timer.job"]]);
    expect(result.destroys).toEqual([A]);
  });

  it("keeps the first life of the memory when two lives have one name", () => {
    const facts = seen({ runs: [run([job("in_progress", { runner: A })])], runners: [runner(A, { online: true, busy: true })], machines: [listed(A)] });
    const result = plan(memory(life(A, "busy"), life(A, "asked")), facts, CONFIG);
    expect(result.steps).toEqual([]);
    expect(result.state.lives).toEqual([life(A, "busy")]);
  });
});

describe("plan: more machines than jobs", () => {
  it("ends the machines with no connected runner, the newest first", () => {
    const lives = [life(A, "asked", 1000), life(B, "asked", 3000), life(C, "made", 2000)];
    const machines = [listed(A, "making"), listed(B, "making"), listed(C)];
    const runners = [runner(A, { runnerId: 1 }), runner(B, { runnerId: 2 }), runner(C, { runnerId: 3 })];
    const result = plan(memory(...lives), seen({ now: 4000, runs: [run([job("queued")])], machines, runners }), CONFIG);
    expect(events(result)).toEqual([
      [B, "job.none"],
      [A, "job.none"],
    ]);
    expect(states(result)).toEqual({ [A]: "done", [B]: "done", [C]: "made" });
    expect(result.destroys).toEqual([B, A]);
    expect(result.removals.map((each) => each.name)).toEqual([A, B]);
    expect(result.makes).toEqual([]);
  });

  it("keeps a connected runner for the time of its timer, because it can have a job that the source does not show", () => {
    const lives = [life(A, "registered", 0), life(B, "registered", 0)];
    const runners = [runner(A, { online: true }), runner(B, { runnerId: 8, online: true })];
    const facts: Facts = { runs: [run([job("in_progress", { runner: "other" }), job("queued", { jobId: 2 })])], machines: [listed(A), listed(B)], runners };
    expect(plan(memory(...lives), seen({ ...facts, now: 29_999 }), CONFIG).steps).toEqual([]);
    expect(events(plan(memory(...lives), seen({ ...facts, now: 30_000 }), CONFIG))).toEqual([
      [A, "timer.idle"],
      [B, "timer.idle"],
    ]);
  });

  it("counts the machines of each size against the jobs of that size", () => {
    const lives = [life(A, "asked", 0, { size: "large" }), life(B, "asked", 0)];
    const machines = [listed(A, "making", { size: "large" }), listed(B, "making")];
    const runners = [runner(A, { runnerId: 1 }), runner(B, { runnerId: 2 })];
    const result = plan(memory(...lives), seen({ runs: [run([job("queued")])], machines, runners }), CONFIG);
    expect(events(result)).toEqual([[A, "job.none"]]);
  });

  it("ends the machine with the last name first, when two machines have one state and one time", () => {
    const lives = [life(A, "asked", 1000), life(B, "asked", 1000)];
    const facts = seen({ now: 4000, runs: [run([job("queued")])], machines: [listed(A, "making"), listed(B, "making")], runners: [runner(A, { runnerId: 1 }), runner(B, { runnerId: 2 })] });
    expect(events(plan(memory(...lives), facts, CONFIG))).toEqual([[B, "job.none"]]);
    expect(events(plan(memory(...[...lives].reverse()), facts, CONFIG))).toEqual([[B, "job.none"]]);
  });

  it("ends a machine of a size that the settings do not have", () => {
    const lives = [life(A, "made", 0, { size: "old" })];
    const result = plan(memory(...lives), seen({ runs: [run([job("queued")])], runners: [runner(A)], machines: [listed(A, "operating", { size: "old" })] }), CONFIG);
    expect(events(result)).toEqual([[A, "job.none"]]);
    expect(result.makes).toEqual([{ run: KEY, size: "small" }]);
  });
});

describe("plan: the wait after a machine that failed", () => {
  const failed = (count: number, at: number): DispatchState => ({ lives: [], failures: [{ run: KEY, count, at }] });
  const queued = (now: number): Observation => seen({ now, runs: [run([job("queued")])] });
  const text = "A machine of the run failed before a job. The dispatcher waits before the next request.";

  for (const [count, wait] of [
    [1, 5000],
    [2, 10_000],
    [3, 20_000],
    [4, 40_000],
    [5, 40_000],
    [60, 40_000],
  ] as const) {
    it(`waits ${wait} ms after ${count} failures of a run`, () => {
      const early = plan(failed(count, 1000), queued(1000 + wait - 1), CONFIG);
      expect(early.makes).toEqual([]);
      expect(early.waits).toEqual([{ run: KEY, jobs: 1, reason: "backoff", text }]);
      expect(early.state.failures).toEqual([{ run: KEY, count, at: 1000 }]);
      const late = plan(failed(count, 1000), queued(1000 + wait), CONFIG);
      expect(late.makes).toEqual([{ run: KEY, size: "small" }]);
      expect(late.waits).toEqual([]);
    });
  }

  it("does not hold a different run", () => {
    const runs = [run([job("queued")]), run([job("queued", { runId: 101 })], 101)];
    const result = plan(failed(3, 0), seen({ now: 1000, runs }), CONFIG);
    expect(result.makes).toEqual([{ run: { ...KEY, runId: 101 }, size: "small" }]);
    expect(result.waits.map((each) => [each.run.runId, each.reason])).toEqual([[100, "backoff"]]);
  });

  it("counts a failure in the pass that sees it, and holds the next request of the run", () => {
    const result = plan(memory(life(A, "made", 0)), seen({ now: 2000, runs: [run([job("queued")])], machines: [listed(A, "stopped")] }), CONFIG);
    expect(events(result)).toEqual([[A, "provider.failed"]]);
    expect(result.state.failures).toEqual([{ run: KEY, count: 1, at: 2000 }]);
    expect(result.makes).toEqual([]);
    expect(result.waits.map((each) => each.reason)).toEqual(["backoff"]);
  });

  it("ends the count of a run that the view does not show, and keeps it when the view is not known", () => {
    expect(plan(failed(2, 0), seen({ now: 1000 }), CONFIG).state.failures).toEqual([]);
    expect(plan(failed(2, 0), seen({ now: 1000, runs: null }), CONFIG).state.failures).toEqual([{ run: KEY, count: 2, at: 0 }]);
    const other: DispatchState = { lives: [], failures: [{ run: { ...KEY, repository: "octo/other" }, count: 2, at: 0 }] };
    expect(plan(other, seen({ now: 1000 }), CONFIG).state.failures).toEqual([]);
  });

  const step = (transition: string, from: MachineState, at = 7000): LifeStep => ({ machine: A, run: KEY, from, on: "stop", to: "done", transition, at });
  const before: readonly RunFailures[] = [{ run: KEY, count: 2, at: 1000 }, { run: { ...KEY, runId: 101 }, count: 1, at: 500 }];
  const counted: readonly (readonly [string, MachineState])[] = [
    ["failed", "asked"],
    ["failed", "made"],
    ["failed", "registered"],
    ["lost", "made"],
    ["lost", "registered"],
    ["make-late", "asked"],
    ["register-late", "made"],
  ];
  for (const [transition, from] of counted) {
    it(`counts the transition ${transition} from the state ${from} as a failure of the run`, () => {
      expect(noteStep(before, step(transition, from))).toEqual([{ run: { ...KEY, runId: 101 }, count: 1, at: 500 }, { run: KEY, count: 3, at: 7000 }]);
      expect(noteStep([], step(transition, from))).toEqual([{ run: KEY, count: 1, at: 7000 }]);
    });
  }
  const notCounted: readonly (readonly [string, MachineState])[] = [
    ["failed", "busy"],
    ["lost", "busy"],
    ["made", "asked"],
    ["registered", "made"],
    ["completed", "busy"],
    ["no-job", "made"],
    ["stopped", "made"],
    ["idle-late", "registered"],
    ["job-late", "busy"],
    ["destroy-again", "done"],
    ["destroyed", "done"],
  ];
  for (const [transition, from] of notCounted) {
    it(`does not count the transition ${transition} from the state ${from}`, () => {
      expect(noteStep(before, step(transition, from))).toBe(before);
    });
  }
  it("ends the count of a run at the start of a job", () => {
    expect(noteStep(before, step("started", "registered"))).toEqual([{ run: { ...KEY, runId: 101 }, count: 1, at: 500 }]);
  });
});

describe("plan: the runner registrations", () => {
  const D = "rd-100-1-0000000d";
  it("removes a registration of the dispatcher with no job when its machine has no more work, or is not there", () => {
    const lives = [life(A, "done"), life(B, "registered"), life(C, "busy")];
    const machines = [listed(A), listed(B), listed(C)];
    const runners = [
      runner(A, { runnerId: 1 }),
      runner(B, { runnerId: 2, online: true }),
      runner(C, { runnerId: 3, online: true, busy: true }),
      runner(D, { runnerId: 4 }),
      runner("rd-100-1-0000000e", { runnerId: 5, busy: true }),
      runner("ci-100-1-0000000a", { runnerId: 6 }),
      runner("laptop", { runnerId: 7 }),
    ];
    const runs = [run([job("in_progress", { runner: C }), job("queued", { jobId: 2 })])];
    const result = plan(memory(...lives), seen({ runs, runners, machines }), CONFIG);
    expect(result.removals).toEqual([
      { repository: REPO, runnerId: 1, name: A },
      { repository: REPO, runnerId: 4, name: D },
    ]);
  });

  it("removes the registration of a machine in the pass that ends the work of the machine", () => {
    const result = plan(memory(life(A, "registered")), seen({ runners: [runner(A, { online: true })], machines: [listed(A)] }), CONFIG);
    expect(events(result)).toEqual([[A, "job.none"]]);
    expect(result.removals).toEqual([{ repository: REPO, runnerId: 7, name: A }]);
  });

  it("removes the registration of a machine that the pass sees destroyed", () => {
    const result = plan(memory(life(A, "done")), seen({ runners: [runner(A)], machines: [] }), CONFIG);
    expect(result.state.lives).toEqual([]);
    expect(result.removals).toEqual([{ repository: REPO, runnerId: 7, name: A }]);
  });

  it("keeps a registration with no life when the provider gave no list", () => {
    expect(plan(EMPTY_STATE, seen({ runners: [runner(D)], machines: null }), CONFIG).removals).toEqual([]);
    expect(plan(EMPTY_STATE, seen({ runners: [runner(D)], machines: [] }), CONFIG).removals).toEqual([{ repository: REPO, runnerId: 7, name: D }]);
  });

  it("removes a registration in a repository that is not the repository of the machine with its name", () => {
    const stray = life(A, "registered", 0, { repository: "octo/other" });
    const result = plan(memory(stray), seen({ runners: [runner(A)], machines: [listed(A, "operating", { repository: "octo/other" })] }), CONFIG);
    expect(result.removals).toEqual([{ repository: REPO, runnerId: 7, name: A }]);
  });

  it("removes a registration with the name of a machine that works for a different served repository", () => {
    const rules: TrustRules = { ...RULES, repositories: [REPO, OTHER] };
    const there = { repository: OTHER };
    const runs = [run([job("in_progress", { ...there, runner: A })], 100, { ...there, headRepository: OTHER })];
    const views = [
      { repository: REPO, view: { runs: [], runners: [runner(A, { runnerId: 3 })] } },
      { repository: OTHER, view: { runs, runners: [runner(A, { runnerId: 4, online: true, busy: true })] } },
    ];
    const result = plan(memory(life(A, "busy", 0, there)), { now: 0, stopped: false, views, machines: [listed(A, "operating", there)] }, { ...CONFIG, rules });
    expect(result.steps).toEqual([]);
    expect(result.removals).toEqual([{ repository: REPO, runnerId: 3, name: A }]);
  });
});

describe("plan: each sequence of facts", () => {
  const names = [A, B, C, "rd-101-1-0000000d", "rd-101-1-0000000e", "ci-100-1-0000000a"];
  const name = fc.constantFrom(...names);
  const state = fc.constantFrom<MachineState>("asked", "made", "registered", "busy", "done");
  const size = fc.constantFrom("small", "large", "old");
  const runId = fc.constantFrom(100, 101, 102);
  const recordOf = fc.record({ name, size, repository: fc.constantFrom(REPO, "Octo/App", "octo/other"), runId, runAttempt: fc.constant(1) });
  const lifeOf = fc.record({ machine: recordOf, life: fc.record({ state, at: fc.integer({ min: 0, max: 700_000 }), fired: fc.nat(4) }) });
  const status = fc.constantFrom<MachineStatus>("making", "operating", "stopped");
  const jobOf = fc.record({
    repository: fc.constant(REPO),
    jobId: fc.nat(50),
    runId,
    runAttempt: fc.constant(1),
    labels: fc.subarray(["run-100-1", "run-101-1", "run-102-1", "small", "large", "gpu"], { minLength: 1 }),
    status: fc.constantFrom<JobStatus>("queued", "in_progress", "completed"),
    runner: fc.option(name, { nil: null }),
  });
  const runOfSource = fc.record({
    run: fc.record({
      repository: fc.constant(REPO),
      runId,
      runAttempt: fc.constant(1),
      event: fc.constantFrom("push", "pull_request"),
      headRepository: fc.constantFrom(REPO, "evil/app"),
      actor: fc.constantFrom("octo", "evil"),
      triggeringActor: fc.constantFrom("octo", "Octo"),
    }),
    jobs: fc.array(jobOf, { maxLength: 5 }),
  });
  const runnerOf = fc.record({ runnerId: fc.nat(50), name, online: fc.boolean(), busy: fc.boolean() });
  const view = fc.option(fc.record({ runs: fc.array(runOfSource, { maxLength: 4 }), runners: fc.array(runnerOf, { maxLength: 6 }) }), { nil: null });
  const facts = fc.record({
    now: fc.integer({ min: 0, max: 700_000 }),
    stopped: fc.constantFrom(true, false, null),
    views: view.map((each) => [{ repository: REPO, view: each }]),
    machines: fc.option(fc.array(fc.record({ machine: recordOf, status }), { maxLength: 6 }), { nil: null }),
  });
  const memoryOf = fc.record({
    lives: fc.uniqueArray(lifeOf, { maxLength: 5, selector: (each) => each.machine.name }),
    failures: fc.uniqueArray(fc.record({ run: fc.record({ repository: fc.constant(REPO), runId, runAttempt: fc.constant(1) }), count: fc.integer({ min: 1, max: 9 }), at: fc.nat(700_000) }), {
      maxLength: 3,
      selector: (each) => each.run.runId,
    }),
  });
  const capacity = fc.integer({ min: 1, max: 6 });
  const emits = new Set(MACHINE_LIFECYCLE.transitions.filter((each) => (each.emits ?? []).includes("provider.destroy")).map((each) => each.id));
  const freeze = <T>(value: T): T => {
    if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
      Object.freeze(value);
      Object.values(value).forEach(freeze);
    }
    return value;
  };

  it("holds the rules of a plan for each memory and each set of facts", () => {
    fc.assert(
      fc.property(memoryOf, facts, capacity, (before, observed, most) => {
        const config: DispatchConfig = { ...CONFIG, settings: { ...SETTINGS, capacity: most } };
        // The plan has no effect: it does not change a frozen input.
        const result = plan(freeze(before), freeze(observed), config);
        const view = observed.views[0]?.view ?? null;
        const start = new Map<string, MachineState>(before.lives.map((each) => [each.machine.name, each.life.state]));
        for (const listed of observed.machines ?? []) if (!start.has(listed.machine.name)) start.set(listed.machine.name, "asked");

        // Each life follows the document, from the state that it had.
        const trace: Transition[] = result.steps.map((step) => ({ machine: MACHINE_LIFECYCLE.id, instance: step.machine, from: step.from, on: step.on, to: step.to, at: step.at }));
        expect(replay(MACHINE_LIFECYCLE, trace, { machine: MACHINE_LIFECYCLE.id })).toEqual([]);
        const first = new Map<string, LifeStep>();
        for (const step of result.steps) if (!first.has(step.machine)) first.set(step.machine, step);
        for (const [machine, step] of first) expect(step.from).toBe(start.get(machine));
        expect(result.steps.every((step) => step.at === observed.now)).toBe(true);

        // The memory has each machine one time, with the state after its last step, and no destroyed machine.
        const last = new Map<string, MachineState>(start);
        for (const step of result.steps) last.set(step.machine, step.to);
        const kept = [...last].filter(([, at]) => at !== "destroyed");
        expect(Object.fromEntries(result.state.lives.map((each) => [each.machine.name, each.life.state]))).toEqual(Object.fromEntries(kept));
        expect(result.state.lives).toHaveLength(kept.length);

        // The plan asks the provider to destroy a machine at each transition of the document that tells so, and at no other.
        expect([...result.destroys].sort()).toEqual([...new Set(result.steps.filter((step) => emits.has(step.transition)).map((step) => step.machine))].sort());

        // The capacity, the stop switch and the trust hold each request for a machine.
        expect(result.makes.length).toBeLessThanOrEqual(Math.max(0, most - result.state.lives.length));
        if (observed.stopped !== false || observed.machines === null || view === null) expect(result.makes).toEqual([]);
        for (const make of result.makes) {
          const shown = view?.runs.find((each) => each.run.runId === make.run.runId);
          expect(shown === undefined ? false : decide(RULES, shown.run).trusted).toBe(true);
          expect(SETTINGS.sizes).toContain(make.size);
        }

        // With the stop switch on, each machine that stays is in the state done.
        if (observed.stopped === true) expect(result.state.lives.every((each) => each.life.state === "done")).toBe(true);
        // A machine of a run that is not trusted, or of a repository that is not served, does not stay in work.
        for (const each of result.state.lives) {
          const shown = view?.runs.find((candidate) => candidate.run.runId === each.machine.runId);
          const refused = each.machine.repository === "octo/other" || (shown !== undefined && !decide(RULES, shown.run).trusted);
          if (refused) expect(each.life.state).toBe("done");
        }

        // A machine does not wait for a job when a view that the pass has shows no registration of its runner.
        if (view !== null) {
          for (const each of result.state.lives) {
            if (each.life.state === "busy" || each.life.state === "done") continue;
            expect(view.runners.some((candidate) => candidate.name === each.machine.name)).toBe(true);
          }
        }

        // A fact that the pass does not have gives no event.
        const ons = new Set(result.steps.map((step) => step.on));
        if (observed.machines === null) {
          expect(result.adopted).toEqual([]);
          expect(ons.has("provider.destroyed") || ons.has("provider.failed")).toBe(false);
        }
        if (view === null) {
          for (const on of ["runner.registered", "job.started", "job.completed", "job.none"] as const) expect(ons.has(on)).toBe(false);
          expect(result.removals).toEqual([]);
          expect(result.state.failures.length).toBeGreaterThanOrEqual(before.failures.length);
        }

        // The plan removes only registrations of this dispatcher that have no job.
        for (const removal of result.removals) {
          expect(parseMachineName("rd", removal.name)).not.toBeNull();
          expect(view?.runners.some((each) => each.runnerId === removal.runnerId && each.name === removal.name && !each.busy)).toBe(true);
          const kept = result.state.lives.find((each) => each.machine.name === removal.name && each.machine.repository !== "octo/other");
          expect(kept === undefined || kept.life.state === "done").toBe(true);
        }
      }),
      { numRuns: 3000, seed: 20261110 },
    );
  });
});
