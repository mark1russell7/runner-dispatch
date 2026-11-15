import { isJobMeasure, jobSpans, MEASURE_SUMMARY_FORMAT, SUMMARY_LEVELS } from "@mark1russell7/runner-dispatch";
import { describe, expect, it } from "vitest";
import { levelName, momentOf, READ_MS, rowAt, SAMPLE_SETTINGS, sampleJobs, shortTime, SPAN_NAMES, ticksOf, viewOf } from "./measures-demo.ts";

describe("momentOf", () => {
  it("gives the start of the pass before and the end of the reads of the pass that shows the event", () => {
    expect(momentOf(1, 30_000)).toEqual({ after: 0, at: 30_000 + READ_MS });
    expect(momentOf(30_000, 30_000)).toEqual({ after: 0, at: 30_000 + READ_MS });
    expect(momentOf(30_001, 30_000)).toEqual({ after: 30_000, at: 60_000 + READ_MS });
    expect(momentOf(0, 30_000)).toEqual({ after: null, at: READ_MS });
  });

  it("holds the true time of each event", () => {
    for (const pass of [5_000, 30_000, 120_000]) {
      for (let time = 1; time < 400_000; time += 7_919) {
        const moment = momentOf(time, pass);
        expect(moment.after ?? -Infinity).toBeLessThan(time);
        expect(moment.at).toBeGreaterThanOrEqual(time);
      }
    }
  });
});

describe("sampleJobs", () => {
  it("gives the same records for the same seed, and valid records", () => {
    const jobs = sampleJobs(SAMPLE_SETTINGS);
    expect(jobs.length).toBe(SAMPLE_SETTINGS.jobs);
    expect(sampleJobs(SAMPLE_SETTINGS)).toEqual(jobs);
    expect(sampleJobs({ ...SAMPLE_SETTINGS, seed: 2 })).not.toEqual(jobs);
    for (const job of jobs) expect(isJobMeasure(job.record)).toBe(true);
  });

  it("gives spans that hold the true times of each job", () => {
    for (const pass of [5, 30, 120]) {
      for (const job of sampleJobs({ seed: pass, jobs: 300, pass })) {
        const spans = jobSpans(job.record);
        for (const name of SPAN_NAMES) {
          const span = spans[name];
          expect(span).not.toBeNull();
          expect(span?.low).toBeLessThanOrEqual(job.truth[name]);
          expect(span?.high).toBeGreaterThanOrEqual(job.truth[name]);
        }
      }
    }
  });
});

describe("viewOf", () => {
  it("gives the summary of the package, and bounds that hold each true quantile", () => {
    for (const seed of [1, 2, 3]) {
      for (const pass of [5, 30, 120]) {
        const jobs = sampleJobs({ seed, jobs: 200, pass });
        for (const span of SPAN_NAMES) {
          const view = viewOf(jobs, span);
          expect(view.summary).toMatchObject({ format: MEASURE_SUMMARY_FORMAT, machines: 0, jobs: 200 });
          expect(view.rows.map((row) => row.p)).toEqual(SUMMARY_LEVELS);
          expect(view.rows.every((row) => row.holds)).toBe(true);
          expect(view.summary.job[span]?.quantiles).toEqual(view.rows.map(({ p, low, high }) => ({ p, low, high })));
          for (let p = 0.01; p <= 1; p += 0.01) expect(rowAt(view, p).holds).toBe(true);
        }
      }
    }
  });

  it("gives narrow bounds for short passes and wide bounds for long passes", () => {
    const width = (pass: number): number => {
      const row = viewOf(sampleJobs({ seed: 1, jobs: 200, pass }), "queue").rows[0];
      return (row?.high ?? Infinity) - (row?.low ?? 0);
    };
    expect(width(5)).toBeLessThan(width(30));
    expect(width(30)).toBeLessThan(width(120));
    expect(width(120)).toBeLessThanOrEqual(2 * 120_000 + 2 * READ_MS);
  });

  it("sorts the bounds and the true times", () => {
    const view = viewOf(sampleJobs(SAMPLE_SETTINGS), "run");
    for (const list of [view.lows, view.highs, view.truths]) expect([...list].sort((a, b) => a - b)).toEqual(list);
    expect(view.lows.length).toBe(SAMPLE_SETTINGS.jobs);
  });
});

describe("the helpers of the chart", () => {
  it("gives the ticks of an axis", () => {
    expect(ticksOf(100_000)).toEqual([0, 20_000, 40_000, 60_000, 80_000, 100_000]);
    expect(ticksOf(95)).toEqual([0, 20, 40, 60, 80]);
    expect(ticksOf(7, 4)).toEqual([0, 2, 4, 6]);
    expect(ticksOf(0)).toEqual([0]);
  });

  it("writes the times and the levels", () => {
    expect(shortTime(45_400)).toBe("45 s");
    expect(shortTime(150_000)).toBe("2.5 min");
    expect(shortTime(1_500_000)).toBe("25 min");
    expect(levelName(0.5)).toBe("p50");
    expect(levelName(0.99)).toBe("p99");
    expect(levelName(0.999)).toBe("p99.9");
  });
});
