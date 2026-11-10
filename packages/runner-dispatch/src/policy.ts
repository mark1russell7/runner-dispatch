import { foldName, isId, sameName, type RunRecord } from "./records.ts";

/**
 * This type has the trust rules of a dispatcher, as data.
 * A run is trusted only when each list permits it. An empty list permits no run.
 */
export interface TrustRules {
  /** This list has the served repositories, each as `owner/name`. */
  readonly repositories: readonly string[];
  /** This list has the events that can start a trusted run, for example `push`. */
  readonly events: readonly string[];
  /** This list has the trusted accounts. */
  readonly actors: readonly string[];
}

/** This constant is the format id of a document of trust rules. */
export const TRUST_RULES_FORMAT = "trust-rules/1";

/**
 * This list has the events that the policy refuses, also when the rules list them.
 * A run of these events has the repository as its head repository, but its input comes from outside.
 */
export const OUTSIDE_INPUT_EVENTS: readonly string[] = Object.freeze(["pull_request_target", "workflow_run"]);

/** This type names the rule that refused a run. */
export type RefusalRule =
  | "record"
  | "repository"
  | "event"
  | "outside-input-event"
  | "head-repository"
  | "actor"
  | "triggering-actor";

/** This type is one reason that a run is not trusted. */
export interface Refusal {
  /** This field is the rule that refused the run. */
  readonly rule: RefusalRule;
  /** This field tells the reason in one sentence, for a log. */
  readonly text: string;
}

/** This type is the answer of the policy for one run. */
export interface Decision {
  /** This field is `true` only when no rule refused the run. */
  readonly trusted: boolean;
  /** This list has each rule that refused the run. It is empty for a trusted run. */
  readonly refusals: readonly Refusal[];
}

/** This type is the result of a read of a document of trust rules. */
export type TrustRulesResult =
  | { readonly ok: true; readonly rules: TrustRules }
  | { readonly ok: false; readonly problems: readonly string[] };

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
const EVENT = /^[a-z][a-z_]*$/;
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\[bot\])?$/;
const SHOWN_LENGTH = 120;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** This function gives the entries of a list of the rules. A value that is not a list gives no entry. */
function entries(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * This function shows a value of a record in a sentence.
 * It keeps the text short, and it writes each character that is not printable ASCII as an escape.
 * Thus a name from outside cannot change the lines of a log.
 */
function show(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value.slice(0, SHOWN_LENGTH)).replace(
      /[^ -~]/g,
      (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
  }
  if (value === null) return "null";
  return `a value of the type ${typeof value}`;
}

/**
 * This function decides if a run is trusted. A run is trusted only when all of these are true:
 *
 * - The record is complete.
 * - The repository is in the list of the served repositories.
 * - The event is in the list of the events, and it is not an event of `OUTSIDE_INPUT_EVENTS`.
 * - The head repository is the repository. Thus a run from a fork is not trusted.
 * - The actor of the run and the actor of this try are in the list of the trusted accounts.
 *
 * The function does not read a label, because a fork can write each label.
 * It does not throw: a record or rules with a bad shape give a run that is not trusted.
 *
 * @param rules - The trust rules
 * @param run - The record that GitHub keeps of the run
 * @returns The decision, with each rule that refused the run
 */
export function decide(rules: TrustRules, run: RunRecord): Decision {
  const refusals: Refusal[] = [];
  const refuse = (rule: RefusalRule, text: string): void => {
    refusals.push({ rule, text });
  };
  const record: Record<string, unknown> = isObject(run) ? run : {};
  const lists: Record<string, unknown> = isObject(rules) ? rules : {};
  const { repository, event, headRepository, actor, triggeringActor } = record;

  if (!isObject(run)) refuse("record", "The record of the run is not an object.");
  for (const field of ["repository", "event", "actor", "triggeringActor"]) {
    if (!isName(record[field])) refuse("record", `The field ${field} of the record is not a text with a character.`);
  }
  for (const field of ["runId", "runAttempt"]) {
    if (!isId(record[field])) refuse("record", `The field ${field} of the record is not a whole number from 1.`);
  }
  if (headRepository !== null && typeof headRepository !== "string") {
    refuse("record", "The field headRepository of the record is not a text and not null.");
  }

  if (!entries(lists["repositories"]).some((entry) => sameName(entry, repository))) {
    refuse("repository", `The repository ${show(repository)} is not in the list of the served repositories.`);
  }
  if (!isName(event) || !entries(lists["events"]).includes(event)) {
    refuse("event", `The event ${show(event)} is not in the list of the events.`);
  }
  if (isName(event) && OUTSIDE_INPUT_EVENTS.includes(event)) {
    refuse("outside-input-event", `The event ${show(event)} brings input from outside the repository.`);
  }
  if (!sameName(headRepository, repository)) {
    refuse("head-repository", `The head repository ${show(headRepository)} is not the repository ${show(repository)}.`);
  }
  if (!entries(lists["actors"]).some((entry) => sameName(entry, actor))) {
    refuse("actor", `The actor ${show(actor)} is not in the list of the trusted accounts.`);
  }
  if (!entries(lists["actors"]).some((entry) => sameName(entry, triggeringActor))) {
    refuse("triggering-actor", `The actor ${show(triggeringActor)} of this try is not in the list of the trusted accounts.`);
  }
  return { trusted: refusals.length === 0, refusals };
}

/**
 * This function reads a document of trust rules, for example from a JSON file.
 * It reports each problem of the document, so that a wrong key or a wrong name does not change the rules silently.
 *
 * @param value - The document: an object with `format`, `repositories`, `events` and `actors`
 * @returns The rules, or the list of the problems
 */
export function parseTrustRules(value: unknown): TrustRulesResult {
  if (!isObject(value)) return { ok: false, problems: ["The document is not an object."] };
  const problems: string[] = [];
  if (value["format"] !== TRUST_RULES_FORMAT) {
    problems.push(`The field format is not "${TRUST_RULES_FORMAT}".`);
  }
  const known = ["format", "repositories", "events", "actors"];
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) problems.push(`The document has the unknown field ${show(key)}.`);
  }

  const list = (key: "repositories" | "events" | "actors", shape: RegExp, fold: boolean): readonly string[] => {
    const raw = value[key];
    if (!Array.isArray(raw)) {
      problems.push(`The field ${key} is not a list.`);
      return [];
    }
    const result: string[] = [];
    const seen = new Set<string>();
    raw.forEach((entry: unknown, index) => {
      if (typeof entry !== "string" || !shape.test(entry)) {
        problems.push(`The entry ${index} of ${key} is not valid: ${show(entry)}.`);
        return;
      }
      const id = fold ? foldName(entry) : entry;
      if (seen.has(id)) {
        problems.push(`The entry ${index} of ${key} is in the list two times: ${show(entry)}.`);
        return;
      }
      seen.add(id);
      result.push(entry);
    });
    return result;
  };

  const repositories = list("repositories", REPOSITORY, true);
  const events = list("events", EVENT, false);
  const actors = list("actors", ACTOR, true);
  for (const event of events) {
    if (OUTSIDE_INPUT_EVENTS.includes(event)) {
      problems.push(`The event "${event}" is in the list of the events, but the policy refuses it for each run.`);
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    rules: {
      repositories: Object.freeze([...repositories]),
      events: Object.freeze([...events]),
      actors: Object.freeze([...actors]),
    },
  };
}
