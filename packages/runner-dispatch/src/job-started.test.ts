import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CHECK_SETTINGS_FORMAT, checkJob, parseCheckSettings } from "./check.ts";
import { jobStarted } from "./job-started.ts";
import { TRUST_RULES_FORMAT } from "./policy.ts";

const SETTINGS_PATH = "/etc/runner-dispatch/check.json";
const EVENT_PATH = "/work/_temp/_github_workflow/event.json";
/** Each line starts with fixed words, so a value from outside cannot start a line of the log. */
const LINE = /^(?:The check on the machine |- [a-z-]+: The )[ -~]*\.$/;

const REPOSITORIES = ["octo/app", "octo/lib", "stranger/app"] as const;
const ACTORS = ["mark", "second-owner", "stranger"] as const;
const EVENTS = ["push", "pull_request", "workflow_dispatch", "pull_request_target"] as const;
const LISTED_EVENTS = ["push", "pull_request", "workflow_dispatch", "schedule"] as const;

const settings = {
  format: CHECK_SETTINGS_FORMAT,
  rules: {
    format: TRUST_RULES_FORMAT,
    repositories: ["octo/app"],
    events: ["push", "pull_request"],
    actors: ["mark", "second-owner"],
  },
  run: { repository: "octo/app", runId: 77, runAttempt: 1 },
};
const environment = {
  GITHUB_REPOSITORY: "octo/app",
  GITHUB_RUN_ID: "77",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_EVENT_NAME: "push",
  GITHUB_ACTOR: "mark",
  GITHUB_TRIGGERING_ACTOR: "second-owner",
  GITHUB_EVENT_PATH: EVENT_PATH,
};
const event = { repository: { full_name: "octo/app" } };

/** A reader of the files of a map. It throws for each other path, as the reader of the program does. */
const reader =
  (files: Record<string, string>) =>
  (path: string): string => {
    const text = Object.hasOwn(files, path) ? files[path] : undefined;
    if (text === undefined) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    return text;
  };

const files = (changes: Record<string, string> = {}): Record<string, string> => ({
  [SETTINGS_PATH]: JSON.stringify(settings),
  [EVENT_PATH]: JSON.stringify(event),
  ...changes,
});

const noRead = (path: string): string => {
  throw new Error(`The program read the file ${path}.`);
};

/** An environment in which each name of a variable gives one value. A test with it holds for each name. */
const eachName = (value: string): Record<string, string> =>
  new Proxy<Record<string, string>>(
    {},
    {
      get: () => value,
      has: () => true,
      getOwnPropertyDescriptor: () => ({ value, writable: true, enumerable: true, configurable: true }),
    },
  );

