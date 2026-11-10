import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  decide,
  OUTSIDE_INPUT_EVENTS,
  parseTrustRules,
  TRUST_RULES_FORMAT,
  type RefusalRule,
  type TrustRules,
} from "./policy.ts";
import type { RunRecord } from "./records.ts";

// Small pools: a random run then meets the rules often, so each property examines trusted runs and refused runs.
const REPOSITORIES = ["octo/app", "octo/lib", "octo/site", "stranger/app"] as const;
const ACTORS = ["mark", "second-owner", "renovate[bot]", "stranger"] as const;
const EVENTS = [
  "push",
  "pull_request",
  "workflow_dispatch",
  "schedule",
  "merge_group",
  "issue_comment",
  "pull_request_target",
  "workflow_run",
] as const;
const RULES: readonly RefusalRule[] = [
  "record",
  "repository",
  "event",
  "outside-input-event",
  "head-repository",
  "actor",
  "triggering-actor",
];

const repository = fc.mixedCase(fc.constantFrom(...REPOSITORIES));
const actor = fc.mixedCase(fc.constantFrom(...ACTORS));
const event = fc.constantFrom(...EVENTS);
const id = fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER });

const rules: fc.Arbitrary<TrustRules> = fc.record({
  repositories: fc.array(repository, { maxLength: 4 }),
  events: fc.subarray([...EVENTS]),
  actors: fc.array(actor, { maxLength: 4 }),
});

/** A run of the pools. Half of the runs have the repository as the head repository. */
const run: fc.Arbitrary<RunRecord> = fc
  .record({
    repository,
    runId: id,
    runAttempt: fc.integer({ min: 1, max: 5 }),
    event,
    head: fc.oneof(
      { weight: 3, arbitrary: fc.constant("same" as const) },
      { weight: 2, arbitrary: repository },
      { weight: 1, arbitrary: fc.constant(null) },
    ),
    actor,
    triggeringActor: actor,
    sameActor: fc.boolean(),
  })
  .map(({ head, sameActor, ...fields }) => ({
    ...fields,
    headRepository: head === "same" ? fields.repository : head,
    triggeringActor: sameActor ? fields.actor : fields.triggeringActor,
  }));

/** Rules that trust a run or more, and one run that they trust. */
const trustedCase: fc.Arbitrary<{ rules: TrustRules; run: RunRecord }> = fc
  .record({
    repositories: fc.subarray([...REPOSITORIES], { minLength: 1 }),
    events: fc.subarray(["push", "pull_request", "workflow_dispatch", "schedule", "merge_group"], { minLength: 1 }),
    actors: fc.subarray([...ACTORS], { minLength: 1 }),
    picks: fc.tuple(fc.nat(), fc.nat(), fc.nat(), fc.nat()),
    runId: id,
    runAttempt: fc.integer({ min: 1, max: 5 }),
  })
  .map(({ repositories, events, actors, picks, runId, runAttempt }) => {
    const pick = <T>(list: readonly T[], n: number): T => list[n % list.length] as T;
    const name = pick(repositories, picks[0]);
    return {
      rules: { repositories, events, actors },
      run: {
        repository: name,
        runId,
        runAttempt,
        event: pick(events, picks[1]),
        headRepository: name,
        actor: pick(actors, picks[2]),
        triggeringActor: pick(actors, picks[3]),
      },
    };
  });

/** A second statement of the rules, with the full lower case of JavaScript: the pools have only ASCII names. */
function oracle(given: TrustRules, record: RunRecord): boolean {
  const lower = (list: readonly string[]): Set<string> => new Set(list.map((entry) => entry.toLowerCase()));
  const accounts = lower(given.actors);
  if (!lower(given.repositories).has(record.repository.toLowerCase())) return false;
  if (!given.events.includes(record.event)) return false;
  if (record.event === "pull_request_target" || record.event === "workflow_run") return false;
  if (record.headRepository === null) return false;
  if (record.headRepository.toLowerCase() !== record.repository.toLowerCase()) return false;
  return accounts.has(record.actor.toLowerCase()) && accounts.has(record.triggeringActor.toLowerCase());
}

