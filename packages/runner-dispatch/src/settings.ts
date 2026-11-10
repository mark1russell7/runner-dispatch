import { isObject, show } from "./policy.ts";
import { isId, parseRunLabel, type RunLabelParts } from "./records.ts";

/** This record has the settings of a dispatcher. */
export interface DispatchSettings {
  /** This field is the first part of the name of each machine. No other runner of the served repositories uses it. */
  readonly prefix: string;
  /** This field is the largest count of machines at one time. */
  readonly capacity: number;
  /** This list has each size class that the provider makes. */
  readonly sizes: readonly string[];
  /** This field is the size class of a job that names no size. It is in the list `sizes`. */
  readonly standard: string;
}

/** This text is the format of a document of the settings of a dispatcher. */
export const DISPATCH_SETTINGS_FORMAT = "dispatch-settings/1";

/** This number is the largest capacity of a dispatcher. */
export const DISPATCH_CAPACITY_MAX = 1000;

/** This type is the result of `parseDispatchSettings`: the settings, or the list of the problems. */
export type DispatchSettingsResult =
  | { readonly ok: true; readonly settings: DispatchSettings }
  | { readonly ok: false; readonly problems: readonly string[] };

const PREFIX = /^[a-z][a-z0-9]{0,15}$/;
const SIZE = /^[a-z][a-z0-9-]{0,31}$/;
const SUFFIX = /^[0-9a-f]{8}$/;
const KEYS: readonly string[] = Object.freeze(["format", "prefix", "capacity", "sizes", "standard"]);

const isSize = (value: unknown): value is string => typeof value === "string" && SIZE.test(value) && parseRunLabel(value) === null;

/**
 * This function gives the problems of a record of settings. It reads the fields `prefix`, `capacity`, `sizes` and `standard`.
 *
 * @param value - The record
 * @returns The problems. The list is empty for valid settings.
 */
export function settingsProblems(value: unknown): string[] {
  if (!isObject(value)) return ["The settings are not an object."];
  const problems: string[] = [];
  const { prefix, capacity, sizes, standard } = value;
  if (typeof prefix !== "string" || !PREFIX.test(prefix)) {
    problems.push(`The field prefix is not a small letter, then 15 small letters or digits at most: ${show(prefix)}.`);
  }
  if (!isId(capacity) || capacity > DISPATCH_CAPACITY_MAX) {
    problems.push(`The field capacity is not a whole number from 1 to ${DISPATCH_CAPACITY_MAX}: ${show(capacity)}.`);
  }
  const seen = new Set<string>();
  if (!Array.isArray(sizes) || sizes.length === 0) {
    problems.push("The field sizes is not a list with an entry.");
  } else {
    sizes.forEach((entry: unknown, index) => {
      if (!isSize(entry)) {
        problems.push(`The entry ${index} of sizes is not the name of a size, or it is a run label: ${show(entry)}.`);
      } else if (seen.has(entry)) {
        problems.push(`The entry ${index} of sizes is in the list two times: ${show(entry)}.`);
      } else {
        seen.add(entry);
      }
    });
  }
  if (typeof standard !== "string" || !seen.has(standard)) {
    problems.push(`The field standard is not a size of the list sizes: ${show(standard)}.`);
  }
  return problems;
}

/**
 * This function reads a document of the settings of a dispatcher, for example from a JSON file.
 * The document has no default: the operator gives each field.
 *
 * @param value - The value of the document
 * @returns The settings, or the list of the problems
 */
export function parseDispatchSettings(value: unknown): DispatchSettingsResult {
  if (!isObject(value)) return { ok: false, problems: ["The document is not an object."] };
  const problems: string[] = [];
  if (value["format"] !== DISPATCH_SETTINGS_FORMAT) {
    problems.push(`The field format is not "${DISPATCH_SETTINGS_FORMAT}".`);
  }
  for (const key of Object.keys(value)) {
    if (!KEYS.includes(key)) problems.push(`The document has the unknown field ${show(key)}.`);
  }
  problems.push(...settingsProblems(value));
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    settings: Object.freeze({
      prefix: value["prefix"] as string,
      capacity: value["capacity"] as number,
      sizes: Object.freeze([...(value["sizes"] as string[])]),
      standard: value["standard"] as string,
    }),
  };
}

/**
 * This function gives the name of a machine: `<prefix>-<id of the run>-<try>-<suffix>`.
 * The runner of the machine has the same name.
 *
 * @param prefix - The prefix of the settings
 * @param run - The id of the run and the number of its try
 * @param suffix - 8 digits of base 16, in small letters. It makes the name different from each other name of the run.
 * @returns The name
 * @throws RangeError when a part is not valid
 */
export function machineName(prefix: string, run: RunLabelParts, suffix: string): string {
  if (typeof prefix !== "string" || !PREFIX.test(prefix)) throw new RangeError("The prefix of a machine name is not valid.");
  if (!isId(run.runId) || !isId(run.runAttempt)) {
    throw new RangeError("A machine name needs the id of the run and the number of its try, each a whole number from 1.");
  }
  if (typeof suffix !== "string" || !SUFFIX.test(suffix)) {
    throw new RangeError("The suffix of a machine name is not 8 digits of base 16 in small letters.");
  }
  return `${prefix}-${run.runId}-${run.runAttempt}-${suffix}`;
}

/**
 * This function reads the name of a machine. Each name that it reads is a name that `machineName` gives for the prefix.
 * The dispatcher uses it to find its runner registrations.
 *
 * @param prefix - The prefix of the settings
 * @param name - The name of a machine or of a runner
 * @returns The id of the run and the number of its try, or `null` when the name is not a name of this dispatcher
 */
export function parseMachineName(prefix: string, name: string): RunLabelParts | null {
  if (typeof prefix !== "string" || typeof name !== "string" || !PREFIX.test(prefix)) return null;
  const parts = name.split("-");
  if (parts.length !== 4 || parts[0] !== prefix || !SUFFIX.test(parts[3] ?? "")) return null;
  return parseRunLabel(`run-${parts[1]}-${parts[2]}`);
}

/**
 * This function gives the size class that the labels of a job ask for.
 * A job that the dispatcher serves names the run label, and one size of the settings at most.
 *
 * @param settings - The settings of the dispatcher
 * @param label - The run label of the run of the job
 * @param labels - The labels of the job
 * @returns The size, or `null` when the job names no run label or a label that the dispatcher does not serve
 */
export function sizeOfLabels(settings: DispatchSettings, label: string, labels: readonly string[]): string | null {
  if (!Array.isArray(labels) || !labels.includes(label)) return null;
  const others = [...new Set(labels.filter((each: unknown) => each !== label))];
  if (others.length === 0) return settings.standard;
  const named: unknown = others[0];
  return others.length === 1 && typeof named === "string" && settings.sizes.includes(named) ? named : null;
}

/**
 * This function gives the labels of the runner of a machine: the run label and the size.
 * A runner with these labels takes each job of its run that names its size, or no size.
 *
 * @param label - The run label
 * @param size - The size class of the machine
 * @returns The labels
 */
export function runnerLabels(label: string, size: string): readonly string[] {
  return [label, size];
}