describe("jobStarted", () => {
  it("lets the job of the run of the machine start", () => {
    expect(jobStarted([SETTINGS_PATH], environment, reader(files()))).toEqual({
      code: 0,
      lines: ['The check on the machine passed: the run 77, try 1, of "octo/app".'],
    });
  });

  it("refuses a pull request from a fork, with the reason", () => {
    const fork = { repository: { full_name: "octo/app" }, pull_request: { head: { repo: { full_name: "stranger/app" } } } };
    const result = jobStarted(
      [SETTINGS_PATH],
      { ...environment, GITHUB_EVENT_NAME: "pull_request" },
      reader(files({ [EVENT_PATH]: JSON.stringify(fork) })),
    );
    expect(result).toEqual({
      code: 1,
      lines: [
        "The check on the machine refused this job.",
        '- head-repository: The head repository "stranger/app" is not the repository "octo/app".',
      ],
    });
  });

  it("refuses the job of a different run", () => {
    for (const change of [{ GITHUB_RUN_ID: "78" }, { GITHUB_RUN_ATTEMPT: "2" }]) {
      expect(jobStarted([SETTINGS_PATH], { ...environment, ...change }, reader(files()))).toEqual({
        code: 1,
        lines: ["The check on the machine refused this job.", "- machine: The run of the job is not the run of this machine."],
      });
    }
  });

  it("needs one argument, and reads no file without it", () => {
    const needs = { code: 2, lines: ["The check on the machine cannot start. It needs one argument: the path of its settings file."] };
    for (const args of [[], [""], [SETTINGS_PATH, SETTINGS_PATH], [SETTINGS_PATH, "--help"], [5], undefined, null, SETTINGS_PATH]) {
      expect(jobStarted(args as unknown as string[], environment, noRead)).toEqual(needs);
    }
  });

  it("takes the path of its settings from no variable", () => {
    // Each name of a variable gives the path of a valid settings file. Without the argument, the program reads no file.
    const variables = eachName(SETTINGS_PATH);
    expect(variables["GITHUB_EVENT_PATH"]).toBe(SETTINGS_PATH);
    expect(Object.hasOwn(variables, "A_NAME")).toBe(true);
    const result = jobStarted([], variables, noRead);
    expect(result.code).toBe(2);
    expect(result.lines).toEqual(["The check on the machine cannot start. It needs one argument: the path of its settings file."]);
  });

  it("reads its settings only from the file of its argument", () => {
    // Each name of a variable gives the path of a second settings file, with rules that permit more.
    const other = "/work/settings-of-the-job.json";
    const wide = { ...settings, rules: { ...settings.rules, repositories: ["octo/app", "stranger/app"], actors: ["stranger"] } };
    const given = reader(files({ [other]: JSON.stringify(wide) }));
    const paths: string[] = [];
    const result = jobStarted([SETTINGS_PATH], eachName(other), (path) => {
      paths.push(path);
      return given(path);
    });
    // The first file is the settings file of the argument. The second file is the event file, from GITHUB_EVENT_PATH.
    expect(paths).toEqual([SETTINGS_PATH, other]);
    expect(result.code).toBe(1);
  });

  it("does not start when it cannot read its settings file", () => {
    const cannot = { code: 2, lines: ["The check on the machine cannot start. It cannot read its settings file as JSON."] };
    expect(jobStarted(["/etc/other.json"], environment, reader(files()))).toEqual(cannot);
    for (const text of ["", "{", "not JSON", '{"format":"machine-check/1",}']) {
      expect(jobStarted([SETTINGS_PATH], environment, reader(files({ [SETTINGS_PATH]: text })))).toEqual(cannot);
    }
  });

  it("does not start with settings that are not valid, and shows only the count of the problems", () => {
    const run = (document: unknown): unknown =>
      jobStarted([SETTINGS_PATH], environment, reader(files({ [SETTINGS_PATH]: JSON.stringify(document) })));
    const invalid = (count: number): unknown => ({
      code: 2,
      lines: [`The check on the machine cannot start. Its settings file is not valid. The count of the problems is ${count}.`],
    });
    expect(run(null)).toEqual(invalid(1));
    expect(run({ ...settings, format: "machine-check/2" })).toEqual(invalid(1));
    expect(run({ ...settings, rules: { ...settings.rules, actors: ["hidden owner", "mark", "mark"] } })).toEqual(invalid(2));
    expect(run({ ...settings, run: { repository: "octo/app", runId: "77" } })).toEqual(invalid(2));
    // The rules alone are not the settings of a machine.
    expect(run(settings.rules)).toEqual(invalid(6));
  });

  it("refuses a job when it cannot read the event file", () => {
    const eventFile = "- event-file: The event file of the job is not an object.";
    const cases: [Record<string, string | undefined>, Record<string, string>][] = [
      [{ ...environment, GITHUB_EVENT_PATH: undefined }, files()],
      [{ ...environment, GITHUB_EVENT_PATH: "" }, files()],
      [{ ...environment, GITHUB_EVENT_PATH: "/work/other.json" }, files()],
      [environment, files({ [EVENT_PATH]: "" })],
      [environment, files({ [EVENT_PATH]: "{" })],
      [environment, files({ [EVENT_PATH]: "null" })],
      [environment, files({ [EVENT_PATH]: "[]" })],
      [environment, files({ [EVENT_PATH]: '"octo/app"' })],
    ];
    for (const [variables, given] of cases) {
      const result = jobStarted([SETTINGS_PATH], variables, reader(given));
      expect(result.code).toBe(1);
      expect(result.lines).toContain(eventFile);
    }
  });

  it("gives the answer of the check, one line for each reason", () => {
    const job = fc.record({
      GITHUB_REPOSITORY: fc.constantFrom(...REPOSITORIES),
      GITHUB_RUN_ID: fc.constantFrom("77", "78", "0", "x"),
      GITHUB_RUN_ATTEMPT: fc.constantFrom("1", "1", "2"),
      GITHUB_EVENT_NAME: fc.constantFrom(...EVENTS),
      GITHUB_ACTOR: fc.constantFrom(...ACTORS),
      GITHUB_TRIGGERING_ACTOR: fc.constantFrom(...ACTORS),
    });
    const document = fc.record(
      {
        repository: fc.record({ full_name: fc.constantFrom(...REPOSITORIES) }),
        pull_request: fc.record({ head: fc.record({ repo: fc.option(fc.record({ full_name: fc.constantFrom(...REPOSITORIES) })) }) }),
      },
      { requiredKeys: [] },
    );
    const given = fc.record({
      format: fc.constant(CHECK_SETTINGS_FORMAT),
      rules: fc.record({
        format: fc.constant(TRUST_RULES_FORMAT),
        repositories: fc.subarray([...REPOSITORIES]),
        events: fc.subarray([...LISTED_EVENTS]),
        actors: fc.subarray([...ACTORS]),
      }),
      run: fc.record({
        repository: fc.constantFrom(...REPOSITORIES),
        runId: fc.constantFrom(77, 77, 78),
        runAttempt: fc.constantFrom(1, 1, 2),
      }),
    });
    let passes = 0;
    fc.assert(
      fc.property(job, document, given, (variables, eventDocument, settingsDocument) => {
        const parsed = parseCheckSettings(settingsDocument);
        if (!parsed.ok) throw new Error("The generated settings are not valid.");
        const check = checkJob(parsed.settings, variables, eventDocument);
        const result = jobStarted(
          [SETTINGS_PATH],
          { ...variables, GITHUB_EVENT_PATH: EVENT_PATH },
          reader({ [SETTINGS_PATH]: JSON.stringify(settingsDocument), [EVENT_PATH]: JSON.stringify(eventDocument) }),
        );
        expect(result.code).toBe(check.pass ? 0 : 1);
        if (check.pass) {
          passes += 1;
          expect(result.lines).toHaveLength(1);
          expect(result.lines[0]).toContain(`the run ${check.run.runId}, try ${check.run.runAttempt}, of "${check.run.repository}"`);
        } else {
          expect(result.lines.slice(1)).toEqual(check.refusals.map((refusal) => `- ${refusal.rule}: ${refusal.text}`));
          expect(result.lines.length).toBeGreaterThan(1);
        }
        for (const line of result.lines) expect(line).toMatch(LINE);
      }),
      { numRuns: 2000, seed: 20261110 },
    );
    // The fixed seed gives jobs that pass, so the property examines the two answers.
    expect(passes).toBeGreaterThan(0);
  });

  it("shows only which rules refused a job, and no entry of the trust rules", () => {
    const rules = fc.record({
      format: fc.constant(TRUST_RULES_FORMAT),
      repositories: fc.subarray([...REPOSITORIES]),
      events: fc.subarray([...LISTED_EVENTS]),
      actors: fc.subarray([...ACTORS]),
    });
    const job = fc.record({
      GITHUB_REPOSITORY: fc.constantFrom(...REPOSITORIES),
      GITHUB_EVENT_NAME: fc.constantFrom(...EVENTS),
      GITHUB_ACTOR: fc.constantFrom(...ACTORS),
      GITHUB_TRIGGERING_ACTOR: fc.constantFrom(...ACTORS),
    });
    const refused = (lines: readonly string[]): string[] => lines.slice(1).map((line) => line.slice(0, line.indexOf(":")));
    let compared = 0;
    fc.assert(
      fc.property(job, rules, rules, (variables, first, second) => {
        const answer = (listed: unknown): { code: number; lines: readonly string[] } =>
          jobStarted(
            [SETTINGS_PATH],
            { ...environment, ...variables },
            reader(files({ [SETTINGS_PATH]: JSON.stringify({ ...settings, rules: listed }) })),
          );
        const a = answer(first);
        const b = answer(second);
        // Two machines with different rules that refuse a job by the same rules write the same lines.
        if (a.code !== b.code || refused(a.lines).join() !== refused(b.lines).join()) return;
        compared += 1;
        expect(a.lines).toEqual(b.lines);
      }),
      { numRuns: 1000, seed: 20261110 },
    );
    expect(compared).toBeGreaterThan(100);

    // The names of the rules are not names of the job, so no line can show them.
    const hidden = { ...settings.rules, repositories: ["octo/app", "octo/hidden-repository"], actors: ["hidden-owner"] };
    const result = jobStarted([SETTINGS_PATH], environment, reader(files({ [SETTINGS_PATH]: JSON.stringify({ ...settings, rules: hidden }) })));
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).not.toMatch(/hidden/);
  });

  it("writes each value from outside in one line of printable characters", () => {
    const value = fc.oneof(
      fc.string({ unit: "binary", maxLength: 300 }),
      fc.constantFrom("octo/app\n::error::text", "\r\n##[error]text", "::add-mask::mark", "mark\u001b[2K", "octo/app "),
    );
    fc.assert(
      fc.property(value, value, value, value, (a, b, c, d) => {
        const variables = {
          ...environment,
          GITHUB_REPOSITORY: a,
          GITHUB_EVENT_NAME: b,
          GITHUB_ACTOR: c,
          GITHUB_TRIGGERING_ACTOR: d,
        };
        const document = { repository: { full_name: d }, pull_request: { head: { repo: { full_name: c } } } };
        const result = jobStarted([SETTINGS_PATH], variables, reader(files({ [EVENT_PATH]: JSON.stringify(document) })));
        expect(result.code).toBe(1);
        for (const line of result.lines) expect(line).toMatch(LINE);
      }),
    );
  });

  it("does not throw, and does not let a job start, for a value of each type", () => {
    const read = fc.oneof(
      fc.constant(noRead),
      fc.anything().map((value) => () => value as string),
      fc.json().map((text) => () => text),
    );
    fc.assert(
      fc.property(fc.anything(), fc.anything(), read, (args, variables, given) => {
        for (const result of [
          jobStarted(args as string[], variables as typeof environment, given),
          jobStarted([SETTINGS_PATH], variables as typeof environment, given),
          jobStarted([SETTINGS_PATH], environment, given),
        ]) {
          expect([1, 2]).toContain(result.code);
          expect(result.lines.length).toBeGreaterThan(0);
          for (const line of result.lines) expect(line).toMatch(LINE);
        }
      }),
    );
  });
});
