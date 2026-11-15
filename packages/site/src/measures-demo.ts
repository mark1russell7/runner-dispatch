/**
 * The logic of the demo of the measures. Each function has no effect, so the tests run it in Node.js.
 *
 * The demo makes a sample of jobs with known times. It makes the record `job-measure/1` of each job, as the reads of a
 * dispatcher see it, and it gives the records to `summarizeMeasures` of the package. Only the demo knows the true
 * times, so the page can show that each pair of bounds holds the true quantile.
 */
import { mulberry32, normalQuantile, seedOf, type Source } from "@mark1russell7/rigor-generators";
import { quantile } from "@mark1russell7/rigor-statistics";
import {
  JOB_MEASURE_FORMAT,
  jobSpans,
  summarizeMeasures,
  summarizeSpans,
  SUMMARY_LEVELS,
  type JobMeasure,
  type MeasureSummary,
  type Moment,
  type Span,
} from "@mark1russell7/runner-dispatch";

/** This record has the settings of a sample. */
export interface SampleSettings {
  /** This field is the seed of the random numbers. The same seed gives the same sample. */
  readonly seed: number;
  /** This field is the count of the jobs. */
  readonly jobs: number;
  /** This field is the time from the start of one pass of the dispatcher to the start of the next pass, in seconds. */
  readonly pass: number;
}

/** These are the settings of the first sample of the page. */
export const SAMPLE_SETTINGS: SampleSettings = Object.freeze({ seed: 1, jobs: 200, pass: 30 });

/** The reads of one pass take this time, in milliseconds. */
export const READ_MS = 1500;

/** The jobs of a sample come into the queue in this period, in milliseconds. */
export const PERIOD_MS = 6 * 3_600_000;

/** These are the two spans of a job that the demo shows. */
export const SPAN_NAMES = ["queue", "run"] as const;

/** This type is the name of a span of a job. */
export type SpanName = (typeof SPAN_NAMES)[number];

/** This record has the true times of a model of the jobs. The demo draws each time from a log-normal law. */
export interface TimeModel {
  /** This field is the shortest time, in milliseconds. */
  readonly floor: number;
  /** This field is the median of the time above the floor, in milliseconds. */
  readonly median: number;
  /** This field is the spread of the log-normal law. */
  readonly sigma: number;
}

/** These are the models of the sample: the boot of a machine before the job starts, and the job. */
export const MODELS: Readonly<Record<SpanName, TimeModel>> = Object.freeze({
  queue: { floor: 20_000, median: 25_000, sigma: 0.5 },
  run: { floor: 0, median: 240_000, sigma: 0.7 },
});

/** This record is one job of a sample: its record, and its true times, which only the demo knows. */
export interface SampleJob {
  readonly record: JobMeasure;
  /** This field has the true time of each span, in milliseconds. */
  readonly truth: Readonly<Record<SpanName, number>>;
}

/**
 * This function gives the moment of an event, as the passes of a dispatcher see it.
 * The pass `k` starts at `k * pass`. The first pass that starts at the event or later shows it.
 * Thus the event came after the start of the pass before, and before the end of the reads of the pass that showed it.
 *
 * @param time - The true time of the event, in milliseconds after the start of the dispatcher
 * @param pass - The time from the start of one pass to the start of the next pass, in milliseconds
 */
export function momentOf(time: number, pass: number): Moment {
  const k = Math.max(0, Math.ceil(time / pass));
  return { after: k === 0 ? null : (k - 1) * pass, at: k * pass + READ_MS };
}

const draw = (source: Source, model: TimeModel): number => {
  const u = Math.min(1 - 1e-12, Math.max(1e-12, source()));
  return Math.round(model.floor + model.median * Math.exp(model.sigma * normalQuantile(u)));
};

/**
 * This function makes a sample of jobs. Each job comes into the queue at a random time of the period.
 * Its queue time and its run time come from `MODELS`.
 *
 * @param settings - The seed, the count of the jobs and the time of a pass
 */
export function sampleJobs(settings: SampleSettings): readonly SampleJob[] {
  const source = mulberry32(seedOf(settings.seed));
  const pass = settings.pass * 1000;
  const jobs: SampleJob[] = [];
  for (let index = 0; index < settings.jobs; index += 1) {
    const queued = 1 + Math.floor(source() * PERIOD_MS);
    const queue = draw(source, MODELS.queue);
    const run = draw(source, MODELS.run);
    const runId = 1000 + index;
    jobs.push({
      record: {
        format: JOB_MEASURE_FORMAT,
        repository: "octo-org/app",
        runId,
        runAttempt: 1,
        jobId: 5000 + index,
        queued: momentOf(queued, pass),
        started: momentOf(queued + queue, pass),
        completed: momentOf(queued + queue + run, pass),
        runner: `rd-${runId}-1-${index.toString(16).padStart(8, "0")}`,
        last: "completed",
      },
      truth: { queue, run },
    });
  }
  return jobs;
}

