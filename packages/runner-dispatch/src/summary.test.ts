import { quantile } from "@mark1russell7/rigor-statistics";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isJobMeasure, isMachineMeasure, isMoment, JOB_MEASURE_FORMAT, MACHINE_MEASURE_FORMAT, type JobMeasure, type MachineMeasure, type Span } from "./measures.ts";
import { MEASURE_SUMMARY_FORMAT, SUMMARY_LEVELS, summarizeMeasures, summarizeSpans } from "./summary.ts";

const RUN = { repository: "octo/app", runId: 100, runAttempt: 1 };

const machine = (over: Partial<MachineMeasure> = {}): MachineMeasure => ({
  format: MACHINE_MEASURE_FORMAT,
  machine: "rd-100-1-00000000",
  size: "small",
  run: RUN,
  asked: 1_000,
  made: { after: 1_000, at: 31_000 },
  registered: { after: 31_000, at: 41_000 },
  started: { after: 41_000, at: 51_000 },
  ended: { after: 151_000, at: 161_000 },
  end: "job.completed",
  destroyed: { after: 161_000, at: 171_000 },
  ...over,
});

const job = (over: Partial<JobMeasure> = {}): JobMeasure => ({
  format: JOB_MEASURE_FORMAT,
  repository: "octo/app",
  runId: 100,
  runAttempt: 1,
  jobId: 7,
  queued: { after: null, at: 500 },
  started: { after: 41_000, at: 51_000 },
  completed: { after: 151_000, at: 161_000 },
  runner: "rd-100-1-00000000",
  last: "completed",
  ...over,
});

describe("summarizeSpans", () => {
  it("gives the bounds of each quantile at the nearest rank, and no high bound where an open span has the rank", () => {
    const spans: (Span | null)[] = [{ low: 0, high: 10 }, null, { low: 5, high: 5 }, { low: 20, high: null }];
    expect(summarizeSpans(spans, [0, 0.5, 0.9, 1])).toEqual({
      count: 3,
      open: 1,
      quantiles: [
        { p: 0, low: 0, high: 5 },
        { p: 0.5, low: 5, high: 10 },
        { p: 0.9, low: 20, high: null },
        { p: 1, low: 20, high: null },
      ],
    });
  });

  it("gives null when no record has the span, and uses the default levels", () => {
    expect(summarizeSpans([])).toBeNull();
    expect(summarizeSpans([null, null])).toBeNull();
    expect(summarizeSpans([{ low: 3, high: 4 }])?.quantiles.map((each) => each.p)).toEqual([...SUMMARY_LEVELS]);
  });

  it("refuses a level outside 0 to 1", () => {
    for (const level of [-0.1, 1.5, Number.NaN]) expect(() => summarizeSpans([{ low: 1, high: 2 }], [level])).toThrow(RangeError);
  });

  it("gives bounds that hold the true quantile of the times, for each set of spans that hold their times", () => {
    const span = fc
      .record({ time: fc.integer({ min: 0, max: 10_000_000 }), below: fc.integer({ min: 0, max: 100_000 }), above: fc.option(fc.integer({ min: 0, max: 100_000 }), { nil: null }) })
      .map(({ time, below, above }) => ({ time, span: { low: Math.max(0, time - below), high: above === null ? null : time + above } }));
    fc.assert(
      fc.property(fc.array(span, { minLength: 1, maxLength: 60 }), fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { maxLength: 6 }), (items, levels) => {
        const summary = summarizeSpans(
          items.map((each) => each.span),
          levels,
        );
        const times = items.map((each) => each.time);
        expect(summary?.count).toBe(items.length);
        for (const bounds of summary?.quantiles ?? []) {
          const truth = quantile(times, bounds.p, "nearest-rank");
          expect(bounds.low).toBeLessThanOrEqual(truth);
          if (bounds.high !== null) expect(truth).toBeLessThanOrEqual(bounds.high);
        }
      }),
    );
  });

  it("gives the exact quantile when each span is exact", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 1_000_000 }), { minLength: 1, maxLength: 40 }), fc.double({ min: 0, max: 1, noNaN: true }), (times, p) => {
        const [bounds] = summarizeSpans(
          times.map((time) => ({ low: time, high: time })),
          [p],
        )?.quantiles ?? [];
        const truth = quantile(times, p, "nearest-rank");
        expect(bounds).toEqual({ p, low: truth, high: truth });
      }),
    );
  });
});

