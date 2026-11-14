import type { JobSight, PassReport } from "./dispatcher.ts";
import type { MachineEvent, MachineState } from "./lifecycle.ts";
import type { JobStatus } from "./ports.ts";
import { foldName, isId, sameName, type RunKey } from "./records.ts";

/** This constant is the format of a record of a machine. */
export const MACHINE_MEASURE_FORMAT = "machine-measure/1";

/** This constant is the format of a record of a job. */
export const JOB_MEASURE_FORMAT = "job-measure/1";

/**
 * This record is the time of an event, as the reads of a dispatcher show it. The event came at a time from `after` to `at`.
 * `after` is the start of the last read before it that did not show the event. It is `null` when the records have no such read.
 * `at` is the end of the first read that showed the event. For an act of the dispatcher, `after` and `at` are the same time.
 */
export interface Moment {
  /** This field is the earliest time of the event, in milliseconds, or `null` when the records do not know it. */
  readonly after: number | null;
  /** This field is the latest time of the event, in milliseconds. */
  readonly at: number;
}

/** This record has the times of the life of one machine. Each time is in milliseconds of the clock of the dispatcher. */
export interface MachineMeasure {
  /** This field is the format `machine-measure/1`. */
  readonly format: typeof MACHINE_MEASURE_FORMAT;
  /** This field is the name of the machine. */
  readonly machine: string;
  /** This field is the size class of the machine. It is `null` when the records do not have it. */
  readonly size: string | null;
  /** This field is the run of the machine. */
  readonly run: RunKey;
  /** This field is the time of the request for the machine. It is `null` for a machine that a dispatcher adopted after a new start. */
  readonly asked: number | null;
  /** This field is the time that the machine operated. */
  readonly made: Moment | null;
  /** This field is the time that the runner of the machine connected. */
  readonly registered: Moment | null;
  /** This field is the time that the runner got its job. */
  readonly started: Moment | null;
  /** This field is the end of the work of the machine: the entry to the state `done`. */
  readonly ended: Moment | null;
  /** This field is the event of the end of the work, for example `job.completed` or `timer.job`. */
  readonly end: MachineEvent | null;
  /** This field is the time that the provider showed the machine as not there. */
  readonly destroyed: Moment | null;
}

/** This record has the times of one job, as the views of the dispatcher show it. Each time is in milliseconds of the clock of the dispatcher. */
export interface JobMeasure {
  /** This field is the format `job-measure/1`. */
  readonly format: typeof JOB_MEASURE_FORMAT;
  /** This field is the repository of the job, as `owner/name`. */
  readonly repository: string;
  /** This field is the id of the run of the job. */
  readonly runId: number;
  /** This field is the number of the try of the run. */
  readonly runAttempt: number;
  /** This field is the id of the job. */
  readonly jobId: number;
  /** This field is the time that a view showed the job first. A queued job enters the queue at this time. */
  readonly queued: Moment;
  /** This field is the time that a runner got the job. It is `null` when no view showed a runner with the job. */
  readonly started: Moment | null;
  /** This field is the time that the job ended. A view shows the end, or the run of the job goes out of the view. */
  readonly completed: Moment | null;
  /** This field is the name of the runner of the job, or `null`. */
  readonly runner: string | null;
  /** This field is the last status that a view showed. */
  readonly last: JobStatus;
}

/** This record is the time of the last read of the view of one repository. */
export interface ViewRead {
  /** This field is the repository, as `owner/name`. */
  readonly repository: string;
  /** This field is the start of the read, in milliseconds. */
  readonly at: number;
}

/** This record is the memory of the measures: the last reads, and the records that are not complete. */
export interface MeasureState {
  /** This field is the start of the last read of the provider, or `null`. */
  readonly listed: number | null;
  /** This list has the start of the last read of the view of each repository. */
  readonly views: readonly ViewRead[];
  /** This list has the start of the last pass that read the provider and the view of each repository. */
  readonly both: readonly ViewRead[];
  /** This list has the record of each machine that is not destroyed. */
  readonly machines: readonly MachineMeasure[];
  /** This list has the record of each job that is not complete. */
  readonly jobs: readonly JobMeasure[];
  /** This list has the key of each complete job that a view still shows. A key is the repository in lower case, a space and the job id. */
  readonly closed: readonly string[];
}

