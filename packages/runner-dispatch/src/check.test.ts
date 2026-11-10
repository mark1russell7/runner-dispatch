import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CHECK_SETTINGS_FORMAT,
  checkJob,
  parseCheckSettings,
  readJobRun,
  type CheckSettings,
  type JobEnvironment,
} from "./check.ts";
import { decide, OUTSIDE_INPUT_EVENTS, TRUST_RULES_FORMAT, type TrustRules } from "./policy.ts";
import type { RunRecord } from "./records.ts";

// Small pools: a random job then meets the settings often, so each property examines jobs that pass and refused jobs.
const REPOSITORIES = ["octo/app", "octo/lib", "stranger/app"] as const;
const ACTORS = ["mark", "second-owner", "stranger"] as const;
const EVENTS = [
  "push",
  "pull_request",
  "workflow_dispatch",
  "schedule",
  "pull_request_review",
  "pull_request_target",
  "workflow_run",
] as const;
const PRINTABLE = /^[ -~]*$/;

/** One job, as the facts that GitHub keeps. The test makes the variables and the event file from them. */
interface Scenario {
  readonly repository: string;
  readonly runId: number;
  readonly runAttempt: number;
  readonly event: string;
  /** The pull request of the event file: none, from the repository, from a fork, or from a fork that no longer exists. */
  readonly pull: "none" | "same" | "fork" | "gone";
  readonly fork: string;
  readonly actor: string;
  readonly triggeringActor: string;
  /** The repository that the event file names. */
  readonly eventRepository: string;
}

/** A value in one of five cases, and `null` in the other four. */
const seldom = <T>(value: fc.Arbitrary<T>): fc.Arbitrary<T | null> =>
  fc.oneof({ weight: 4, arbitrary: fc.constant(null) }, { weight: 1, arbitrary: value });

const repository = fc.mixedCase(fc.constantFrom(...REPOSITORIES));
const actor = fc.mixedCase(fc.constantFrom(...ACTORS));
const id = fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER });

const scenario: fc.Arbitrary<Scenario> = fc
  .record({
    repository,
    runId: id,
    runAttempt: fc.integer({ min: 1, max: 3 }),
    event: fc.constantFrom(...EVENTS),
    pull: fc.constantFrom("none", "same", "fork", "gone"),
    realistic: fc.boolean(),
    fork: repository,
    actor,
    triggeringActor: actor,
    sameActor: fc.boolean(),
    otherEventRepository: seldom(repository),
  })
  .map(({ realistic, sameActor, otherEventRepository, ...fields }) => ({
    ...fields,
    // A realistic job has a pull request in its event file only for an event of a pull request.
    pull: !realistic
      ? fields.pull
      : fields.event.startsWith("pull_request")
        ? fields.pull === "none"
          ? "same"
          : fields.pull
        : "none",
    triggeringActor: sameActor ? fields.actor : fields.triggeringActor,
    eventRepository: otherEventRepository ?? fields.repository,
  }));

const environmentOf = (job: Scenario): Record<string, string> => ({
  GITHUB_REPOSITORY: job.repository,
  GITHUB_RUN_ID: String(job.runId),
  GITHUB_RUN_ATTEMPT: String(job.runAttempt),
  GITHUB_EVENT_NAME: job.event,
  GITHUB_ACTOR: job.actor,
  GITHUB_TRIGGERING_ACTOR: job.triggeringActor,
  GITHUB_EVENT_PATH: "/work/_temp/event.json",
});

const documentOf = (job: Scenario): Record<string, unknown> => ({
  repository: { full_name: job.eventRepository },
  ...(job.pull === "none"
    ? {}
    : {
        pull_request: {
          head: { repo: job.pull === "gone" ? null : { full_name: job.pull === "same" ? job.repository : job.fork } },
        },
      }),
});

/** The head repository of a job, stated from the facts and not from the event file. */
const headOf = (job: Scenario): string | null => {
  if (job.pull === "same") return job.repository;
  if (job.pull === "fork") return job.fork;
  if (job.pull === "gone") return null;
  return job.event.startsWith("pull_request") ? null : job.eventRepository;
};

