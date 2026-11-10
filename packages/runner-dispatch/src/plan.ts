import {
  advance,
  due,
  MACHINE_STATES,
  startLife,
  waitOf,
  type MachineEvent,
  type MachineLife,
  type MachineState,
  type MachineTimes,
} from "./lifecycle.ts";
import { decide, type TrustRules } from "./policy.ts";
import type { MachineStatus, ProviderMachine, RepositoryView } from "./ports.ts";
import { foldName, isId, runLabel, sameName, sameRun, type MachineRecord, type RunKey } from "./records.ts";
import { parseMachineName, sizeOfLabels, type DispatchSettings } from "./settings.ts";

/** This record is one machine in the memory of the dispatcher: its record and the present point of its life. */
export interface DispatchLife {
  /** This field is the record of the machine. */
  readonly machine: MachineRecord;
  /** This field is the present point of the life of the machine. */
  readonly life: MachineLife;
}

/** This record counts the machines of one run that failed before a job, one after the other. */
export interface RunFailures {
  /** This field is the run. */
  readonly run: RunKey;
  /** This field is the count of the failures. */
  readonly count: number;
  /** This field is the time of the last failure, in milliseconds. */
  readonly at: number;
}

/** This record is the memory of a dispatcher. A dispatcher that starts again has the empty memory. */
export interface DispatchState {
  /** This list has each machine that is not in the state `destroyed`. */
  readonly lives: readonly DispatchLife[];
  /** This list has the failures of each run that has some. */
  readonly failures: readonly RunFailures[];
}

/** This value is the memory of a dispatcher that starts. */
export const EMPTY_STATE: DispatchState = Object.freeze({ lives: Object.freeze([]), failures: Object.freeze([]) });

/** This record is what the dispatcher saw of one repository in a pass. */
export interface RepositoryObservation {
  /** This field is the repository, as `owner/name`. */
  readonly repository: string;
  /** This field is the answer of the source. It is `null` when the source gave no answer. */
  readonly view: RepositoryView | null;
}

/** This record is what the dispatcher saw in one pass. A fact that it could not read is `null`. */
export interface Observation {
  /** This field is the time of the pass, in milliseconds of a clock that does not go back. */
  readonly now: number;
  /** This field is `true` when the stop switch is on. It is `null` when the dispatcher cannot read the switch. */
  readonly stopped: boolean | null;
  /** This list has one entry for each served repository. */
  readonly views: readonly RepositoryObservation[];
  /** This list has each machine of the provider. It is `null` when the provider gave no answer. */
  readonly machines: readonly ProviderMachine[] | null;
}

/** This record has the documents that a dispatcher follows. */
export interface DispatchConfig {
  /** This field has the trust rules. */
  readonly rules: TrustRules;
  /** This field has the times of a machine. */
  readonly times: MachineTimes;
  /** This field has the settings of the dispatcher. */
  readonly settings: DispatchSettings;
}

/** This record is one transition of one machine, as a pass recorded it. */
export interface LifeStep {
  /** This field is the name of the machine. */
  readonly machine: string;
  /** This field is the run of the machine. */
  readonly run: RunKey;
  /** This field is the state before the transition. */
  readonly from: MachineState;
  /** This field is the event. */
  readonly on: MachineEvent;
  /** This field is the state after the transition. */
  readonly to: MachineState;
  /** This field is the id of the transition in the document `MACHINE_LIFECYCLE`. */
  readonly transition: string;
  /** This field is the time of the transition, in milliseconds. */
  readonly at: number;
}

/** This record is one machine that the plan asks for. The pass gives it a name. */
export interface PlannedMake {
  /** This field is the run of the machine. */
  readonly run: RunKey;
  /** This field is the size class of the machine. */
  readonly size: string;
}

/** This record is one runner registration that the plan removes. */
export interface PlannedRemoval {
  /** This field is the repository of the registration. */
  readonly repository: string;
  /** This field is the id of the registration. */
  readonly runnerId: number;
  /** This field is the name of the runner. */
  readonly name: string;
}

/**
 * This type names the reason that queued jobs get no machine in a pass:
 *
 * - `trust`: the policy does not trust the run.
 * - `label`: the job names a label that the dispatcher does not serve.
 * - `stop`: the stop switch is on, or the dispatcher cannot read it.
 * - `provider`: the provider gave no list of its machines.
 * - `backoff`: a machine of the run failed, and the wait before the next request did not end.
 * - `capacity`: the dispatcher has its largest count of machines.
 */
