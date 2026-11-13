import { decide, isObject, isRepositoryName, parseTrustRules, show, TRUST_RULES_FORMAT, type RefusalRule, type TrustRules } from "./policy.ts";
import { isId, sameName, sameRun, type RunKey, type RunRecord } from "./records.ts";

/**
 * This type is the environment of the job-started script of a runner.
 * The runner program gives the variables `GITHUB_*` of the job to the script.
 * A probe measured for the runner program 2.338.2 on Linux that the key `env` of a workflow adds no variable.
 */
export type JobEnvironment = Readonly<Record<string, string | undefined>>;

/** This type has the settings of the check of one machine. The dispatcher writes them when it makes the machine. */
export interface CheckSettings {
  /** This field has the trust rules of the dispatcher. */
  readonly rules: TrustRules;
  /** This field is the run that the machine serves. */
  readonly run: RunKey;
}

/** This constant is the format id of a document of check settings. */
export const CHECK_SETTINGS_FORMAT = "machine-check/1";

/**
 * This type names the rule that refused a job on the machine.
 * The rule `event-file` refuses an event file that is not usable. The rule `machine` refuses the job of a different run.
 */
export type CheckRule = RefusalRule | "event-file" | "machine";

/** This type is one reason that the check refused a job. */
export interface CheckRefusal {
  /** This field is the rule that refused the job. */
  readonly rule: CheckRule;
  /** This field tells the reason in one sentence, for the log of the job. */
  readonly text: string;
}

/** This type is the answer of the check for one job. */
export interface JobCheck {
  /** This field is `true` only when no rule refused the job. */
  readonly pass: boolean;
  /** This field is the record of the run, as the check read it on the machine. */
  readonly run: RunRecord;
  /** This list has each rule that refused the job. It is empty when the job passes. */
  readonly refusals: readonly CheckRefusal[];
}

/** This type is the result of a read of a document of check settings. */
export type CheckSettingsResult =
  | { readonly ok: true; readonly settings: CheckSettings }
  | { readonly ok: false; readonly problems: readonly string[] };

const ID_TEXT = /^[1-9][0-9]{0,15}$/;

/** This function gives a field of an object. A value that is not an object has no field. */
function field(value: unknown, key: string): unknown {
  return isObject(value) && Object.hasOwn(value, key) ? value[key] : undefined;
}

/** This function gives a text, or the empty text for a value that is not a text. */
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * This function reads an id from the text of a variable. It reads only decimal digits with no zero at the start.
 * It gives 0 for each other text, and the policy refuses a record with the id 0.
 */
function id(value: unknown): number {
  if (typeof value !== "string" || !ID_TEXT.test(value)) return 0;
  const number = Number(value);
  return isId(number) ? number : 0;
}

/**
 * This function gives the repository of the head commit of a job.
 * For a pull request, it is the head repository of the pull request. A fork that no longer exists gives `null`.
 * For each other event, the head commit is in the repository of the event.
 */
function headRepository(eventName: string, event: unknown): string | null {
  const ofPullRequest = (isObject(event) && Object.hasOwn(event, "pull_request")) || eventName.startsWith("pull_request");
  const name = ofPullRequest
    ? field(field(field(field(event, "pull_request"), "head"), "repo"), "full_name")
    : field(field(event, "repository"), "full_name");
  return typeof name === "string" && name.length > 0 ? name : null;
}

/**
 * This function reads the record of the run of a job on the machine of the job.
 * It reads the variables of the job-started script and the document of the event file (`GITHUB_EVENT_PATH`).
 * It does not expand a value, and it does not throw.
 * A field that the job does not give is the empty text or 0, and the policy refuses such a record.
 *
 * @param environment - The environment of the job-started script
 * @param event - The document of the event file of the job
 * @returns The record of the run
 */
export function readJobRun(environment: JobEnvironment, event: unknown): RunRecord {
  const eventName = text(field(environment, "GITHUB_EVENT_NAME"));
  return {
    repository: text(field(environment, "GITHUB_REPOSITORY")),
    runId: id(field(environment, "GITHUB_RUN_ID")),
    runAttempt: id(field(environment, "GITHUB_RUN_ATTEMPT")),
    event: eventName,
    headRepository: headRepository(eventName, event),
    actor: text(field(environment, "GITHUB_ACTOR")),
    triggeringActor: text(field(environment, "GITHUB_TRIGGERING_ACTOR")),
  };
}

