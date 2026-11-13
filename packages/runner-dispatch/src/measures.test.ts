import { fakeClock } from "@mark1russell7/algebra/clock";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createDispatcher, type Dispatcher, type PassReport } from "./dispatcher.ts";
import type { MachineTimes } from "./lifecycle.ts";
import {
  EMPTY_MEASURES,
  jobSpans,
  machineSpans,
  noteReport,
  spanOf,
  type JobMeasure,
  type MachineMeasure,
  type MeasureState,
  type Moment,
  type Span,
} from "./measures.ts";
import type { TrustRules } from "./policy.ts";
import type { JobSource, MachineProvider } from "./ports.ts";
import type { RunRecord } from "./records.ts";
import type { DispatchSettings } from "./settings.ts";
import { countingSuffix, fakeWorld, type FakeWorld, type WorldFault, type WorldTimes } from "./testing.ts";

const REPO = "octo/app";
const RULES: TrustRules = { repositories: [REPO], events: ["push"], actors: ["octo"] };
const TIMES: MachineTimes = { make: 60, register: 60, idle: 30, job: 600, retry: 5, retryMax: 40, pass: 10 };
const SETTINGS: DispatchSettings = { prefix: "rd", capacity: 3, sizes: ["small"], standard: "small" };
const M0 = "rd-100-1-00000000";

const runRecord = (runId: number): RunRecord => ({
  repository: REPO,
  runId,
  runAttempt: 1,
  event: "push",
  headRepository: REPO,
  actor: "octo",
  triggeringActor: "octo",
});

interface StageOptions {
  readonly world?: WorldTimes;
  /** This field is the time of each read of the provider and of the source, in milliseconds. */
  readonly lag?: number;
  readonly fault?: (request: string, target: string) => WorldFault | null;
}

/** This type is a fake world with a dispatcher and the measures of its passes. */
interface Stage {
  readonly clock: ReturnType<typeof fakeClock>;
  readonly world: FakeWorld;
  readonly reports: PassReport[];
  readonly machines: MachineMeasure[];
  readonly jobs: JobMeasure[];
  /** This field is the time that each job entered the world, by its id. */
  readonly created: Map<number, number>;
  measures: MeasureState;
  restart(): void;
  turn(ms: number): Promise<PassReport>;
}

const stage = (options: StageOptions = {}): Stage => {
  const clock = fakeClock(0);
  const lag = options.lag ?? 0;
  const world = fakeWorld({ clock, times: options.world ?? { boot: 2000, connect: 1000, destroy: 500 }, faults: options.fault });
  const wait = async (): Promise<void> => {
    if (lag > 0) await clock.advance(lag);
  };
  // Each read takes the time `lag`: the world goes on during the read.
  const source: JobSource = {
    view: async (repository, runs, signal) => {
      await wait();
      return world.source.view(repository, runs, signal);
    },
    register: (request, signal) => world.source.register(request, signal),
    remove: (repository, runnerId, signal) => world.source.remove(repository, runnerId, signal),
  };
  const provider: MachineProvider = {
    make: (request, signal) => world.provider.make(request, signal),
    machines: async (signal) => {
      await wait();
      return world.provider.machines(signal);
    },
    destroy: (name, signal) => world.provider.destroy(name, signal),
  };
  const suffix = countingSuffix();
  const signal = new AbortController().signal;
  let dispatcher: Dispatcher;
  const made: Stage = {
    clock,
    world,
    reports: [],
    machines: [],
    jobs: [],
    created: new Map(),
    measures: EMPTY_MEASURES,
    restart(): void {
      dispatcher = createDispatcher({ rules: RULES, times: TIMES, settings: SETTINGS, source, provider, now: () => clock.now(), suffix, stopped: () => false });
    },
    async turn(ms: number): Promise<PassReport> {
      const report = await dispatcher.pass(signal);
      made.reports.push(report);
      const note = noteReport(made.measures, report);
      made.measures = note.state;
      made.machines.push(...note.machines);
      made.jobs.push(...note.jobs);
      await clock.advance(ms);
      return report;
    },
  };
  made.restart();
  return made;
};

const addRun = (at: Stage, runId: number, durations: readonly number[]): void => {
  const ids = at.world.addRun(
    runRecord(runId),
    durations.map((duration) => ({ labels: [`run-${String(runId)}-1`], duration })),
  );
  for (const id of ids) at.created.set(id, at.clock.now());
};

/** This function tells if a time is in a moment. */
const within = (time: number, moment: Moment | null): boolean => moment !== null && (moment.after === null || moment.after <= time) && time <= moment.at;

/** This function tells if a time from one event to another is in a span. */
const spans = (time: number, span: Span | null): boolean => span !== null && span.low <= time && (span.high === null || time <= span.high);

