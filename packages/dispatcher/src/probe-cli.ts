/**
 * The command line of the probe of a real credential: `runner-dispatch-probe --repository <owner/name> [options]`.
 *
 * The token comes from the variable of the program. The record `github-probe/1` goes to stdout as JSON, and each problem
 * goes to stderr. Each line goes through `redactSecrets` of `@mark1russell7/text/redact` with the token.
 */
import { randomBytes } from "node:crypto";
import { redactSecrets } from "@mark1russell7/text/redact";
import { httpTransport } from "@procedures/gh";
import { USER_AGENT, type CliIo } from "./cli.ts";
import { GITHUB_API_URL, isGitHubToken, SECRET_VARIABLES } from "./program.ts";
import { PROBE_LABEL, PROBE_ROUNDS, PROBE_TRIES, PROBE_TRIES_MAX, PROBE_TRIES_MIN, probeGitHub, settingsProblems, type ProbePorts, type ProbeSettings } from "./probe.ts";

/** This text tells how to use the command. */
export const PROBE_USAGE: string = [
  "Usage: runner-dispatch-probe --repository <owner/name> [--organization <name>] [--label <label>]... [--tries <n>] [--group]",
  "",
  "  --repository    The repository of the probe",
  "  --organization  The organization of the runners. Without it, the runner registers on the repository",
  `  --label         A label of the one-job runner. The default is ${PROBE_LABEL}`,
  `  --tries         The count of the conditional requests, from ${PROBE_TRIES_MIN} to ${PROBE_TRIES_MAX}. The default is ${PROBE_TRIES}`,
  "  --group         Make a runner group in the organization for the runner, and remove it after",
  "  -h, --help      This text",
  "",
  `The token comes from the variable ${SECRET_VARIABLES.github}. Each other client of its user adds noise to the measure of an answer 304.`,
  `The probe repeats a round with noise, at most ${PROBE_ROUNDS} times.`,
  "The probe makes one runner and removes it at once. The record goes to stdout as JSON. No output has the token.",
  "Exit codes: 0 a record, 1 a problem or a runner or group that stays on GitHub, 2 a bad command.",
].join("\n");

/** This record is a command: a probe with its settings, the help, or a bad command with its problem. */
export type ProbeCommand =
  | { readonly kind: "probe"; readonly settings: ProbeSettings }
  | { readonly kind: "help" }
  | { readonly kind: "usage"; readonly problem: string };

/**
 * This function reads the arguments of the command. The help comes first: with `-h` or `--help`, the other arguments
 * are not examined.
 *
 * @param args - The arguments after the name of the command
 * @returns The command
 */
export function parseProbeCommand(args: readonly string[]): ProbeCommand {
  if (args.includes("-h") || args.includes("--help")) return { kind: "help" };
  let repository: string | null = null;
  let organization: string | null = null;
  const labels: string[] = [];
  let tries: string | null = null;
  let group = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--group") {
      if (group) return { kind: "usage", problem: "The option --group is in the command two times." };
      group = true;
      continue;
    }
    if (arg !== "--repository" && arg !== "--organization" && arg !== "--label" && arg !== "--tries") {
      return { kind: "usage", problem: arg.startsWith("-") ? `The option ${arg} is not an option of the command.` : `The argument ${arg} has no option.` };
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) return { kind: "usage", problem: `The option ${arg} has no value.` };
    index += 1;
    if (arg === "--label") {
      labels.push(value);
      continue;
    }
    if ((arg === "--repository" && repository !== null) || (arg === "--organization" && organization !== null) || (arg === "--tries" && tries !== null)) {
      return { kind: "usage", problem: `The option ${arg} is in the command two times.` };
    }
    if (arg === "--repository") repository = value;
    else if (arg === "--organization") organization = value;
    else tries = value;
  }
  if (repository === null) return { kind: "usage", problem: "The command has no option --repository." };
  if (tries !== null && !/^\d{1,3}$/.test(tries)) return { kind: "usage", problem: `The count of the conditional requests is not a whole number from ${PROBE_TRIES_MIN} to ${PROBE_TRIES_MAX}.` };
  const settings: ProbeSettings = {
    repository,
    organization,
    labels: labels.length === 0 ? [PROBE_LABEL] : labels,
    tries: tries === null ? PROBE_TRIES : Number(tries),
    group,
  };
  const problems = settingsProblems(settings);
  return problems.length > 0 ? { kind: "usage", problem: problems.join(" ") } : { kind: "probe", settings };
}

/**
 * This function is the command. It reads the token, it makes the probe, and it writes the record.
 *
 * @param args - The arguments after the name of the command
 * @param io - The environment and the two outputs
 * @param over - The ports that replace the ports of Node.js, for a test or for the signal of the process
 * @returns The exit code: 0 for a record, 1 for a problem or a runner or group that stays on GitHub, 2 for a bad command
 */
export async function probeMain(args: readonly string[], io: Pick<CliIo, "env" | "out" | "err">, over: Partial<Omit<ProbePorts, "token">> = {}): Promise<number> {
  const token = io.env[SECRET_VARIABLES.github];
  const secrets = token === undefined || token === "" ? [] : [token];
  const out = (line: string): void => io.out(redactSecrets(line, secrets));
  const err = (line: string): void => io.err(redactSecrets(line, secrets));
  const command = parseProbeCommand(args);
  if (command.kind === "help") {
    out(PROBE_USAGE);
    return 0;
  }
  if (command.kind === "usage") {
    err(command.problem);
    err(PROBE_USAGE);
    return 2;
  }
  if (token === undefined || token === "") {
    err(`The variable ${SECRET_VARIABLES.github} is not set.`);
    return 1;
  }
  if (!isGitHubToken(token)) {
    err(`The variable ${SECRET_VARIABLES.github} is not a token: it has a space, a line break or a character that is not ASCII.`);
    return 1;
  }
  try {
    const record = await probeGitHub(command.settings, {
      token,
      baseUrl: GITHUB_API_URL,
      userAgent: USER_AGENT,
      transport: httpTransport,
      suffix: () => randomBytes(4).toString("hex"),
      now: () => new Date().toISOString(),
      signal: new AbortController().signal,
      ...over,
    });
    out(JSON.stringify(record, null, 2));
    if (!record.clean) {
      err("The probe did not remove its runner or its group. Remove each name that starts with runner-dispatch-probe on GitHub.");
      return 1;
    }
    return 0;
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