/** This record is one level of the table: the bounds of the quantile from the records, and the true quantile. */
export interface LevelRow {
  readonly p: number;
  readonly low: number;
  /** This field is `null` when the high bound is not known. */
  readonly high: number | null;
  readonly truth: number;
  /** This field is `true` when the bounds hold the true quantile. */
  readonly holds: boolean;
}

/** This record is what the page shows for one span of a sample. */
export interface MeasureView {
  readonly span: SpanName;
  /** This field is the summary `measure-summary/1` of the records, from `summarizeMeasures`. */
  readonly summary: MeasureSummary;
  /** This field has the span of each job, from `jobSpans`. */
  readonly spans: readonly Span[];
  /** This field has the low bounds of the spans, in ascending order. */
  readonly lows: readonly number[];
  /** This field has the high bounds of the spans, in ascending order. An unknown bound is `Infinity`. */
  readonly highs: readonly number[];
  /** This field has the true times, in ascending order. */
  readonly truths: readonly number[];
  readonly rows: readonly LevelRow[];
}

const ascending = (values: readonly number[]): number[] => [...values].sort((a, b) => a - b);

/**
 * This function gives the row of one level: the bounds from `summarizeSpans`, and the true quantile at the nearest rank.
 *
 * @param view - The spans and the true times of a view
 * @param p - The level, from 0 to 1
 */
export function rowAt(view: Pick<MeasureView, "spans" | "truths">, p: number): LevelRow {
  const bounds = summarizeSpans(view.spans, [p])?.quantiles[0];
  const truth = quantile(view.truths, p, "nearest-rank");
  const low = bounds?.low ?? 0;
  const high = bounds?.high ?? null;
  return { p, low, high, truth, holds: low <= truth && (high === null || truth <= high) };
}

/**
 * This function gives the view of one span of a sample.
 *
 * @param jobs - The jobs of the sample
 * @param span - The span to show
 * @param levels - The levels of the table
 */
export function viewOf(jobs: readonly SampleJob[], span: SpanName, levels: readonly number[] = SUMMARY_LEVELS): MeasureView {
  const summary = summarizeMeasures({ machines: [], jobs: jobs.map((job) => job.record) }, { levels });
  const spans = jobs.flatMap((job) => {
    const each = jobSpans(job.record)[span];
    return each === null ? [] : [each];
  });
  const truths = ascending(jobs.map((job) => job.truth[span]));
  const view = { spans, truths };
  return {
    span,
    summary,
    spans,
    lows: ascending(spans.map((each) => each.low)),
    highs: ascending(spans.map((each) => each.high ?? Infinity)),
    truths,
    rows: levels.map((p) => rowAt(view, p)),
  };
}

/**
 * This function gives the ticks of an axis from 0 to `max`: steps of 1, 2 or 5 times a power of 10, at most `count` steps.
 *
 * @param max - The end of the axis, more than 0
 * @param count - The largest count of steps
 */
export function ticksOf(max: number, count = 5): readonly number[] {
  if (!(max > 0)) return [0];
  const rough = max / Math.max(1, count);
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = ([1, 2, 5, 10].map((each) => each * power).find((each) => each >= rough) ?? 10 * power);
  const ticks: number[] = [];
  for (let tick = 0; tick <= max + step * 1e-9; tick += step) ticks.push(Math.round(tick * 1e6) / 1e6);
  return ticks;
}

/**
 * This function writes a time in milliseconds for a chart: in seconds below 2 minutes, then in minutes.
 *
 * @param ms - The time
 */
export function shortTime(ms: number): string {
  if (ms < 120_000) return `${Math.round(ms / 1000)} s`;
  const minutes = ms / 60_000;
  return `${minutes < 10 ? Math.round(minutes * 10) / 10 : Math.round(minutes)} min`;
}

/**
 * This function writes a level as a percentile, for example `p50` or `p99.9`.
 *
 * @param p - The level, from 0 to 1
 */
export function levelName(p: number): string {
  return `p${Math.round(p * 1000) / 10}`;
}