describe("spanOf", () => {
  it("gives the bounds of the time between two moments", () => {
    expect(spanOf({ after: 0, at: 5 }, { after: 20, at: 30 })).toEqual({ low: 15, high: 30 });
    expect(spanOf(10, { after: 20, at: 30 })).toEqual({ low: 10, high: 20 });
    expect(spanOf(10, { after: 10, at: 10 })).toEqual({ low: 0, high: 0 });
  });

  it("gives no high bound when the first time has no earliest time, and a low bound of 0 at least", () => {
    expect(spanOf({ after: null, at: 5 }, { after: 3, at: 30 })).toEqual({ low: 0, high: null });
    expect(spanOf({ after: 0, at: 5 }, { after: null, at: 30 })).toEqual({ low: 0, high: 30 });
  });

  it("gives null when a record does not have one of the two events", () => {
    expect(spanOf(null, { after: 0, at: 1 })).toBeNull();
    expect(spanOf(0, null)).toBeNull();
  });

  it("holds the true time for each pair of moments that hold their events", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 0, max: 1000 }),
        (first, gap, a, b, c, d) => {
          const from: Moment = { after: first - a, at: first + b };
          const to: Moment = { after: first + gap - c, at: first + gap + d };
          return spans(gap, spanOf(from, to));
        },
      ),
    );
  });
});

describe("noteReport: one job", () => {
  it("gives the record of the machine and of the job, with the bounds of each time", async () => {
    const at = stage();
    addRun(at, 100, [4000]);
    await at.turn(5000);
    expect(at.machines).toEqual([]);
    expect(at.measures.machines.map((record) => [record.machine, record.asked])).toEqual([[M0, 0]]);
    await at.turn(5000);
    await at.turn(5000);
    await at.turn(5000);

    expect(at.machines).toEqual([
      {
        format: "machine-measure/1",
        machine: M0,
        size: "small",
        run: { repository: REPO, runId: 100, runAttempt: 1 },
        asked: 0,
        made: { after: 0, at: 5000 },
        registered: { after: 0, at: 5000 },
        started: { after: 0, at: 5000 },
        ended: { after: 5000, at: 10_000 },
        end: "job.completed",
        destroyed: { after: 10_000, at: 15_000 },
      },
    ]);
    const [job] = at.jobs;
    expect(job).toMatchObject({
      format: "job-measure/1",
      repository: REPO,
      runId: 100,
      runAttempt: 1,
      queued: { after: null, at: 0 },
      started: { after: 0, at: 5000 },
      completed: { after: 5000, at: 10_000 },
      runner: M0,
      last: "completed",
    });
    expect(at.measures).toMatchObject({ machines: [], jobs: [] });

    // The world: the machine operated at 2 s, its runner connected and took the job at 3 s, and the job ended at 7 s.
    const [machine] = at.machines;
    if (machine === undefined || job === undefined) throw new Error("The stage has no record.");
    expect(machineSpans(machine)).toEqual({
      start: { low: 0, high: 5000 },
      boot: { low: 0, high: 5000 },
      idle: { low: 0, high: 5000 },
      job: { low: 0, high: 10_000 },
      teardown: { low: 0, high: 10_000 },
      life: { low: 10_000, high: 15_000 },
    });
    expect(jobSpans(job)).toEqual({ queue: { low: 0, high: null }, run: { low: 0, high: 10_000 } });
  });

  it("puts the end of the reads in the latest time, when a read takes time", async () => {
    const at = stage({ lag: 700 });
    addRun(at, 100, [4000]);
    const first = await at.turn(5000);
    expect([first.at, first.read]).toEqual([0, 1400]);
    expect(at.measures.machines[0]?.asked).toBe(1400);
  });

  it("does not use a failed read as a bound, and keeps the record of a machine open with no read of the provider", async () => {
    let failing = false;
    const at = stage({ fault: (request) => (failing && (request === "view" || request === "machines") ? "refuse" : null) });
    addRun(at, 100, [4000]);
    await at.turn(5000);
    failing = true;
    const second = await at.turn(5000);
    expect([second.listed, second.viewed]).toEqual([false, []]);
    expect(at.measures.machines.map((record) => record.machine)).toEqual([M0]);
    failing = false;
    await at.turn(5000);
    // The read at 5 s failed. Thus the bounds of the events go from the read at 0 s to the read at 10 s.
    expect(at.measures.machines[0]).toMatchObject({ made: { after: 0, at: 10_000 }, registered: { after: 0, at: 10_000 } });
  });

  it("keeps the first record of each event of a machine after a new start of the dispatcher", async () => {
    const at = stage();
    addRun(at, 100, [12_000]);
    await at.turn(5000);
    await at.turn(5000);
    at.restart();
    const third = await at.turn(5000);
    expect(third.adopted).toEqual([M0]);
    expect(at.measures.machines[0]).toMatchObject({ asked: 0, made: { after: 0, at: 5000 }, started: { after: 0, at: 5000 } });
  });
});