/** This constant is the memory of the measures before the first pass. */
export const EMPTY_MEASURES: MeasureState = Object.freeze({
  listed: null,
  views: Object.freeze([]),
  both: Object.freeze([]),
  machines: Object.freeze([]),
  jobs: Object.freeze([]),
  closed: Object.freeze([]),
});

/** This record is the result of one pass for the measures: the new memory, and the records that the pass completed. */
export interface MeasureNote {
  /** This field is the new memory. */
  readonly state: MeasureState;
  /** This list has the record of each machine that the pass destroyed or forgot. */
  readonly machines: readonly MachineMeasure[];
  /** This list has the record of each job that the pass showed complete. */
  readonly jobs: readonly JobMeasure[];
}

/** This type names the read that shows an event, or `act` for an act of the dispatcher. */
type Source = "act" | "provider" | "view" | "both";

/**
 * This function gives the read that shows an event of the life of a machine.
 * The plan finds `provider.made` from the provider or from the view, thus the event needs the two reads.
 */
const sourceOf = (event: MachineEvent, askedInPass: boolean): Source => {
  if (event === "provider.made") return "both";
  if (event === "runner.registered" || event === "job.started" || event === "job.completed" || event === "job.none") return "view";
  if (event === "provider.destroyed") return "provider";
  // A failed request for a machine is an act of the pass. A stopped machine is a fact of the provider.
  if (event === "provider.failed") return askedInPass ? "act" : "provider";
  return "act";
};

/** This function gives the later of two earliest times. `null` is a time that the records do not know. */
const later = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));

/** This function gives the time of the last read of a repository. */
const readOf = (reads: readonly ViewRead[], repository: string): number | null =>
  reads.find((each) => sameName(each.repository, repository))?.at ?? null;

/** This function puts the time of a read of each repository in a list. */
const withReads = (reads: readonly ViewRead[], repositories: readonly string[], at: number): readonly ViewRead[] => {
  const next = reads.filter((each) => !repositories.some((repository) => sameName(repository, each.repository)));
  return [...next, ...repositories.map((repository) => ({ repository, at }))];
};

/** This list has the fields of the times of a machine, in the sequence of its life. */
const SLOTS = ["made", "registered", "started", "ended", "destroyed"] as const;

/** This type names a field of a time of a machine. */
type Slot = (typeof SLOTS)[number];

/** This table gives the field of the time of the entry to each state. */
const SLOT_OF: Readonly<Record<MachineState, Slot | null>> = {
  asked: null,
  made: "made",
  registered: "registered",
  busy: "started",
  done: "ended",
  destroyed: "destroyed",
};

/** This function gives the earliest time of an event of a machine: each event of the life comes after the events before it. */
const floorOf = (record: MachineMeasure, slot: Slot): number | null =>
  SLOTS.slice(0, SLOTS.indexOf(slot)).reduce<number | null>((floor, each) => later(floor, record[each]?.after ?? null), record.asked);

/** This function gives the key of a job: its repository and its id. */
const jobKey = (repository: string, jobId: number): string => `${foldName(repository)} ${String(jobId)}`;

/** This function tells if a job of a view has the fields of a record. */
const validSight = (sight: JobSight): boolean =>
  typeof sight.repository === "string" && isId(sight.jobId) && isId(sight.runId) && isId(sight.runAttempt);

/**
 * This function adds one pass report to the measures. It is a function with no effect.
 * It gives the record of each machine that the pass destroyed, and of each job that the pass showed complete.
 * A machine that is not in the memory of the dispatcher after the pass also completes its record, also when it is not destroyed.
 *
 * Each time of a record comes from a read or from an act of the dispatcher. The bounds of a time contain the time of the event.
 * A test on a fake world with random times holds this.
 *
 * @param state - The memory of the measures
 * @param report - The report of the next pass, in the sequence of the passes
 * @returns The new memory and the complete records
 */
