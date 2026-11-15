/**
 * The command line of the summary of the measures: `runner-dispatch-measures <log file>... [--level <p>]...`.
 *
 * The command reads the log lines of the program and takes each record `machine-measure/1` and `job-measure/1`. It writes
 * the summary `measure-summary/1` to stdout as JSON, and each problem to stderr.
 */
import { foldName, isJobMeasure, isMachineMeasure, summarizeMeasures, SUMMARY_LEVELS, type JobMeasure, type MachineMeasure } from "@mark1russell7/runner-dispatch";
import { errorMessage } from "@mark1russell7/text";
import type { CliIo } from "./cli.ts";

/** This text tells how to use the command. */
export const MEASURES_USAGE: string = [
  "Usage: runner-dispatch-measures <log file>... [--level <p>]...",
  "",
  "  <log file>  A file of the log lines of the dispatcher, with one JSON value on each line",
  `  --level     The level of a quantile, from 0 to 1. The default levels are ${SUMMARY_LEVELS.join(", ")}`,
  "  -h, --help  This text",
  "",
  "The summary measure-summary/1 goes to stdout as JSON. It has the bounds of each quantile of each time.",
  "Exit codes: 0 a summary, 1 a file that the command cannot read, 2 a bad command.",
].join("\n");

/** This record is a command: a summary of files, the help, or a bad command with its problem. */
export type MeasuresCommand =
  | { readonly kind: "summary"; readonly files: readonly string[]; readonly levels: readonly number[] | null }
  | { readonly kind: "help" }
  | { readonly kind: "usage"; readonly problem: string };

const LEVEL = /^(?:0(?:\.\d{1,6})?|1(?:\.0{1,6})?|\.\d{1,6})$/;

/**
 * This function reads the arguments of the command. The help comes first: with `-h` or `--help`, the function does
 * not examine the other arguments.
 *
 * @param args - The arguments after the name of the command
 * @returns The command
 */
export function parseMeasuresCommand(args: readonly string[]): MeasuresCommand {
  if (args.includes("-h") || args.includes("--help")) return { kind: "help" };
  const files: string[] = [];
  const levels: number[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--level") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) return { kind: "usage", problem: "The option --level has no value." };
      if (!LEVEL.test(value)) return { kind: "usage", problem: `The level ${value} is not a number from 0 to 1.` };
      levels.push(Number(value));
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) return { kind: "usage", problem: `The option ${arg} is not an option of the command.` };
    files.push(arg);
  }
  if (files.length === 0) return { kind: "usage", problem: "The command has no log file." };
  return { kind: "summary", files, levels: levels.length === 0 ? null : levels };
}

/** This record has the records of a log, and the counts of the lines that the summary does not use. */
export interface LogRecords {
  readonly machines: readonly MachineMeasure[];
  readonly jobs: readonly JobMeasure[];
  /** This field is the count of the lines that are not JSON, and of the records with a wrong field. */
  readonly bad: number;
  /** This field is the count of the records that are in the logs two times or more, after the first one. */
  readonly repeated: number;
}

/** This type has the two fields of a log line that the command reads. */
interface LineFields {
  readonly event?: unknown;
  readonly record?: unknown;
}

const lineFields = (value: unknown): LineFields | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as LineFields) : null;

/**
 * This function takes the records of the measures from the texts of logs. It is a function with no effect.
 * A line of another event is not a record. A machine is a record one time, and so is a job.
 * Thus two logs of the same program, or a log of two starts, do not count a record two times.
 *
 * @param texts - The texts of the logs, with one JSON value on each line
 * @returns The records, and the counts of the lines that the summary does not use
 */
export function recordsOfLogs(texts: readonly string[]): LogRecords {
  const machines = new Map<string, MachineMeasure>();
  const jobs = new Map<string, JobMeasure>();
  let bad = 0;
  let repeated = 0;
  for (const text of texts) {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line === "") continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        bad += 1;
        continue;
      }
      const fields = lineFields(value);
      if (fields === null || (fields.event !== "machine-measure" && fields.event !== "job-measure")) continue;
      const record = fields.record;
      if (fields.event === "machine-measure") {
        if (!isMachineMeasure(record)) bad += 1;
        else if (machines.has(record.machine)) repeated += 1;
        else machines.set(record.machine, record);
        continue;
      }
      if (!isJobMeasure(record)) {
        bad += 1;
        continue;
      }
      const key = JSON.stringify([foldName(record.repository), record.runId, record.runAttempt, record.jobId]);
      if (jobs.has(key)) repeated += 1;
      else jobs.set(key, record);
    }
  }
  return { machines: [...machines.values()], jobs: [...jobs.values()], bad, repeated };
}

/**
 * This function runs the command. It reads each file, takes the records and writes the summary.
 *
 * @param args - The arguments after the name of the command
 * @param io - The parts of the process: the files, stdout and stderr
 * @returns The exit code
 */
export async function measuresMain(args: readonly string[], io: CliIo): Promise<number> {
  const command = parseMeasuresCommand(args);
  if (command.kind === "help") {
    io.out(MEASURES_USAGE);
    return 0;
  }
  if (command.kind === "usage") {
    io.err(command.problem);
    io.err(MEASURES_USAGE);
    return 2;
  }
  const texts: string[] = [];
  for (const file of command.files) {
    try {
      texts.push(await io.readText(file));
    } catch (error) {
      io.err(`The command cannot read the file ${file}: ${errorMessage(error)}`);
      return 1;
    }
  }
  const records = recordsOfLogs(texts);
  if (records.bad > 0) io.err(`The summary does not use ${records.bad} lines: each is not JSON, or it has a record with a wrong field.`);
  if (records.repeated > 0) io.err(`The summary uses the first copy of ${records.repeated} records that are in the logs two times or more.`);
  const summary = summarizeMeasures(records, command.levels === null ? {} : { levels: command.levels });
  io.out(JSON.stringify(summary, null, 2));
  return 0;
}