/**
 * This function is the check on the machine. It decides if a job can start on the machine.
 * A job passes only when all of these are true:
 *
 * - The policy trusts the run of the job, with the record that the machine reads.
 * - The event file is an object, and it names the repository of the job.
 * - The run of the job is the run that the machine serves.
 *
 * The check does not need the decision of the dispatcher. Thus it stops a job that got the label of a trusted run.
 * It does not throw: settings, variables or a document with a bad shape give a job that does not pass.
 *
 * @param settings - The trust rules and the run of the machine
 * @param environment - The environment of the job-started script
 * @param event - The document of the event file of the job
 * @returns The answer, with each rule that refused the job
 */
export function checkJob(settings: CheckSettings, environment: JobEnvironment, event: unknown): JobCheck {
  const run = readJobRun(environment, event);
  const refusals: CheckRefusal[] = [...decide(field(settings, "rules") as TrustRules, run).refusals];
  if (!isObject(event)) {
    refusals.push({ rule: "event-file", text: "The event file of the job is not an object." });
  } else if (!sameName(field(field(event, "repository"), "full_name"), run.repository)) {
    refusals.push({ rule: "event-file", text: "The event file does not name the repository of the job." });
  }
  const machine = field(settings, "run");
  if (!isObject(machine) || !sameRun(run, machine as unknown as RunKey)) {
    refusals.push({ rule: "machine", text: "The run of the job is not the run of this machine." });
  }
  return { pass: refusals.length === 0, run, refusals };
}

/** This type is the document of check settings, as a machine reads it from a JSON file. */
export interface CheckSettingsDocument {
  /** This field is the format id of the document. */
  readonly format: typeof CHECK_SETTINGS_FORMAT;
  /** This field has the trust rules, with their format id. */
  readonly rules: TrustRules & { readonly format: typeof TRUST_RULES_FORMAT };
  /** This field is the run that the machine serves. */
  readonly run: RunKey;
}

/**
 * This function gives the document of the check settings of one machine. `parseCheckSettings` reads it back to the same settings.
 * A provider writes the document on the machine as JSON.
 *
 * @param settings - The settings of the check of the machine
 * @returns The document, with the format id of the settings and of the trust rules
 */
export function checkSettingsDocument(settings: CheckSettings): CheckSettingsDocument {
  const { rules, run } = settings;
  return {
    format: CHECK_SETTINGS_FORMAT,
    rules: { format: TRUST_RULES_FORMAT, repositories: [...rules.repositories], events: [...rules.events], actors: [...rules.actors] },
    run: { repository: run.repository, runId: run.runId, runAttempt: run.runAttempt },
  };
}

/**
 * This function reads a document of check settings, for example from a JSON file on the machine.
 * It reports each problem of the document. The dispatcher uses it before it sends the document to a machine.
 *
 * @param value - The document: an object with `format`, `rules` and `run`
 * @returns The settings, or the list of the problems
 */
export function parseCheckSettings(value: unknown): CheckSettingsResult {
  if (!isObject(value)) return { ok: false, problems: ["The document is not an object."] };
  const problems: string[] = [];
  if (value["format"] !== CHECK_SETTINGS_FORMAT) {
    problems.push(`The field format is not "${CHECK_SETTINGS_FORMAT}".`);
  }
  for (const key of Object.keys(value)) {
    if (!["format", "rules", "run"].includes(key)) problems.push(`The document has the unknown field ${show(key)}.`);
  }

  const rules = parseTrustRules(field(value, "rules"));
  if (!rules.ok) {
    for (const problem of rules.problems) problems.push(`The field rules: ${problem}`);
  }

  const run = field(value, "run");
  if (!isObject(run)) {
    problems.push("The field run is not an object.");
  } else {
    for (const key of Object.keys(run)) {
      if (!["repository", "runId", "runAttempt"].includes(key)) problems.push(`The field run has the unknown field ${show(key)}.`);
    }
    if (!isRepositoryName(field(run, "repository"))) problems.push("The field run.repository is not the name of a repository.");
    if (!isId(field(run, "runId"))) problems.push("The field run.runId is not a whole number from 1.");
    if (!isId(field(run, "runAttempt"))) problems.push("The field run.runAttempt is not a whole number from 1.");
  }

  if (problems.length > 0 || !rules.ok || !isObject(run)) return { ok: false, problems };
  return {
    ok: true,
    settings: {
      rules: rules.rules,
      run: Object.freeze({
        repository: run["repository"] as string,
        runId: run["runId"] as number,
        runAttempt: run["runAttempt"] as number,
      }),
    },
  };
}