export function noteReport(state: MeasureState, report: PassReport): MeasureNote {
  const machines = new Map<string, MachineMeasure>(state.machines.map((record) => [record.machine, record]));
  const viewed = (repository: string): boolean => report.viewed.some((each) => sameName(each, repository));

  for (const ask of report.asked) {
    if (machines.has(ask.machine)) continue;
    const record = report.made.find((each) => each.name === ask.machine);
    if (record === undefined) continue;
    machines.set(ask.machine, {
      format: MACHINE_MEASURE_FORMAT,
      machine: ask.machine,
      size: record.size,
      run: { repository: record.repository, runId: record.runId, runAttempt: record.runAttempt },
      asked: ask.at,
      made: null,
      registered: null,
      started: null,
      ended: null,
      end: null,
      destroyed: null,
    });
  }

  for (const step of report.steps) {
    const known = machines.get(step.machine);
    const life = report.lives.find((each) => each.machine.name === step.machine);
    const record: MachineMeasure = known ?? {
      format: MACHINE_MEASURE_FORMAT,
      machine: step.machine,
      size: life?.machine.size ?? null,
      run: step.run,
      asked: null,
      made: null,
      registered: null,
      started: null,
      ended: null,
      end: null,
      destroyed: null,
    };
    const slot = SLOT_OF[step.to];
    // The first record of an event stays: a new life after a new start shows the same events later.
    if (slot === null || record[slot] !== null) {
      machines.set(step.machine, record);
      continue;
    }
    const source = sourceOf(
      step.on,
      report.asked.some((each) => each.machine === step.machine),
    );
    let moment: Moment;
    if (source === "act") moment = { after: step.at, at: step.at };
    else {
      const read = source === "provider" ? state.listed : readOf(source === "view" ? state.views : state.both, step.run.repository);
      const after = later(read, floorOf(record, slot));
      moment = { after: after === null ? null : Math.min(after, report.read), at: report.read };
    }
    machines.set(step.machine, slot === "ended" ? { ...record, ended: moment, end: step.on } : { ...record, [slot]: moment });
  }

  const finishedMachines: MachineMeasure[] = [];
  const openMachines: MachineMeasure[] = [];
  for (const record of machines.values()) {
    const kept = report.lives.some((each) => each.machine.name === record.machine);
    // A machine that the dispatcher forgot completes its record after a read of the provider: with no read, a new start adopts it.
    if (record.destroyed !== null || (!kept && report.listed)) finishedMachines.push(record);
    else openMachines.push(record);
  }

  const jobs = new Map<string, JobMeasure>(state.jobs.map((record) => [jobKey(record.repository, record.jobId), record]));
  const shown = new Set<string>();
  const closed = new Set(state.closed);
  const finishedJobs: JobMeasure[] = [];
  for (const sight of report.jobs) {
    if (!validSight(sight) || !viewed(sight.repository)) continue;
    const key = jobKey(sight.repository, sight.jobId);
    if (shown.has(key)) continue;
    shown.add(key);
    // A run shows each of its jobs until the run is complete. The record of a complete job does not start again.
    if (closed.has(key)) continue;
    const read = readOf(state.views, sight.repository);
    const known = jobs.get(key);
    const queued: Moment = known?.queued ?? { after: read, at: report.read };
    const floor = later(read, later(queued.after, known?.started?.after ?? null));
    const moment: Moment = { after: floor === null ? null : Math.min(floor, report.read), at: report.read };
    const begun = sight.status === "in_progress" || (sight.status === "completed" && sight.runner !== null);
    const record: JobMeasure = {
      format: JOB_MEASURE_FORMAT,
      repository: known?.repository ?? sight.repository,
      runId: sight.runId,
      runAttempt: sight.runAttempt,
      jobId: sight.jobId,
      queued,
      started: known?.started ?? (begun ? moment : null),
      completed: sight.status === "completed" ? moment : null,
      runner: sight.runner ?? known?.runner ?? null,
      last: sight.status,
    };
    jobs.set(key, record);
    if (record.completed !== null) {
      finishedJobs.push(record);
      jobs.delete(key);
      closed.add(key);
    }
  }
  for (const key of closed) {
    const repository = key.slice(0, key.lastIndexOf(" "));
    if (!shown.has(key) && report.viewed.some((each) => foldName(each) === repository)) closed.delete(key);
  }
  // A job of a read repository that the view does not show is complete: the view shows each run that is not complete.
  for (const [key, record] of jobs) {
    if (shown.has(key) || !viewed(record.repository)) continue;
    const floor = later(readOf(state.views, record.repository), later(record.queued.after, record.started?.after ?? null));
    finishedJobs.push({ ...record, completed: { after: floor === null ? null : Math.min(floor, report.read), at: report.read } });
    jobs.delete(key);
  }

  return {
    state: {
      listed: report.listed ? report.at : state.listed,
      views: withReads(state.views, report.viewed, report.at),
      both: report.listed ? withReads(state.both, report.viewed, report.at) : state.both,
      machines: openMachines,
      jobs: [...jobs.values()],
      closed: [...closed],
    },
    machines: finishedMachines,
    jobs: finishedJobs,
  };
}

