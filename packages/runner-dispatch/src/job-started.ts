import { checkJob, parseCheckSettings, type JobEnvironment } from "./check.ts";
import { isObject, show } from "./policy.ts";

/** This type is the result of the job-started program: the exit code and the lines for the log of the job. */
export interface JobStartedResult {
  /**
   * This field is the exit code. The code 0 lets the job start.
   * The code 1 tells that the check refused the job. The code 2 tells that the check cannot read its settings.
   * The runner program fails the job for each code that is not 0.
   */
  readonly code: 0 | 1 | 2;
  /** This list has the lines for the log of the job. The author of the job can read them. */
  readonly lines: readonly string[];
}

function unusable(reason: string): JobStartedResult {
  return { code: 2, lines: [`The check on the machine cannot start. ${reason}`] };
}

/**
 * This function is the job-started program of a machine, without its input and output.
 * The runner program starts the program before the first step of a job, and a code that is not 0 fails the job.
 *
 * The function reads the settings file of the machine and the event file of the job, and it gives the answer of `checkJob`.
 * It fails closed: a file that it cannot read gives a code that is not 0. It does not throw.
 * The lines do not show the trust rules, because the author of the job can read the log.
 *
 * @param args - The arguments of the program: the path of the settings file
 * @param environment - The environment of the program
 * @param read - A function that gives the text of a file. It throws when it cannot read the file.
 * @returns The exit code and the lines for the log
 */
export function jobStarted(
  args: readonly string[],
  environment: JobEnvironment,
  read: (path: string) => string,
): JobStartedResult {
  const settingsPath = Array.isArray(args) && args.length === 1 ? (args[0] as unknown) : undefined;
  if (typeof settingsPath !== "string" || settingsPath.length === 0) {
    return unusable("It needs one argument: the path of its settings file.");
  }
  let document: unknown;
  try {
    document = JSON.parse(read(settingsPath));
  } catch {
    return unusable("It cannot read its settings file as JSON.");
  }
  const parsed = parseCheckSettings(document);
  if (!parsed.ok) {
    return unusable(`Its settings file is not valid. The count of the problems is ${parsed.problems.length}.`);
  }

  let event: unknown;
  try {
    const eventPath = isObject(environment) ? environment["GITHUB_EVENT_PATH"] : undefined;
    event = typeof eventPath === "string" && eventPath.length > 0 ? JSON.parse(read(eventPath)) : undefined;
  } catch {
    event = undefined;
  }

  const check = checkJob(parsed.settings, environment, event);
  if (check.pass) {
    const { repository, runId, runAttempt } = check.run;
    return {
      code: 0,
      lines: [`The check on the machine passed: the run ${runId}, try ${runAttempt}, of ${show(repository)}.`],
    };
  }
  return {
    code: 1,
    lines: ["The check on the machine refused this job.", ...check.refusals.map((refusal) => `- ${refusal.rule}: ${refusal.text}`)],
  };
}
