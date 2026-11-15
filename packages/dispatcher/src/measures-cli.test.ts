import { JOB_MEASURE_FORMAT, MACHINE_MEASURE_FORMAT, summarizeMeasures, type JobMeasure, type MachineMeasure } from "@mark1russell7/runner-dispatch";
import { describe, expect, it } from "vitest";
import type { CliIo } from "./cli.ts";
import { MEASURES_USAGE, measuresMain, parseMeasuresCommand, recordsOfLogs } from "./measures-cli.ts";

const machine = (name: string, asked = 1_000): MachineMeasure => ({
  format: MACHINE_MEASURE_FORMAT,
  machine: name,
  size: "small",
  run: { repository: "octo/app", runId: 100, runAttempt: 1 },
  asked,
  made: { after: asked, at: asked + 30_000 },
  registered: { after: asked + 30_000, at: asked + 40_000 },
  started: null,
  ended: null,
  end: "job.none",
  destroyed: { after: asked + 90_000, at: asked + 100_000 },
});

const job = (jobId: number, repository = "octo/app"): JobMeasure => ({
  format: JOB_MEASURE_FORMAT,
  repository,
  runId: 100,
  runAttempt: 1,
  jobId,
  queued: { after: null, at: 500 },
  started: { after: 41_000, at: 51_000 },
  completed: { after: 151_000, at: 161_000 },
  runner: "rd-100-1-00000000",
  last: "completed",
});

const line = (value: unknown): string => JSON.stringify(value);

const fakeIo = (files: Readonly<Record<string, string>>) => {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    env: {},
    readText: (path) => (path in files ? Promise.resolve(files[path] as string) : Promise.reject(new Error(`ENOENT: no such file, open '${path}'`))),
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  };
  return { io, out, err };
};

describe("parseMeasuresCommand", () => {
  it("reads the files and the levels", () => {
    expect(parseMeasuresCommand(["a.log", "b.log"])).toEqual({ kind: "summary", files: ["a.log", "b.log"], levels: null });
    expect(parseMeasuresCommand(["--level", "0.5", "a.log", "--level", "1", "--level", ".95", "--level", "0"])).toEqual({ kind: "summary", files: ["a.log"], levels: [0.5, 1, 0.95, 0] });
    expect(parseMeasuresCommand(["a.log", "--help", "--bad"])).toEqual({ kind: "help" });
    expect(parseMeasuresCommand(["-h"])).toEqual({ kind: "help" });
  });

  it("gives the problem of a bad command", () => {
    const cases: [readonly string[], string][] = [
      [[], "The command has no log file."],
      [["--level", "0.5"], "The command has no log file."],
      [["a.log", "--level"], "The option --level has no value."],
      [["a.log", "--level", "--level"], "The option --level has no value."],
      [["a.log", "--level", "1.5"], "The level 1.5 is not a number from 0 to 1."],
      [["a.log", "--level", "-0.1"], "The level -0.1 is not a number from 0 to 1."],
      [["a.log", "--level", "half"], "The level half is not a number from 0 to 1."],
      [["a.log", "--levels", "0.5"], "The option --levels is not an option of the command."],
    ];
    for (const [args, problem] of cases) expect(parseMeasuresCommand(args), args.join(" ")).toEqual({ kind: "usage", problem });
  });
});

describe("recordsOfLogs", () => {
  it("takes the records of the measures, and skips the lines of other events and the empty lines", () => {
    const text = [line({ event: "pass", report: {} }), "", line({ event: "machine-measure", record: machine("m-1"), spans: {} }), "  ", line({ event: "job-measure", record: job(7), spans: {} })].join("\r\n");
    expect(recordsOfLogs([text])).toEqual({ machines: [machine("m-1")], jobs: [job(7)], bad: 0, repeated: 0 });
  });

  it("counts a line that is not JSON and a record with a wrong field, and does not use them", () => {
    const text = ["{\"event\":", line({ event: "job-measure", record: { ...job(7), jobId: "7" } }), line({ event: "machine-measure" }), line([1, 2]), line({ event: "job-measure", record: job(8) })].join("\n");
    expect(recordsOfLogs([text])).toEqual({ machines: [], jobs: [job(8)], bad: 3, repeated: 0 });
  });

  it("uses the first copy of a record that is in two logs, and the case of a repository name does not make a new job", () => {
    const first = [line({ event: "machine-measure", record: machine("m-1") }), line({ event: "job-measure", record: job(7) })].join("\n");
    const second = [line({ event: "machine-measure", record: machine("m-1", 5_000) }), line({ event: "job-measure", record: job(7, "Octo/App") }), line({ event: "job-measure", record: job(9) })].join("\n");
    expect(recordsOfLogs([first, second])).toEqual({ machines: [machine("m-1")], jobs: [job(7), job(9)], bad: 0, repeated: 2 });
  });
});

describe("measuresMain", () => {
  const log = [line({ event: "machine-measure", record: machine("m-1") }), line({ event: "machine-measure", record: machine("m-2", 3_000) }), line({ event: "job-measure", record: job(7) })].join("\n");

  it("writes the summary of the records of each file as JSON, and ends with the exit code 0", async () => {
    const { io, out, err } = fakeIo({ "a.log": log, "b.log": line({ event: "job-measure", record: job(8) }) });
    expect(await measuresMain(["a.log", "b.log", "--level", "0.5"], io)).toBe(0);
    expect(err).toEqual([]);
    expect(JSON.parse(out.join("\n"))).toEqual(summarizeMeasures({ machines: [machine("m-1"), machine("m-2", 3_000)], jobs: [job(7), job(8)] }, { levels: [0.5] }));
  });

  it("tells about the lines that the summary does not use", async () => {
    const { io, out, err } = fakeIo({ "a.log": `${log}\nnot json\n${line({ event: "job-measure", record: job(7) })}` });
    expect(await measuresMain(["a.log"], io)).toBe(0);
    expect(err).toEqual([
      "The summary does not use 1 lines: each is not JSON, or it has a record with a wrong field.",
      "The summary uses the first copy of 1 records that are in the logs two times or more.",
    ]);
    expect(JSON.parse(out.join("\n"))).toMatchObject({ format: "measure-summary/1", machines: 2, jobs: 1 });
  });

  it("ends with the exit code 1 for a file that it cannot read, and writes no summary", async () => {
    const { io, out, err } = fakeIo({ "a.log": log });
    expect(await measuresMain(["a.log", "gone.log"], io)).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual(["The command cannot read the file gone.log: ENOENT: no such file, open 'gone.log'"]);
  });

  it("writes the help, and ends with the exit code 2 for a bad command", async () => {
    const help = fakeIo({});
    expect(await measuresMain(["--help"], help.io)).toBe(0);
    expect(help.out).toEqual([MEASURES_USAGE]);
    const bad = fakeIo({});
    expect(await measuresMain([], bad.io)).toBe(2);
    expect(bad.err).toEqual(["The command has no log file.", MEASURES_USAGE]);
  });
});