/** This record is the bounds of a time from one event to a later event, in milliseconds. */
export interface Span {
  /** This field is the shortest time. */
  readonly low: number;
  /** This field is the longest time, or `null` when the records do not know the earliest time of the first event. */
  readonly high: number | null;
}

/**
 * This function gives the bounds of the time from one event to a later event.
 *
 * @param from - The first event: a moment, or an exact time
 * @param to - The later event
 * @returns The bounds, or `null` when a record does not have one of the two events
 */
export function spanOf(from: Moment | number | null, to: Moment | null): Span | null {
  if (from === null || to === null) return null;
  const first: Moment = typeof from === "number" ? { after: from, at: from } : from;
  const low = to.after === null ? 0 : Math.max(0, to.after - first.at);
  const high = first.after === null ? null : to.at - first.after;
  return { low, high: high === null ? null : Math.max(low, high) };
}

/** This record has the spans of the life of one machine. */
export interface MachineSpans {
  /** This field is the time from the request to the connection of the runner: the start time of the machine. */
  readonly start: Span | null;
  /** This field is the time from the request to the operation of the machine. */
  readonly boot: Span | null;
  /** This field is the time from the connection of the runner to its job. */
  readonly idle: Span | null;
  /** This field is the time from the start of the job to the end of the work. */
  readonly job: Span | null;
  /** This field is the time from the end of the work to the end of the machine. */
  readonly teardown: Span | null;
  /** This field is the time from the request to the end of the machine. */
  readonly life: Span | null;
}

/**
 * This function gives the spans of the life of one machine.
 *
 * @param record - The record of the machine
 * @returns The spans
 */
export function machineSpans(record: MachineMeasure): MachineSpans {
  return {
    start: spanOf(record.asked, record.registered),
    boot: spanOf(record.asked, record.made),
    idle: spanOf(record.registered, record.started),
    job: spanOf(record.started, record.ended),
    teardown: spanOf(record.ended, record.destroyed),
    life: spanOf(record.asked, record.destroyed),
  };
}

/** This record has the spans of one job. */
export interface JobSpans {
  /** This field is the time from the queue to the start: the queue time of the job. */
  readonly queue: Span | null;
  /** This field is the time from the start to the end of the job. */
  readonly run: Span | null;
}

/**
 * This function gives the spans of one job.
 *
 * @param record - The record of the job
 * @returns The spans
 */
export function jobSpans(record: JobMeasure): JobSpans {
  return { queue: spanOf(record.queued, record.started), run: spanOf(record.started, record.completed) };
}