/** The record that the dispatcher reads for the same job from the API of GitHub. */
const recordOf = (job: Scenario): RunRecord => ({
  repository: job.repository,
  runId: job.runId,
  runAttempt: job.runAttempt,
  event: job.event,
  headRepository: headOf(job),
  actor: job.actor,
  triggeringActor: job.triggeringActor,
});

const rules: fc.Arbitrary<TrustRules> = fc.record({
  repositories: fc.subarray([...REPOSITORIES]),
  events: fc.subarray([...EVENTS]),
  actors: fc.subarray([...ACTORS]),
});

/** Rules that permit each name of the pools. Only the fixed rules of the policy can refuse a job. */
const OPEN_RULES: TrustRules = { repositories: [...REPOSITORIES], events: [...EVENTS], actors: [...ACTORS] };

/** A job with settings. Most machines serve the run of the job, as the dispatcher makes them. */
const jobCase: fc.Arbitrary<{ job: Scenario; settings: CheckSettings }> = fc
  .record({
    job: scenario,
    rules: fc.oneof(rules, fc.constant(OPEN_RULES)),
    other: seldom(fc.record({ repository, runId: id, runAttempt: fc.integer({ min: 1, max: 3 }) })),
  })
  .map(({ job, rules: listed, other }) => ({
    job,
    settings: {
      rules: listed,
      run: other ?? { repository: job.repository, runId: job.runId, runAttempt: job.runAttempt },
    },
  }));

/** A job that passes: a realistic job of trusted accounts from the repository, on its machine. */
const passCase: fc.Arbitrary<{ job: Scenario; settings: CheckSettings }> = scenario
  .filter((job) => !["pull_request_target", "workflow_run"].includes(job.event))
  .map((job) => {
    const pull = job.event.startsWith("pull_request") ? "same" : "none";
    const passing: Scenario = { ...job, pull, eventRepository: job.repository };
    return {
      job: passing,
      settings: {
        rules: OPEN_RULES,
        run: { repository: job.repository, runId: job.runId, runAttempt: job.runAttempt },
      },
    };
  });

const lower = (name: string): string => name.toLowerCase();
const listed = (list: readonly string[], name: string): boolean => list.some((entry) => lower(entry) === lower(name));

/** A second statement of the check, from the facts of the job. It does not read the variables or the event file. */
const expectedPass = (job: Scenario, settings: CheckSettings): boolean => {
  const head = headOf(job);
  return (
    listed(settings.rules.repositories, job.repository) &&
    settings.rules.events.includes(job.event) &&
    job.event !== "pull_request_target" &&
    job.event !== "workflow_run" &&
    head !== null &&
    lower(head) === lower(job.repository) &&
    listed(settings.rules.actors, job.actor) &&
    listed(settings.rules.actors, job.triggeringActor) &&
    lower(job.eventRepository) === lower(job.repository) &&
    lower(settings.run.repository) === lower(job.repository) &&
    settings.run.runId === job.runId &&
    settings.run.runAttempt === job.runAttempt
  );
};

const rulesOf = (check: { refusals: readonly { rule: string }[] }): string[] => [...new Set(check.refusals.map((r) => r.rule))];