export type WaitReason = "trust" | "label" | "stop" | "provider" | "backoff" | "capacity";

/** This record tells that queued jobs of a run get no machine in a pass. */
export interface PlannedWait {
  /** This field is the run of the jobs. */
  readonly run: RunKey;
  /** This field is the count of the jobs. */
  readonly jobs: number;
  /** This field names the reason. */
  readonly reason: WaitReason;
  /** This field tells the reason in sentences, for a log. */
  readonly text: string;
}

/** This record is the plan of one pass: the memory after the events, and the requests of the pass. */
export interface Plan {
  /** This field is the memory after the events of the pass. */
  readonly state: DispatchState;
  /** This list has each transition of the pass, in its sequence. */
  readonly steps: readonly LifeStep[];
  /** This list has the name of each machine that the provider has and the memory did not have. */
  readonly adopted: readonly string[];
  /** This list has the name of each machine that the pass asks the provider to destroy. */
  readonly destroys: readonly string[];
  /** This list has each runner registration that the pass removes. */
  readonly removals: readonly PlannedRemoval[];
  /** This list has each machine that the pass asks for. */
  readonly makes: readonly PlannedMake[];
  /** This list has the queued jobs that get no machine in this pass, with the reason. */
  readonly waits: readonly PlannedWait[];
}

const WAIT_TEXT: Readonly<Record<Exclude<WaitReason, "trust">, string>> = Object.freeze({
  label: "The job names a label that is not the run label or a size of the settings.",
  stop: "The stop switch is on, or the dispatcher cannot read it.",
  provider: "The provider gave no list of its machines.",
  backoff: "A machine of the run failed before a job. The dispatcher waits before the next request.",
  capacity: "The dispatcher has its largest count of machines.",
});

const WAITING: readonly MachineState[] = Object.freeze(["asked", "made", "registered"]);

/** This function gives the run of a machine. */
export function runOf(machine: MachineRecord): RunKey {
  return { repository: machine.repository, runId: machine.runId, runAttempt: machine.runAttempt };
}

/**
 * This function counts a transition in the failures of its run.
 * A machine fails before a job when the provider fails, the machine is lost, or its first two timers fire.
 * The start of a job ends the count of its run.
 *
 * @param failures - The failures before the transition
 * @param step - The transition
 * @returns The failures after the transition
 */
export function noteStep(failures: readonly RunFailures[], step: LifeStep): readonly RunFailures[] {
  const started = step.transition === "started";
  const late = step.transition === "make-late" || step.transition === "register-late";
  const broken = (step.transition === "failed" || step.transition === "lost") && step.from !== "busy";
  if (!started && !late && !broken) return failures;
  const rest = failures.filter((each) => !sameRun(each.run, step.run));
  if (started) return rest;
  const before = failures.find((each) => sameRun(each.run, step.run));
  return [...rest, { run: step.run, count: (before?.count ?? 0) + 1, at: step.at }];
}

interface Entry {
  readonly machine: MachineRecord;
  life: MachineLife;
  /** This field is true after a transition to the state done in this pass. The life then takes no more event in the pass. */
  ended: boolean;
}

interface Wanted {
  readonly run: RunKey;
  readonly size: string;
  need: number;
}

/**
 * This function is the decision of one pass of the dispatcher. It reads the memory and the facts of the pass, and it has no effect.
 *
 * - It adopts each machine of the provider that the memory does not have. Thus a dispatcher that starts again finds each machine.
 * - It gives each life the events that the facts show, in the sequence of the document `MACHINE_LIFECYCLE`. A fact that is `null` gives no event.
 * - A machine goes to `done` when it stopped, the stop switch is on, the policy does not trust its run, or its timer fires.
 * - A machine that waits for a job goes to `done` when its run ended, or its runner has no registration.
 * - It asks for one machine for each queued job of a trusted run that names the run label. The machines of the run that wait for a job decrease the count.
 * - It removes each runner registration of the dispatcher that has no job and no machine that works.
 *
 * @param state - The memory of the dispatcher
 * @param seen - The facts of the pass
 * @param config - The trust rules, the times and the settings
 * @returns The plan
 * @throws RangeError when `parseMachineTimes` does not accept the times
 */