describe("noteReport: random worlds", () => {
  const scenario = fc.record({
    runs: fc.array(
      fc.record({
        at: fc.integer({ min: 0, max: 60 }).map((seconds) => seconds * 1000),
        durations: fc.array(fc.integer({ min: 0, max: 20_000 }), { minLength: 1, maxLength: 3 }),
      }),
      { minLength: 1, maxLength: 4 },
    ),
    world: fc.record({ boot: fc.integer({ min: 0, max: 8000 }), connect: fc.integer({ min: 0, max: 4000 }), destroy: fc.integer({ min: 0, max: 4000 }) }),
    period: fc.constantFrom(1000, 3000, 5000, 10_000),
    lag: fc.constantFrom(0, 0, 300, 1500),
    faults: fc.array(fc.constantFrom<WorldFault | null>(null, null, null, "refuse", "lose"), { maxLength: 40 }),
    restarts: fc.array(fc.integer({ min: 0, max: 90 }).map((seconds) => seconds * 1000), { maxLength: 2 }),
  });
  type Scenario = typeof scenario extends fc.Arbitrary<infer T> ? T : never;
  const LIMIT = 2_000_000;

  const play = async (given: Scenario): Promise<Stage> => {
    let used = 0;
    const at = stage({
      world: given.world,
      lag: given.lag,
      fault: () => {
        used += 1;
        return given.faults[used - 1] ?? null;
      },
    });
    const pending = given.runs.map((run, index) => ({ ...run, runId: 100 + index })).sort((a, b) => a.at - b.at);
    const restarts = [...given.restarts].sort((a, b) => a - b);
    while (at.clock.now() <= LIMIT) {
      const now = at.clock.now();
      while (pending[0] !== undefined && pending[0].at <= now) {
        const run = pending.shift();
        if (run !== undefined) addRun(at, run.runId, run.durations);
      }
      while (restarts[0] !== undefined && restarts[0] <= now) {
        restarts.shift();
        at.restart();
      }
      await at.turn(given.period);
      const done = at.world.jobs().every((job) => job.status === "completed") && at.world.machines().length === 0;
      if (pending.length === 0 && used >= given.faults.length && done && at.measures.machines.length === 0 && at.measures.jobs.length === 0) break;
    }
    return at;
  };

  /** This function gives the time of the first event of a kind for a machine or a job. */
  const eventOf = (at: Stage, kinds: readonly string[], match: { name?: string; jobId?: number }): number | undefined =>
    at.world
      .events()
      .find((event) => kinds.includes(event.kind) && (match.name === undefined || event.name === match.name) && (match.jobId === undefined || event.jobId === match.jobId))?.at;

  it("gives bounds that hold the true time of each event and each span, with slow reads, failed reads and new starts", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (given) => {
        const at = await play(given);
        expect(at.measures.machines).toEqual([]);
        expect(at.measures.jobs).toEqual([]);
        // Each job of the world has one record.
        expect(at.jobs.map((job) => job.jobId).sort((a, b) => a - b)).toEqual(
          at.world
            .jobs()
            .map((job) => job.jobId)
            .sort((a, b) => a - b),
        );

        for (const record of at.machines) {
          const asked = eventOf(at, ["asked"], { name: record.machine });
          if (record.asked !== null) expect(record.asked).toBe(asked);
          const truth: [Moment | null, number | undefined][] = [
            [record.made, eventOf(at, ["operating"], { name: record.machine })],
            [record.registered, eventOf(at, ["online"], { name: record.machine })],
            [record.started, eventOf(at, ["job-started", "job-refused"], { name: record.machine })],
            [record.destroyed, eventOf(at, ["gone"], { name: record.machine })],
          ];
          if (record.end === "job.completed") truth.push([record.ended, eventOf(at, ["job-ended", "job-refused", "job-lost"], { name: record.machine })]);
          for (const [moment, time] of truth) {
            if (moment === null) continue;
            expect(time).toBeDefined();
            expect(within(time ?? Number.NaN, moment)).toBe(true);
          }
          const operating = eventOf(at, ["operating"], { name: record.machine });
          const online = eventOf(at, ["online"], { name: record.machine });
          const spansOf = machineSpans(record);
          if (asked !== undefined && online !== undefined && spansOf.start !== null) expect(spans(online - asked, spansOf.start)).toBe(true);
          if (asked !== undefined && operating !== undefined && spansOf.boot !== null) expect(spans(operating - asked, spansOf.boot)).toBe(true);
        }

        for (const record of at.jobs) {
          const created = at.created.get(record.jobId);
          expect(within(created ?? Number.NaN, record.queued)).toBe(true);
          const started = eventOf(at, ["job-started", "job-refused"], { jobId: record.jobId });
          const ended = eventOf(at, ["job-ended", "job-refused", "job-lost"], { jobId: record.jobId });
          if (record.started !== null) expect(within(started ?? Number.NaN, record.started)).toBe(true);
          if (ended !== undefined) expect(within(ended, record.completed)).toBe(true);
          const spansOf = jobSpans(record);
          if (created !== undefined && started !== undefined && spansOf.queue !== null) expect(spans(started - created, spansOf.queue)).toBe(true);
          if (started !== undefined && ended !== undefined && spansOf.run !== null) expect(spans(ended - started, spansOf.run)).toBe(true);
        }
      }),
      { numRuns: 300, seed: 20261113 },
    );
  }, 120_000);
});