describe("readJobRun", () => {
  const environment: JobEnvironment = {
    GITHUB_REPOSITORY: "octo/app",
    GITHUB_RUN_ID: "12345678901",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_EVENT_NAME: "push",
    GITHUB_ACTOR: "mark",
    GITHUB_TRIGGERING_ACTOR: "second-owner",
  };

  it("reads the record of a push from the variables and the event file", () => {
    expect(readJobRun(environment, { repository: { full_name: "octo/app" } })).toEqual({
      repository: "octo/app",
      runId: 12345678901,
      runAttempt: 2,
      event: "push",
      headRepository: "octo/app",
      actor: "mark",
      triggeringActor: "second-owner",
    });
  });

  it("reads the head repository of a pull request from the pull request", () => {
    const pull = (repo: unknown): unknown => ({ repository: { full_name: "octo/app" }, pull_request: { head: { repo } } });
    const read = (event: unknown): string | null =>
      readJobRun({ ...environment, GITHUB_EVENT_NAME: "pull_request" }, event).headRepository;
    expect(read(pull({ full_name: "stranger/app" }))).toBe("stranger/app");
    expect(read(pull({ full_name: "octo/app" }))).toBe("octo/app");
    // A fork that no longer exists
    expect(read(pull(null))).toBeNull();
    expect(read(pull({ full_name: "" }))).toBeNull();
    expect(read(pull({ full_name: 7 }))).toBeNull();
  });

  it("gives no head repository to an event of a pull request with no pull request in the event file", () => {
    for (const name of ["pull_request", "pull_request_target", "pull_request_review", "pull_request_review_comment"]) {
      const run = readJobRun({ ...environment, GITHUB_EVENT_NAME: name }, { repository: { full_name: "octo/app" } });
      expect(run.headRepository).toBeNull();
    }
  });

  it("reads the pull request of the event file for each event name", () => {
    const event = { repository: { full_name: "octo/app" }, pull_request: { head: { repo: { full_name: "stranger/app" } } } };
    expect(readJobRun(environment, event).headRepository).toBe("stranger/app");
    expect(readJobRun(environment, { repository: { full_name: "octo/app" }, pull_request: null }).headRepository).toBeNull();
  });

  it("reads each id that GitHub can give", () => {
    fc.assert(
      fc.property(id, id, (runId, runAttempt) => {
        const run = readJobRun({ GITHUB_RUN_ID: String(runId), GITHUB_RUN_ATTEMPT: String(runAttempt) }, {});
        expect(run.runId).toBe(runId);
        expect(run.runAttempt).toBe(runAttempt);
      }),
    );
  });

  it("reads an id only from its exact decimal text", () => {
    const texts = fc.oneof(
      fc.string(),
      fc.nat().map(String),
      fc.nat().map((n) => `0${n}`),
      fc.nat().map((n) => `${n} `),
      fc.nat().map((n) => `${n}\n`),
      fc.double().map(String),
      fc.bigInt({ min: 0n, max: 10n ** 20n }).map(String),
    );
    fc.assert(
      fc.property(texts, (value) => {
        for (const run of [
          readJobRun({ GITHUB_RUN_ID: value }, {}).runId,
          readJobRun({ GITHUB_RUN_ATTEMPT: value }, {}).runAttempt,
        ]) {
          expect(Number.isSafeInteger(run) && run >= 0).toBe(true);
          if (run !== 0) expect(String(run)).toBe(value);
        }
      }),
    );
    for (const value of ["0", "012", "1e3", " 12", "12 ", "12\n", "+12", "-12", "0x10", "12.0", "1_000", "١٢", ""]) {
      expect(readJobRun({ GITHUB_RUN_ID: value }, {}).runId).toBe(0);
    }
    // A number that JavaScript does not keep exactly, and a number with 17 digits
    expect(readJobRun({ GITHUB_RUN_ID: "9007199254740993" }, {}).runId).toBe(0);
    expect(readJobRun({ GITHUB_RUN_ID: "99999999999999999" }, {}).runId).toBe(0);
    expect(readJobRun({ GITHUB_RUN_ID: "9007199254740991" }, {}).runId).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("gives an empty record when the job gives no field", () => {
    expect(readJobRun({}, undefined)).toEqual({
      repository: "",
      runId: 0,
      runAttempt: 0,
      event: "",
      headRepository: null,
      actor: "",
      triggeringActor: "",
    });
  });

  it("does not read a field that an object inherits", () => {
    const inherited = Object.create({ GITHUB_REPOSITORY: "octo/app", GITHUB_RUN_ID: "5" }) as JobEnvironment;
    const event = Object.create({ repository: { full_name: "octo/app" } }) as unknown;
    const run = readJobRun(inherited, event);
    expect(run.repository).toBe("");
    expect(run.runId).toBe(0);
    expect(run.headRepository).toBeNull();
  });

  it("does not throw for a value of each type", () => {
    fc.assert(
      fc.property(fc.anything(), fc.anything(), (environmentValue, event) => {
        const run = readJobRun(environmentValue as JobEnvironment, event);
        expect(typeof run.repository).toBe("string");
        expect(run.headRepository === null || typeof run.headRepository === "string").toBe(true);
      }),
    );
  });
});

describe("checkJob", () => {
  const settings: CheckSettings = {
    rules: { repositories: ["octo/app"], events: ["push", "pull_request"], actors: ["mark"] },
    run: { repository: "octo/app", runId: 77, runAttempt: 1 },
  };
  const environment: JobEnvironment = {
    GITHUB_REPOSITORY: "octo/app",
    GITHUB_RUN_ID: "77",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_EVENT_NAME: "push",
    GITHUB_ACTOR: "mark",
    GITHUB_TRIGGERING_ACTOR: "mark",
  };
  const event = { repository: { full_name: "octo/app" } };

  it("passes the job of a trusted run on the machine of that run", () => {
    const check = checkJob(settings, environment, event);
    expect(check).toEqual({ pass: true, run: readJobRun(environment, event), refusals: [] });
  });

  it("passes each realistic job of trusted accounts from the repository, on its machine", () => {
    fc.assert(
      fc.property(passCase, ({ job, settings: given }) => {
        expect(checkJob(given, environmentOf(job), documentOf(job))).toMatchObject({ pass: true, refusals: [] });
      }),
    );
  });

  it("agrees with a second statement of the check", () => {
    fc.assert(
      fc.property(jobCase, ({ job, settings: given }) => {
        expect(checkJob(given, environmentOf(job), documentOf(job)).pass).toBe(expectedPass(job, given));
      }),
      { numRuns: 1000 },
    );
  });

  it("gives a reason for each refusal, and no reason for a job that passes", () => {
    fc.assert(
      fc.property(jobCase, ({ job, settings: given }) => {
        const check = checkJob(given, environmentOf(job), documentOf(job));
        expect(check.pass).toBe(check.refusals.length === 0);
        for (const refusal of check.refusals) expect(refusal.text).toMatch(/^[A-Z][ -~]*\.$/);
      }),
    );
  });

  it("refuses a pull request from a fork, for each value of the other fields", () => {
    fc.assert(
      fc.property(scenario, (base) => {
        fc.pre(lower(base.fork) !== lower(base.repository));
        const job: Scenario = { ...base, pull: "fork" };
        const given: CheckSettings = {
          rules: OPEN_RULES,
          run: { repository: job.repository, runId: job.runId, runAttempt: job.runAttempt },
        };
        const check = checkJob(given, environmentOf(job), documentOf(job));
        expect(check.pass).toBe(false);
        expect(rulesOf(check)).toContain("head-repository");
      }),
    );
  });

  it("refuses a job that is not of the run of the machine", () => {
    fc.assert(
      fc.property(passCase, repository, id, fc.integer({ min: 1, max: 3 }), ({ job, settings: given }, name, runId, runAttempt) => {
        const changes: Partial<CheckSettings["run"]>[] = [];
        if (lower(name) !== lower(job.repository)) changes.push({ repository: name });
        if (runId !== job.runId) changes.push({ runId });
        if (runAttempt !== job.runAttempt) changes.push({ runAttempt });
        for (const change of changes) {
          const check = checkJob({ ...given, run: { ...given.run, ...change } }, environmentOf(job), documentOf(job));
          expect(check.pass).toBe(false);
          expect(rulesOf(check)).toEqual(["machine"]);
        }
      }),
    );
  });

  it("refuses the same run of a different machine, in each field", () => {
    expect(rulesOf(checkJob({ ...settings, run: { ...settings.run, runId: 78 } }, environment, event))).toEqual(["machine"]);
    expect(rulesOf(checkJob({ ...settings, run: { ...settings.run, runAttempt: 2 } }, environment, event))).toEqual(["machine"]);
    expect(rulesOf(checkJob({ ...settings, run: { ...settings.run, repository: "octo/lib" } }, environment, event))).toEqual([
      "machine",
    ]);
  });

  it("passes no job that the policy of the dispatcher refuses", () => {
    fc.assert(
      fc.property(jobCase, ({ job, settings: given }) => {
        const check = checkJob(given, environmentOf(job), documentOf(job));
        if (check.pass) expect(decide(given.rules, recordOf(job)).trusted).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it("reads the same record as the dispatcher, for a realistic job", () => {
    fc.assert(
      fc.property(scenario, (job) => {
        fc.pre(lower(job.eventRepository) === lower(job.repository));
        fc.pre(job.event.startsWith("pull_request") === (job.pull !== "none"));
        expect(readJobRun(environmentOf(job), documentOf(job))).toEqual(recordOf(job));
      }),
    );
  });

  it("refuses an event file that is not an object", () => {
    for (const value of [undefined, null, [], "text", 5, true]) {
      const check = checkJob(settings, environment, value);
      expect(check.pass).toBe(false);
      expect(rulesOf(check)).toContain("event-file");
    }
  });

  it("refuses an event file that names a different repository", () => {
    const pull = { pull_request: { head: { repo: { full_name: "octo/app" } } } };
    const job = { ...environment, GITHUB_EVENT_NAME: "pull_request" };
    expect(checkJob(settings, job, { ...pull, repository: { full_name: "octo/app" } }).pass).toBe(true);
    expect(rulesOf(checkJob(settings, job, { ...pull, repository: { full_name: "octo/lib" } }))).toEqual(["event-file"]);
    expect(rulesOf(checkJob(settings, job, pull))).toEqual(["event-file"]);
  });

  it("refuses a run of the machine with a bad shape", () => {
    const zero = { ...environment, GITHUB_RUN_ID: "0" };
    expect(checkJob({ ...settings, run: { ...settings.run, runId: 0 } }, zero, event).pass).toBe(false);
    for (const run of [undefined, null, "run-77-1", [], { repository: "octo/app", runId: "77", runAttempt: 1 }]) {
      const check = checkJob({ ...settings, run } as unknown as CheckSettings, environment, event);
      expect(rulesOf(check)).toEqual(["machine"]);
    }
  });

  it("does not throw and does not pass for a value of each type", () => {
    fc.assert(
      fc.property(fc.anything(), fc.anything(), fc.anything(), (given, variables, document) => {
        expect(checkJob(given as CheckSettings, variables as JobEnvironment, document).pass).toBe(false);
      }),
    );
    fc.assert(
      fc.property(fc.anything(), fc.anything(), (variables, document) => {
        expect(checkJob(settings, variables as JobEnvironment, document).pass).toBe(false);
      }),
    );
    fc.assert(
      fc.property(fc.anything(), (given) => {
        expect(checkJob(given as CheckSettings, environment, event).pass).toBe(false);
      }),
    );
  });

  it("keeps a long value and a control character out of the reasons", () => {
    const value = fc.oneof(fc.string({ unit: "binary", maxLength: 400 }), fc.string({ unit: "grapheme", maxLength: 400 }));
    fc.assert(
      fc.property(value, value, value, value, value, (a, b, c, d, e) => {
        const variables = {
          GITHUB_REPOSITORY: a,
          GITHUB_RUN_ID: b,
          GITHUB_RUN_ATTEMPT: b,
          GITHUB_EVENT_NAME: c,
          GITHUB_ACTOR: d,
          GITHUB_TRIGGERING_ACTOR: e,
        };
        const document = { repository: { full_name: e }, pull_request: { head: { repo: { full_name: d } } } };
        for (const refusal of checkJob(settings, variables, document).refusals) {
          expect(refusal.text).toMatch(PRINTABLE);
          expect(refusal.text.length).toBeLessThan(2000);
        }
      }),
    );
  });
});

describe("parseCheckSettings", () => {
  const document = {
    format: CHECK_SETTINGS_FORMAT,
    rules: { format: TRUST_RULES_FORMAT, repositories: ["octo/app"], events: ["push"], actors: ["mark"] },
    run: { repository: "octo/app", runId: 77, runAttempt: 1 },
  };

  it("reads a valid document, and gives settings that do not change", () => {
    const result = parseCheckSettings(document);
    expect(result).toEqual({
      ok: true,
      settings: {
        rules: { repositories: ["octo/app"], events: ["push"], actors: ["mark"] },
        run: { repository: "octo/app", runId: 77, runAttempt: 1 },
      },
    });
    if (!result.ok) return;
    expect(Object.isFrozen(result.settings.run)).toBe(true);
    expect(Object.isFrozen(result.settings.rules.actors)).toBe(true);
    expect(result.settings.run).not.toBe(document.run);
  });

  it("gives settings that check a job as the document says", () => {
    fc.assert(
      fc.property(jobCase, ({ job, settings: generated }) => {
        // A document cannot list an event that the policy refuses for each run.
        const events = generated.rules.events.filter((event) => !OUTSIDE_INPUT_EVENTS.includes(event));
        const given: CheckSettings = { ...generated, rules: { ...generated.rules, events } };
        const result = parseCheckSettings({
          format: CHECK_SETTINGS_FORMAT,
          rules: { format: TRUST_RULES_FORMAT, ...given.rules },
          run: given.run,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.settings).toEqual(given);
        expect(checkJob(result.settings, environmentOf(job), documentOf(job))).toEqual(
          checkJob(given, environmentOf(job), documentOf(job)),
        );
      }),
    );
  });

  it("reports each problem of a document", () => {
    const problems = (value: unknown): readonly string[] => {
      const result = parseCheckSettings(value);
      return result.ok ? [] : result.problems;
    };
    expect(problems(document)).toEqual([]);
    for (const value of [undefined, null, [], "text", 5]) {
      expect(problems(value)).toEqual(["The document is not an object."]);
    }
    expect(problems({ ...document, format: "machine-check/2" })).toEqual(['The field format is not "machine-check/1".']);
    expect(problems({ rules: document.rules, run: document.run })).toEqual(['The field format is not "machine-check/1".']);
    expect(problems({ ...document, machine: document.run })).toEqual(['The document has the unknown field "machine".']);
    expect(problems({ ...document, rules: { ...document.rules, actors: ["mark", "not valid"] } })).toEqual([
      'The field rules: The entry 1 of actors is not valid: "not valid".',
    ]);
    expect(problems({ format: CHECK_SETTINGS_FORMAT, run: document.run })).toEqual([
      "The field rules: The document is not an object.",
    ]);
    expect(problems({ format: CHECK_SETTINGS_FORMAT, rules: document.rules })).toEqual(["The field run is not an object."]);
    expect(problems({ ...document, run: [] })).toEqual(["The field run is not an object."]);
    expect(problems({ ...document, run: { ...document.run, name: "vm-1" } })).toEqual([
      'The field run has the unknown field "name".',
    ]);
    expect(problems({ ...document, run: { ...document.run, repository: "app" } })).toEqual([
      "The field run.repository is not the name of a repository.",
    ]);
    expect(problems({ ...document, run: { ...document.run, runId: "77" } })).toEqual([
      "The field run.runId is not a whole number from 1.",
    ]);
    expect(problems({ ...document, run: { ...document.run, runAttempt: 0 } })).toEqual([
      "The field run.runAttempt is not a whole number from 1.",
    ]);
    expect(problems({ format: "x", rules: null, run: { repository: 5 }, extra: 1 })).toHaveLength(6);
  });

  it("does not throw for a value of each type, and accepts only a valid run", () => {
    fc.assert(
      fc.property(fc.anything(), fc.anything(), fc.anything(), (format, rulesValue, run) => {
        for (const value of [format, { format, rules: rulesValue, run }, { ...document, run }, { ...document, rules: rulesValue }]) {
          const result = parseCheckSettings(value);
          if (!result.ok) {
            expect(result.problems.length).toBeGreaterThan(0);
            for (const problem of result.problems) expect(problem).toMatch(PRINTABLE);
            continue;
          }
          const { repository: name, runId, runAttempt } = result.settings.run;
          expect(name).toMatch(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/);
          expect(Number.isSafeInteger(runId) && runId >= 1).toBe(true);
          expect(Number.isSafeInteger(runAttempt) && runAttempt >= 1).toBe(true);
        }
      }),
    );
  });
});
