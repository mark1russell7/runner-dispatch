/**
 * This record is the part of a workflow run that the policy reads.
 * GitHub keeps each field, and a fork cannot change them.
 */
export interface RunRecord {
  /** This field is the repository of the run, as `owner/name`. */
  readonly repository: string;
  /** This field is the id of the run. */
  readonly runId: number;
  /** This field is the number of the try of the run. The first number is 1. */
  readonly runAttempt: number;
  /** This field is the event that started the run, for example `push`. */
  readonly event: string;
  /** This field is the repository of the head commit, as `owner/name`. It is `null` when GitHub gives none. */
  readonly headRepository: string | null;
  /** This field is the account that started the first try of the run. */
  readonly actor: string;
  /** This field is the account that started this try of the run. */
  readonly triggeringActor: string;
}

/** This record is one job of a workflow run that waits for a runner. */
export interface JobRecord {
  /** This field is the repository of the job, as `owner/name`. */
  readonly repository: string;
  /** This field is the id of the job. */
  readonly jobId: number;
  /** This field is the id of the run of the job. */
  readonly runId: number;
  /** This field is the number of the try of the run. */
  readonly runAttempt: number;
  /** This field has the labels that the job asks for. A fork can write each label. */
  readonly labels: readonly string[];
}

/** This record is one machine that a provider makes for the jobs of one run. */
export interface MachineRecord {
  /** This field is the name of the machine. The provider gives it. */
  readonly name: string;
  /** This field is the size class of the machine, for example `small`. */
  readonly size: string;
  /** This field is the repository of the run of the machine, as `owner/name`. */
  readonly repository: string;
  /** This field is the id of the run of the machine. */
  readonly runId: number;
  /** This field is the number of the try of the run of the machine. */
  readonly runAttempt: number;
}

/** This type is the identity of one try of one run. */
export interface RunKey {
  /** This field is the repository of the run, as `owner/name`. */
  readonly repository: string;
  /** This field is the id of the run. */
  readonly runId: number;
  /** This field is the number of the try of the run. */
  readonly runAttempt: number;
}

/** This type is the part of a run label: the id of the run and the number of its try. */
export interface RunLabelParts {
  /** This field is the id of the run. */
  readonly runId: number;
  /** This field is the number of the try of the run. */
  readonly runAttempt: number;
}

const RUN_LABEL = /^run-([1-9][0-9]{0,15})-([1-9][0-9]{0,15})$/;

/**
 * This function tells if a value is an id that GitHub can give: a whole number from 1 that JavaScript keeps exactly.
 *
 * @param value - The value to examine
 * @returns `true` when the value is such a number
 */
export function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * This function changes the letters `A` to `Z` of a name to small letters. Each other character stays.
 * GitHub compares the names of accounts and repositories without case, and these names have only ASCII characters.
 * Thus a character that only looks like a letter does not become that letter.
 *
 * @param name - The name of an account or of a repository
 * @returns The name in small ASCII letters
 */
export function foldName(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));
}

/**
 * This function compares two names of accounts or of repositories as GitHub does: without the case of ASCII letters.
 * An empty name is equal to no name.
 *
 * @param a - The first name
 * @param b - The second name
 * @returns `true` when the two names are the same name
 */
export function sameName(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length === 0 || b.length === 0) return false;
  return foldName(a) === foldName(b);
}

/**
 * This function gives the label of the runner of one try of one run: `run-<id>-<try>`.
 * The dispatcher gives this label to the runner, and the workflow names it in `runs-on`.
 *
 * @param run - The id of the run and the number of its try
 * @returns The label
 * @throws RangeError when the id or the number is not a whole number from 1
 */
export function runLabel(run: RunLabelParts): string {
  if (!isId(run.runId) || !isId(run.runAttempt)) {
    throw new RangeError("A run label needs the id of the run and the number of its try, each a whole number from 1.");
  }
  return `run-${run.runId}-${run.runAttempt}`;
}

/**
 * This function reads a run label. Each label that it reads is a label that `runLabel` gives.
 *
 * @param label - The label of a runner or of a job
 * @returns The id of the run and the number of its try, or `null` when the label is not a run label
 */
export function parseRunLabel(label: string): RunLabelParts | null {
  if (typeof label !== "string") return null;
  const match = RUN_LABEL.exec(label);
  if (match === null) return null;
  const runId = Number(match[1]);
  const runAttempt = Number(match[2]);
  if (!isId(runId) || !isId(runAttempt)) return null;
  return { runId, runAttempt };
}

/**
 * This function tells if two records name the same try of the same run of the same repository.
 * The check on the machine compares the run of a job with the run of its machine.
 *
 * @param a - The first record: a run, a job or a machine
 * @param b - The second record
 * @returns `true` when the repository, the id and the number of the try are the same
 */
export function sameRun(a: RunKey, b: RunKey): boolean {
  if (!isId(a.runId) || !isId(a.runAttempt)) return false;
  return a.runId === b.runId && a.runAttempt === b.runAttempt && sameName(a.repository, b.repository);
}