export function plan(state: DispatchState, seen: Observation, config: DispatchConfig): Plan {
  const { now } = seen;
  const { rules, times, settings } = config;
  const entries = new Map<string, Entry>();
  for (const each of state.lives) {
    if (!entries.has(each.machine.name)) entries.set(each.machine.name, { machine: each.machine, life: each.life, ended: false });
  }

  // A machine of the provider with no life in the memory starts a life. The facts then give its events.
  const adopted: string[] = [];
  const status = new Map<string, MachineStatus>();
  for (const listed of seen.machines ?? []) {
    const { name } = listed.machine;
    if (status.has(name)) continue;
    status.set(name, listed.status);
    if (!entries.has(name)) {
      entries.set(name, { machine: listed.machine, life: startLife(now), ended: false });
      adopted.push(name);
    }
  }

  const observed = (repository: string): RepositoryObservation | undefined =>
    seen.views.find((each) => sameName(each.repository, repository));
  const steps: LifeStep[] = [];
  const destroys: string[] = [];
  let failures = state.failures;
  const apply = (entry: Entry, event: MachineEvent): boolean => {
    const step = advance(entry.life, event, now);
    if (step === null) return false;
    const record: LifeStep = {
      machine: entry.machine.name,
      run: runOf(entry.machine),
      from: entry.life.state,
      on: event,
      to: step.life.state,
      transition: step.transition,
      at: now,
    };
    steps.push(record);
    failures = noteStep(failures, record);
    if (step.actions.includes("provider.destroy") && !destroys.includes(entry.machine.name)) destroys.push(entry.machine.name);
    entry.ended = entry.ended || step.life.state === "done";
    entry.life = step.life;
    return true;
  };

  for (const entry of entries.values()) {
    const { name } = entry.machine;
    const place = observed(entry.machine.repository);
    const view = place?.view ?? null;
    const run = view?.runs.find((each) => sameRun(entry.machine, each.run));
    const runner = view?.runners.find((each) => each.name === name);
    const jobs = (run?.jobs ?? []).filter((job) => job.runner === name);
    const named = jobs.length > 0;
    const working = jobs.some((job) => job.status === "in_progress");
    const online = runner?.online === true;
    const busy = runner?.busy === true;
    const machine: MachineStatus | "absent" | "unknown" = seen.machines === null ? "unknown" : (status.get(name) ?? "absent");

    // The main path: the facts can show more than one step, because a pass can come after some reports.
    const shown = (state: MachineState): MachineEvent | null => {
      if (state === "asked") return machine === "operating" || online || busy || named ? "provider.made" : null;
      if (state === "made") return online || busy || named ? "runner.registered" : null;
      if (state === "registered") return busy || named ? "job.started" : null;
      if (state === "busy") return view !== null && !working && (named || !busy) ? "job.completed" : null;
      return null;
    };
    let event = shown(entry.life.state);
    while (event !== null && apply(entry, event)) event = shown(entry.life.state);

    const at = entry.life.state;
    if (entry.ended || at === "destroyed") continue;
    if (at === "done") {
      if (machine === "absent") apply(entry, "provider.destroyed");
      else {
        const timer = due(entry.life, now, times);
        if (timer !== null) apply(entry, timer);
      }
      continue;
    }
    const trusted = run === undefined ? null : decide(rules, run.run).trusted;
    if (machine === "absent" && at !== "asked") apply(entry, "provider.destroyed");
    else if (machine === "stopped") apply(entry, "provider.failed");
    else if (seen.stopped === true || place === undefined || trusted === false) apply(entry, "stop");
    // A runner with no registration gets no job: it did a job that the view does not show, or the source removed it.
    else if (at !== "busy" && view !== null && (run === undefined || runner === undefined)) apply(entry, "job.none");
    else {
      const timer = due(entry.life, now, times);
      if (timer !== null) apply(entry, timer);
    }
  }

  // The queued jobs of each trusted run, against the machines of the run that wait for a job.
  const waits: PlannedWait[] = [];
  const wanted: Wanted[] = [];
  const counted = new Set<string>();
  for (const place of seen.views) {
    if (place.view === null) continue;
    for (const run of place.view.runs) {
      const record = run.run;
      if (!isId(record.runId) || !isId(record.runAttempt) || !sameName(record.repository, place.repository)) continue;
      const id = `${foldName(record.repository)} ${record.runId} ${record.runAttempt}`;
      if (counted.has(id)) continue;
      counted.add(id);
      const key: RunKey = { repository: record.repository, runId: record.runId, runAttempt: record.runAttempt };
      const label = runLabel(record);
      const jobs = run.jobs.filter((job) => sameRun(job, record) && job.status === "queued" && job.labels.includes(label));
      const group = [...entries.values()].filter((entry) => sameRun(entry.machine, record) && WAITING.includes(entry.life.state));
      if (jobs.length === 0 && group.length === 0) continue;
      const decision = decide(rules, record);
      if (!decision.trusted) {
        if (jobs.length > 0) {
          waits.push({ run: key, jobs: jobs.length, reason: "trust", text: decision.refusals.map((each) => each.text).join(" ") });
        }
        continue;
      }
      const queued = new Map<string, number>();
      let refused = 0;
      for (const job of jobs) {
        const size = sizeOfLabels(settings, label, job.labels);
        if (size === null) refused += 1;
        else queued.set(size, (queued.get(size) ?? 0) + 1);
      }
      if (refused > 0) waits.push({ run: key, jobs: refused, reason: "label", text: WAIT_TEXT.label });
      for (const size of new Set([...settings.sizes, ...group.map((entry) => entry.machine.size)])) {
        const waiting = group.filter((entry) => entry.machine.size === size);
        const need = (queued.get(size) ?? 0) - waiting.length;
        if (need > 0) wanted.push({ run: key, size, need });
        if (need >= 0) continue;
        // More machines than jobs: the machines with no connected runner end first, the newest first.
        // A connected runner can have a job that the source does not show yet. Thus it waits for its timer.
        const spare = waiting
          .filter((entry) => entry.life.state !== "registered")
          .sort(
            (a, b) =>
              MACHINE_STATES.indexOf(a.life.state) - MACHINE_STATES.indexOf(b.life.state) ||
              b.life.at - a.life.at ||
              (a.machine.name < b.machine.name ? 1 : -1),
          );
        for (const entry of spare.slice(0, -need)) apply(entry, "job.none");
      }
    }
  }

  // The requests for machines: one for each run in turn, to the capacity.
  const block = (run: RunKey): Exclude<WaitReason, "trust" | "label" | "capacity"> | null => {
    if (seen.stopped !== false) return "stop";
    if (seen.machines === null) return "provider";
    const failed = failures.find((each) => sameRun(each.run, run));
    const wait = failed === undefined ? null : waitOf("done", times, failed.count - 1);
    return failed !== undefined && wait !== null && now - failed.at < wait.low ? "backoff" : null;
  };
  const order = (size: string): number => settings.sizes.indexOf(size);
  wanted.sort(
    (a, b) =>
      a.run.runId - b.run.runId ||
      a.run.runAttempt - b.run.runAttempt ||
      order(a.size) - order(b.size) ||
      (foldName(a.run.repository) < foldName(b.run.repository) ? -1 : 1),
  );
  const open: Wanted[] = [];
  for (const each of wanted) {
    const reason = block(each.run);
    if (reason === null) open.push(each);
    else waits.push({ run: each.run, jobs: each.need, reason, text: WAIT_TEXT[reason] });
  }
  const makes: PlannedMake[] = [];
  let room = settings.capacity - [...entries.values()].filter((entry) => entry.life.state !== "destroyed").length;
  for (let turn = true; turn && room > 0; ) {
    turn = false;
    for (const each of open) {
      if (each.need === 0 || room <= 0) continue;
      makes.push({ run: each.run, size: each.size });
      each.need -= 1;
      room -= 1;
      turn = true;
    }
  }
  for (const each of open) {
    if (each.need > 0) waits.push({ run: each.run, jobs: each.need, reason: "capacity", text: WAIT_TEXT.capacity });
  }

  // A registration of this dispatcher with no job is removed when its machine has no more work, or is not there.
  const removals: PlannedRemoval[] = [];
  for (const place of seen.views) {
    if (place.view === null) continue;
    for (const runner of place.view.runners) {
      if (runner.busy || parseMachineName(settings.prefix, runner.name) === null) continue;
      const entry = entries.get(runner.name);
      const own = entry !== undefined && sameName(entry.machine.repository, place.repository) ? entry : undefined;
      const gone = own === undefined ? seen.machines !== null : own.life.state === "done" || own.life.state === "destroyed";
      if (gone) removals.push({ repository: place.repository, runnerId: runner.runnerId, name: runner.name });
    }
  }

  // The count of a run ends with the run.
  failures = failures.filter((each) => {
    const place = observed(each.run.repository);
    if (place === undefined) return false;
    return place.view === null || place.view.runs.some((run) => sameRun(each.run, run.run));
  });

  const lives: DispatchLife[] = [];
  for (const entry of entries.values()) {
    if (entry.life.state !== "destroyed") lives.push({ machine: entry.machine, life: entry.life });
  }
  return { state: { lives, failures }, steps, adopted, destroys, removals, makes, waits };
}