const refusedBy = (given: TrustRules, record: RunRecord): readonly RefusalRule[] =>
  decide(given, record).refusals.map((refusal) => refusal.rule);

describe("decide", () => {
  it("trusts a run of a served repository, a listed event and trusted accounts", () => {
    const given: TrustRules = { repositories: ["octo/app"], events: ["push", "pull_request"], actors: ["mark"] };
    const record: RunRecord = {
      repository: "octo/app",
      runId: 12345678901,
      runAttempt: 1,
      event: "pull_request",
      headRepository: "octo/app",
      actor: "mark",
      triggeringActor: "mark",
    };
    expect(decide(given, record)).toEqual({ trusted: true, refusals: [] });
    expect(refusedBy(given, { ...record, headRepository: "stranger/app" })).toEqual(["head-repository"]);
    expect(refusedBy(given, { ...record, actor: "renovate[bot]" })).toEqual(["actor"]);
    expect(refusedBy(given, { ...record, triggeringActor: "stranger" })).toEqual(["triggering-actor"]);
    expect(refusedBy(given, { ...record, event: "schedule" })).toEqual(["event"]);
    expect(refusedBy(given, { ...record, repository: "octo/lib", headRepository: "octo/lib" })).toEqual(["repository"]);
    expect(refusedBy(given, { ...record, event: "pull_request_target" })).toEqual(["event", "outside-input-event"]);
  });

  it("trusts each run that the rules permit", () => {
    fc.assert(
      fc.property(trustedCase, ({ rules: given, run: record }) => {
        expect(decide(given, record)).toEqual({ trusted: true, refusals: [] });
      }),
    );
  });

  it("does not trust a run from a fork, for each value of the other fields", () => {
    fc.assert(
      fc.property(rules, run, fc.option(repository, { nil: null }), (given, record, head) => {
        fc.pre(head === null || head.toLowerCase() !== record.repository.toLowerCase());
        const fork = { ...record, headRepository: head };
        const decision = decide(given, fork);
        expect(decision.trusted).toBe(false);
        expect(decision.refusals.map((refusal) => refusal.rule)).toContain("head-repository");
      }),
    );
  });

  it("does not trust a fork when the rules permit each other field", () => {
    fc.assert(
      fc.property(trustedCase, fc.option(repository, { nil: null }), ({ rules: given, run: record }, head) => {
        fc.pre(head === null || head.toLowerCase() !== record.repository.toLowerCase());
        expect(refusedBy(given, { ...record, headRepository: head })).toEqual(["head-repository"]);
      }),
    );
  });

  it("does not trust an event with outside input, also when the rules list it", () => {
    fc.assert(
      fc.property(trustedCase, fc.constantFrom(...OUTSIDE_INPUT_EVENTS), ({ rules: given, run: record }, outside) => {
        const listed = { ...given, events: [...given.events, outside] };
        expect(refusedBy(listed, { ...record, event: outside })).toEqual(["outside-input-event"]);
      }),
    );
    expect(OUTSIDE_INPUT_EVENTS).toEqual(["pull_request_target", "workflow_run"]);
    expect(Object.isFrozen(OUTSIDE_INPUT_EVENTS)).toBe(true);
  });

  it("agrees with a second statement of the rules", () => {
    fc.assert(
      fc.property(rules, run, (given, record) => {
        expect(decide(given, record).trusted).toBe(oracle(given, record));
      }),
      { numRuns: 2000 },
    );
  });

  it("gives a reason for each refusal, and no reason for a trusted run", () => {
    fc.assert(
      fc.property(rules, run, (given, record) => {
        const decision = decide(given, record);
        expect(decision.trusted).toBe(decision.refusals.length === 0);
        for (const refusal of decision.refusals) {
          expect(RULES).toContain(refusal.rule);
          expect(refusal.text).toMatch(/^The [ -~]+\.$/);
        }
      }),
    );
  });

  it("adds no trust when a list loses entries", () => {
    fc.assert(
      fc.property(
        rules.chain((given) =>
          fc.record({
            given: fc.constant(given),
            fewer: fc.record({
              repositories: fc.subarray([...given.repositories]),
              events: fc.subarray([...given.events]),
              actors: fc.subarray([...given.actors]),
            }),
          }),
        ),
        run,
        ({ given, fewer }, record) => {
          if (decide(fewer, record).trusted) expect(decide(given, record).trusted).toBe(true);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("trusts no run when one list is empty", () => {
    fc.assert(
      fc.property(trustedCase, fc.constantFrom("repositories", "events", "actors"), ({ rules: given, run: record }, list) => {
        expect(decide({ ...given, [list]: [] }, record).trusted).toBe(false);
      }),
    );
  });

  it("gives the same answer for each case of the names of accounts and repositories", () => {
    const recase = (text: string, mask: number): string =>
      [...text].map((letter, index) => ((mask >> index % 30) & 1 ? letter.toUpperCase() : letter.toLowerCase())).join("");
    fc.assert(
      fc.property(rules, run, fc.nat(), fc.nat(), (given, record, a, b) => {
        const other: RunRecord = {
          ...record,
          repository: recase(record.repository, a),
          headRepository: record.headRepository === null ? null : recase(record.headRepository, b),
          actor: recase(record.actor, b),
          triggeringActor: recase(record.triggeringActor, a),
        };
        const otherRules: TrustRules = {
          repositories: given.repositories.map((entry) => recase(entry, b)),
          events: given.events,
          actors: given.actors.map((entry) => recase(entry, a)),
        };
        expect(decide(otherRules, other).trusted).toBe(decide(given, record).trusted);
      }),
    );
  });

  it("compares an event with its exact text", () => {
    fc.assert(
      fc.property(trustedCase, ({ rules: given, run: record }) => {
        expect(refusedBy(given, { ...record, event: record.event.toUpperCase() })).toEqual(["event"]);
        expect(refusedBy(given, { ...record, event: ` ${record.event}` })).toEqual(["event"]);
      }),
    );
  });

  it("does not trust a name that only looks like a trusted name", () => {
    const given: TrustRules = { repositories: ["octo/app"], events: ["push"], actors: ["mark"] };
    const record: RunRecord = {
      repository: "octo/app",
      runId: 7,
      runAttempt: 1,
      event: "push",
      headRepository: "octo/app",
      actor: "marK",
      triggeringActor: "mark",
    };
    expect(refusedBy(given, record)).toEqual(["actor"]);
    expect(refusedBy({ ...given, actors: ["marK"] }, { ...record, actor: "mark" })).toEqual(["actor", "triggering-actor"]);
  });

  it("does not trust a record with a missing or bad field", () => {
    const bad = {
      repository: fc.constantFrom<unknown>("", undefined, null, 7, ["octo/app"]),
      event: fc.constantFrom<unknown>("", undefined, null, 7, ["push"]),
      actor: fc.constantFrom<unknown>("", undefined, null, 7, ["mark"]),
      triggeringActor: fc.constantFrom<unknown>("", undefined, null, 7, ["mark"]),
      runId: fc.constantFrom<unknown>(0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, "7", null, undefined),
      runAttempt: fc.constantFrom<unknown>(0, -1, 1.5, Number.NaN, "1", null, undefined),
      headRepository: fc.constantFrom<unknown>(undefined, 7, "", ["octo/app"]),
    };
    const field = fc.constantFrom(...(Object.keys(bad) as (keyof typeof bad)[]));
    fc.assert(
      fc.property(
        trustedCase,
        field.chain((name) => fc.tuple(fc.constant(name), bad[name])),
        fc.boolean(),
        ({ rules: given, run: record }, [name, value], remove) => {
          const broken: Record<string, unknown> = { ...record, [name]: value };
          if (remove) delete broken[name];
          const decision = decide(given, broken as unknown as RunRecord);
          expect(decision.trusted).toBe(false);
          if (name !== "headRepository" || value !== "") {
            expect(decision.refusals.map((refusal) => refusal.rule)).toContain("record");
          }
        },
      ),
    );
  });

  it("does not throw and does not trust for a value of each type", () => {
    const anything = fc.anything({ withBigInt: true, withNullPrototype: true, withDate: true, withMap: true, withSet: true });
    fc.assert(
      fc.property(trustedCase, anything, anything, ({ rules: given, run: record }, a, b) => {
        expect(decide(given, a as RunRecord).trusted).toBe(false);
        expect(decide(a as TrustRules, record).trusted).toBe(false);
        expect(decide(a as TrustRules, b as RunRecord).trusted).toBe(false);
      }),
      { numRuns: 500 },
    );
    const given: TrustRules = { repositories: ["octo/app"], events: ["push"], actors: ["mark"] };
    for (const value of [null, undefined, "run", 7, ["octo/app"]]) {
      expect(decide(given, value as unknown as RunRecord).refusals[0]).toEqual({
        rule: "record",
        text: "The record of the run is not an object.",
      });
    }
  });

  it("keeps a long name and a control character out of the reason", () => {
    const given: TrustRules = { repositories: ["octo/app"], events: ["push"], actors: ["mark"] };
    const record: RunRecord = {
      repository: "octo/app",
      runId: 7,
      runAttempt: 1,
      event: "push",
      headRepository: "octo/app",
      actor: `x\n\u001B[31m${"a".repeat(5000)}`,
      triggeringActor: "mark",
    };
    const [refusal] = decide(given, record).refusals;
    expect(refusal?.rule).toBe("actor");
    expect(refusal?.text).toMatch(/^[ -~]+$/);
    expect(refusal?.text.length).toBeLessThan(250);
  });
});

describe("parseTrustRules", () => {
  const document = (given: TrustRules): Record<string, unknown> => ({ format: TRUST_RULES_FORMAT, ...given });
  const valid: fc.Arbitrary<TrustRules> = fc.record({
    repositories: fc.subarray([...REPOSITORIES]),
    events: fc.subarray(["push", "pull_request", "workflow_dispatch", "schedule", "merge_group"]),
    actors: fc.subarray([...ACTORS]),
  });
  const problemsOf = (value: unknown): readonly string[] => {
    const result = parseTrustRules(value);
    return result.ok ? [] : result.problems;
  };

  it("reads each valid document, and gives lists that do not change", () => {
    fc.assert(
      fc.property(valid, (given) => {
        const result = parseTrustRules(JSON.parse(JSON.stringify(document(given))));
        expect(result).toEqual({ ok: true, rules: given });
        if (result.ok) {
          expect(Object.isFrozen(result.rules.repositories)).toBe(true);
          expect(Object.isFrozen(result.rules.events)).toBe(true);
          expect(Object.isFrozen(result.rules.actors)).toBe(true);
        }
      }),
    );
  });

  it("reads a document with empty lists: it trusts no run", () => {
    const result = parseTrustRules({ format: TRUST_RULES_FORMAT, repositories: [], events: [], actors: [] });
    expect(result).toEqual({ ok: true, rules: { repositories: [], events: [], actors: [] } });
  });

  it("gives rules that decide as the document says", () => {
    fc.assert(
      fc.property(valid, run, (given, record) => {
        const result = parseTrustRules(document(given));
        expect(result.ok).toBe(true);
        if (result.ok) expect(decide(result.rules, record).trusted).toBe(oracle(given, record));
      }),
    );
  });

  it("reports each problem of a document", () => {
    const good: TrustRules = { repositories: ["octo/app"], events: ["push"], actors: ["mark"] };
    expect(problemsOf(null)).toEqual(["The document is not an object."]);
    expect(problemsOf([])).toEqual(["The document is not an object."]);
    expect(problemsOf("rules")).toEqual(["The document is not an object."]);
    expect(problemsOf({ ...good })).toEqual([`The field format is not "trust-rules/1".`]);
    expect(problemsOf({ ...document(good), format: "trust-rules/2" })).toEqual([`The field format is not "trust-rules/1".`]);
    expect(problemsOf({ ...document(good), actor: ["mark"] })).toEqual([`The document has the unknown field "actor".`]);
    expect(problemsOf({ format: TRUST_RULES_FORMAT, repositories: ["octo/app"], events: ["push"] })).toEqual([
      "The field actors is not a list.",
    ]);
    expect(problemsOf({ ...document(good), events: "push" })).toEqual(["The field events is not a list."]);
    expect(problemsOf({ ...document(good), repositories: ["octo/app", "app", "octo/app/x", "", 7, "-octo/app", "octo/ app"] })).toEqual([
      `The entry 1 of repositories is not valid: "app".`,
      `The entry 2 of repositories is not valid: "octo/app/x".`,
      `The entry 3 of repositories is not valid: "".`,
      "The entry 4 of repositories is not valid: a value of the type number.",
      `The entry 5 of repositories is not valid: "-octo/app".`,
      `The entry 6 of repositories is not valid: "octo/ app".`,
    ]);
    expect(problemsOf({ ...document(good), repositories: ["octo/app", "Octo/App"] })).toEqual([
      `The entry 1 of repositories is in the list two times: "Octo/App".`,
    ]);
    expect(problemsOf({ ...document(good), actors: ["mark", "MARK", "marK", "a b", "renovate[bot]", "[bot]"] })).toEqual([
      `The entry 1 of actors is in the list two times: "MARK".`,
      `The entry 2 of actors is not valid: "mar\\u212a".`,
      `The entry 3 of actors is not valid: "a b".`,
      `The entry 5 of actors is not valid: "[bot]".`,
    ]);
    expect(problemsOf({ ...document(good), events: ["push", "Push", "push", "pull_request_target", "workflow_run"] })).toEqual([
      `The entry 1 of events is not valid: "Push".`,
      `The entry 2 of events is in the list two times: "push".`,
      `The event "pull_request_target" is in the list of the events, but the policy refuses it for each run.`,
      `The event "workflow_run" is in the list of the events, but the policy refuses it for each run.`,
    ]);
  });

  it("does not throw for a value of each type, and accepts only lists of valid names", () => {
    const anything = fc.anything({ withBigInt: true, withNullPrototype: true });
    const loose = fc.record(
      {
        format: fc.oneof(fc.constant(TRUST_RULES_FORMAT), anything),
        repositories: fc.oneof(fc.array(fc.oneof(repository, anything)), anything),
        events: fc.oneof(fc.array(fc.oneof(event, anything)), anything),
        actors: fc.oneof(fc.array(fc.oneof(actor, anything)), anything),
        extra: anything,
      },
      { requiredKeys: [] },
    );
    fc.assert(
      fc.property(fc.oneof(anything, loose), (value) => {
        const result = parseTrustRules(value);
        if (!result.ok) {
          expect(result.problems.length).toBeGreaterThan(0);
          return;
        }
        for (const list of [result.rules.repositories, result.rules.events, result.rules.actors]) {
          for (const entry of list) expect(entry).toMatch(/^[!-~]+$/);
        }
        for (const entry of result.rules.events) expect(OUTSIDE_INPUT_EVENTS).not.toContain(entry);
      }),
      { numRuns: 1000 },
    );
  });
});
