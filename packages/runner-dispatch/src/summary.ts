import { quantileSorted, sorted } from "@mark1russell7/rigor-statistics";
import { jobSpans, machineSpans, type JobMeasure, type MachineMeasure, type Moment, type Span } from "./measures.ts";

/** This constant is the format of a summary of the measures. */
export const MEASURE_SUMMARY_FORMAT = "measure-summary/1";

/** This constant is the default levels of the quantiles of a summary: the median, the 90th percentile and the 99th percentile. */
export const SUMMARY_LEVELS: readonly number[] = Object.freeze([0.5, 0.9, 0.99]);

/**
 * This record is the bounds of one quantile of the times. The true quantile is from `low` to `high`.
 * The quantile is the nearest rank: the value at the rank `ceil(p * n)` of the `n` sorted times.
 */
export interface QuantileBounds {
  /** This field is the level of the quantile, from 0 to 1. */
  readonly p: number;
  /** This field is the lowest value of the quantile, in milliseconds. */
  readonly low: number;
  /** This field is the highest value of the quantile, in milliseconds, or `null` when too many times have no high bound. */
  readonly high: number | null;
}

/** This record is the summary of one span over many records. */
export interface SpanSummary {
  /** This field is the count of the records that have the span. */
  readonly count: number;
  /** This field is the count of the spans that have no high bound. */
  readonly open: number;
  /** This field has the bounds of each quantile, in the order of the levels. */
  readonly quantiles: readonly QuantileBounds[];
}

/** This record has the summary of each span of the life of a machine. A field is `null` when no record has the span. */
export interface MachineSummary {
  readonly start: SpanSummary | null;
  readonly boot: SpanSummary | null;
  readonly idle: SpanSummary | null;
  readonly job: SpanSummary | null;
  readonly teardown: SpanSummary | null;
  readonly life: SpanSummary | null;
}

/** This record has the summary of each span of a job. A field is `null` when no record has the span. */
export interface JobSummary {
  readonly queue: SpanSummary | null;
  readonly run: SpanSummary | null;
}

/** This record is the time of the first event and of the last event of the records, in milliseconds. */
export interface Period {
  readonly from: number;
  readonly to: number;
}

/** This record is the summary of the records of the machines and of the jobs. */
export interface MeasureSummary {
  /** This field is the format `measure-summary/1`. */
  readonly format: typeof MEASURE_SUMMARY_FORMAT;
  /** This field is the count of the records of the machines. */
  readonly machines: number;
  /** This field is the count of the records of the jobs. */
  readonly jobs: number;
  /** This field is the period of the records, or `null` when there is no record. */
  readonly period: Period | null;
  readonly machine: MachineSummary;
  readonly job: JobSummary;
}

/** This record has the records of the machines and of the jobs. */
export interface MeasureRecords {
  readonly machines: readonly MachineMeasure[];
  readonly jobs: readonly JobMeasure[];
}

/** This record has the options of a summary. */
export interface SummaryOptions {
  /** This field has the levels of the quantiles, each from 0 to 1. The default is `SUMMARY_LEVELS`. */
  readonly levels?: readonly number[];
}

const checkedLevels = (levels: readonly number[]): readonly number[] => {
  for (const p of levels) if (!(p >= 0 && p <= 1)) throw new RangeError(`summarizeSpans: each level is from 0 to 1, not ${p}.`);
  return levels;
};

/**
 * This function gives the summary of one span over many records. It is a function with no effect.
 * Each span holds its true time. Then each quantile of the lows and of the highs holds the true quantile of the times.
 * The nearest rank keeps this, because a sort keeps the order of each pair of values.
 *
 * @param spans - The span of each record, or `null` for a record that does not have the span
 * @param levels - The levels of the quantiles, each from 0 to 1
 * @returns The summary, or `null` when no record has the span
 */
export function summarizeSpans(spans: readonly (Span | null)[], levels: readonly number[] = SUMMARY_LEVELS): SpanSummary | null {
  checkedLevels(levels);
  const known = spans.filter((span): span is Span => span !== null);
  if (known.length === 0) return null;
  const lows = sorted(known.map((span) => span.low));
  // A span with no high bound has the high bound infinity. A quantile at infinity has no high bound.
  const highs = sorted(known.map((span) => span.high ?? Number.POSITIVE_INFINITY));
  const quantiles = levels.map((p): QuantileBounds => {
    const high = quantileSorted(highs, p, "nearest-rank");
    return { p, low: quantileSorted(lows, p, "nearest-rank"), high: Number.isFinite(high) ? high : null };
  });
  return { count: known.length, open: known.filter((span) => span.high === null).length, quantiles };
}

const momentTimes = (moment: Moment | null): readonly number[] => (moment === null ? [] : moment.after === null ? [moment.at] : [moment.after, moment.at]);

const timesOf = (records: MeasureRecords): readonly number[] => [
  ...records.machines.flatMap((record) => [
    ...(record.asked === null ? [] : [record.asked]),
    ...[record.made, record.registered, record.started, record.ended, record.destroyed].flatMap(momentTimes),
  ]),
  ...records.jobs.flatMap((record) => [record.queued, record.started, record.completed].flatMap(momentTimes)),
];

/**
 * This function gives the summary of the records of the machines and of the jobs. It is a function with no effect.
 *
 * @param records - The records, as the dispatcher writes them to its log
 * @param options - The levels of the quantiles
 * @returns The summary `measure-summary/1`
 */
export function summarizeMeasures(records: MeasureRecords, options: SummaryOptions = {}): MeasureSummary {
  const levels = checkedLevels(options.levels ?? SUMMARY_LEVELS);
  const machines = records.machines.map(machineSpans);
  const jobs = records.jobs.map(jobSpans);
  const times = timesOf(records);
  return {
    format: MEASURE_SUMMARY_FORMAT,
    machines: records.machines.length,
    jobs: records.jobs.length,
    // A reduce, not a spread: a log of many records has more times than a call takes arguments.
    period: times.length === 0 ? null : { from: times.reduce((a, b) => Math.min(a, b)), to: times.reduce((a, b) => Math.max(a, b)) },
    machine: {
      start: summarizeSpans(machines.map((each) => each.start), levels),
      boot: summarizeSpans(machines.map((each) => each.boot), levels),
      idle: summarizeSpans(machines.map((each) => each.idle), levels),
      job: summarizeSpans(machines.map((each) => each.job), levels),
      teardown: summarizeSpans(machines.map((each) => each.teardown), levels),
      life: summarizeSpans(machines.map((each) => each.life), levels),
    },
    job: {
      queue: summarizeSpans(jobs.map((each) => each.queue), levels),
      run: summarizeSpans(jobs.map((each) => each.run), levels),
    },
  };
}