describe("summarizeMeasures", () => {
  it("gives the summary of each span of the machines and of the jobs, the counts and the period", () => {
    const records = { machines: [machine(), machine({ machine: "rd-101-1-00000001", asked: 2_000, made: null, registered: null, end: "provider.failed" })], jobs: [job(), job({ jobId: 8, started: null, completed: null, last: "queued" })] };
    const summary = summarizeMeasures(records, { levels: [0.5] });
    expect(summary).toMatchObject({ format: MEASURE_SUMMARY_FORMAT, machines: 2, jobs: 2, period: { from: 500, to: 171_000 } });
    // The machine start: from the ask at 1 000 to the registration from 31 000 to 41 000.
    expect(summary.machine.start).toEqual({ count: 1, open: 0, quantiles: [{ p: 0.5, low: 30_000, high: 40_000 }] });
    // Two machines have a life: from 160 000 to 170 000, and from 159 000 to 169 000. The median is the lower one.
    expect(summary.machine.life).toEqual({ count: 2, open: 0, quantiles: [{ p: 0.5, low: 159_000, high: 169_000 }] });
    // The queued time of a job has no earliest time, thus its queue time has no high bound.
    expect(summary.job.queue).toEqual({ count: 1, open: 1, quantiles: [{ p: 0.5, low: 40_500, high: null }] });
    expect(summary.job.run).toEqual({ count: 1, open: 0, quantiles: [{ p: 0.5, low: 100_000, high: 120_000 }] });
  });

  it("gives null spans and no period when there is no record", () => {
    const summary = summarizeMeasures({ machines: [], jobs: [] });
    expect(summary.period).toBeNull();
    expect(Object.values(summary.machine).every((each) => each === null)).toBe(true);
    expect(Object.values(summary.job).every((each) => each === null)).toBe(true);
  });

  it("finds the period of many records", () => {
    const jobs = Array.from({ length: 200_000 }, (_, index) => job({ jobId: index + 1, queued: { after: null, at: index } }));
    expect(summarizeMeasures({ machines: [], jobs }, { levels: [] }).period).toEqual({ from: 0, to: 199_999 });
  });

  it("refuses a level outside 0 to 1", () => {
    expect(() => summarizeMeasures({ machines: [], jobs: [] }, { levels: [2] })).toThrow(RangeError);
  });
});

describe("the guards of the records", () => {
  it("accepts the records that the dispatcher writes, and a JSON copy of them", () => {
    expect(isMachineMeasure(machine())).toBe(true);
    expect(isMachineMeasure(JSON.parse(JSON.stringify(machine({ size: null, asked: null, end: null, destroyed: null }))))).toBe(true);
    expect(isJobMeasure(job())).toBe(true);
    expect(isJobMeasure(JSON.parse(JSON.stringify(job({ runner: null, started: null, completed: null, last: "in_progress" }))))).toBe(true);
    expect(isMoment({ after: null, at: 0 })).toBe(true);
  });

  it("refuses a value with a wrong field", () => {
    const machines: unknown[] = [
      null,
      [],
      { ...machine(), format: "machine-measure/2" },
      { ...machine(), machine: 7 },
      { ...machine(), size: 1 },
      { ...machine(), run: { ...RUN, repository: "app" } },
      { ...machine(), run: { ...RUN, runId: 0 } },
      { ...machine(), asked: "1000" },
      { ...machine(), end: "job.lost-forever" },
      { ...machine(), made: { after: 5, at: 4 } },
      { ...machine(), destroyed: { at: Number.POSITIVE_INFINITY, after: null } },
    ];
    for (const value of machines) expect(isMachineMeasure(value), JSON.stringify(value)).toBe(false);
    const jobs: unknown[] = [
      job({ queued: null as never }),
      { ...job(), format: MACHINE_MEASURE_FORMAT },
      { ...job(), repository: "octo" },
      { ...job(), jobId: 1.5 },
      { ...job(), last: "done" },
      { ...job(), runner: 3 },
      { ...job(), completed: { after: "1", at: 2 } },
    ];
    for (const value of jobs) expect(isJobMeasure(value), JSON.stringify(value)).toBe(false);
    for (const value of [undefined, { at: null, after: null }, { at: 1 }]) expect(isMoment(value)).toBe(false);
  });
});
