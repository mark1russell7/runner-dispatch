/**
 * The command line of the probe of a real credential: `runner-dispatch-probe --repository <owner/name> [options]`.
 *
 * The token comes from the variable of the program, or from stdin with `--token-stdin`. The record `github-probe/1` goes
 * to stdout as JSON, or to the file of `--out`. Each problem goes to stderr. Each line goes through `redactSecrets` of
 * `@mark1russell7/text/redact` with the token.
 */
import { randomBytes } from "node:crypto";
import { errorMessage } from "@mark1russell7/text";
import { redactSecrets } from "@mark1russell7/text/redact";
import { httpTransport } from "@procedures/gh";
import { USER_AGENT, type CliIo } from "./cli.ts";
import { GITHUB_API_URL, isGitHubToken, SECRET_VARIABLES } from "./program.ts";
import { PROBE_LABEL, PROBE_ROUNDS, PROBE_TRIES, PROBE_TRIES_MAX, PROBE_TRIES_MIN, probeGitHub, settingsProblems, type ProbePorts, type ProbeSettings } from "./probe.ts";

/** This text tells how to use the command. */
export const PROBE_USAGE: string = [
  "Usage: runner-dispatch-probe --repository <owner/name> [--organization <name>] [--label <label>]... [--tries <n>] [--group]",
  "                             [--token-stdin] [--out <file>]",
  "",
  "  --repository    The repository of the probe",
  "  --organization  The organization of the runners. Without it, the runner registers on the repository",
  `  --label         A label of the one-job runner. The default is ${PROBE_LABEL}`,
  `  --tries         The count of the conditional requests, from ${PROBE_TRIES_MIN} to ${PROBE_TRIES_MAX}. The default is ${PROBE_TRIES}`,
  "  --group         Make a runner group in the organization for the runner, and remove it after",
  `  --token-stdin   Read the token from stdin, not from the variable ${SECRET_VARIABLES.github}`,
  "  --out           Write the record to this file as UTF-8 JSON, not to stdout",
  "  -h, --help      This text",
  "",
  `The token comes from the variable ${SECRET_VARIABLES.github}, or from stdin with --token-stdin. Thus the token is not on the command line.`,
  "Each other client of the user of the token adds noise to the measure of an answer 304.",
  `The probe repeats a round with noise, at most ${PROBE_ROUNDS} times.`,
  "The probe makes one runner and removes it at once. The record goes to stdout as JSON, or to the file of --out. No output has the token.",
  "Exit codes: 0 a record, 1 a problem or a runner or group that stays on GitHub, 2 a bad command.",
].join("\n");

/**
 * This record is a command: a probe with its settings, the help, or a bad command with its problem.
 * A probe reads its token from stdin when `tokenStdin` is `true`. It writes its record to the file `out` when `out` is not `null`.
 */
export type ProbeCommand =
  | { readonly kind: "probe"; readonly settings: ProbeSettings; readonly tokenStdin: boolean; readonly out: string | null }
  | { readonly kind: "help" }
  | { readonly kind: "usage"; readonly problem: string };

/** This record has the parts of Node.js that the probe command uses. */
export interface ProbeIo extends Pick<CliIo, "env" | "out" | "err"> {
  /** This function reads all of stdin. The command uses it only with `--token-stdin`. */
  readStdin(): Promise<string>;
  /** This function writes a text file. The command uses it only with `--out`. */
  writeText(path: string, text: string): Promise<void>;
}

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
  let out: string | null = null;
  let group = false;
  let tokenStdin = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--group" || arg === "--token-stdin") {
      if (arg === "--group" ? group : tokenStdin) return { kind: "usage", problem: `The option ${arg} is in the command two times.` };
      if (arg === "--group") group = true;
      else tokenStdin = true;
      continue;
    }
    if (arg !== "--repository" && arg !== "--organization" && arg !== "--label" && arg !== "--tries" && arg !== "--out") {
      return { kind: "usage", problem: arg.startsWith("-") ? `The option ${arg} is not an option of the command.` : `The argument ${arg} has no option.` };
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) return { kind: "usage", problem: `The option ${arg} has no value.` };
    index += 1;
    if (arg === "--label") {
      labels.push(value);
      continue;
    }
    const before = arg === "--repository" ? repository : arg === "--organization" ? organization : arg === "--tries" ? tries : out;
    if (before !== null) return { kind: "usage", problem: `The option ${arg} is in the command two times.` };
    if (arg === "--repository") repository = value;
    else if (arg === "--organization") organization = value;
    else if (arg === "--tries") tries = value;
    else out = value;
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
  return problems.length > 0 ? { kind: "usage", problem: problems.join(" ") } : { kind: "probe", settings, tokenStdin, out };
}

/**
 * This function is the command. It reads the token, it makes the probe, and it writes the record.
 *
 * @param args - The arguments after the name of the command
 * @param io - The environment, stdin, the two outputs and the write of a file
 * @param over - The ports that replace the ports of Node.js, for a test or for the signal of the process
 * @returns The exit code: 0 for a record, 1 for a problem or a runner or group that stays on GitHub, 2 for a bad command
 */
export async function probeMain(args: readonly string[], io: ProbeIo, over: Partial<Omit<ProbePorts, "token">> = {}): Promise<number> {
  const variable = io.env[SECRET_VARIABLES.github];
  const secrets = variable === undefined || variable === "" ? [] : [variable];
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
  let token = variable;
  let source = `The variable ${SECRET_VARIABLES.github}`;
  if (command.tokenStdin) {
    source = "The text on stdin";
    try {
      token = (await io.readStdin()).trim();
    } catch (error) {
      err(`The command cannot read stdin: ${errorMessage(error)}`);
      return 1;
    }
    if (token === "") {
      err("The option --token-stdin needs the token on stdin, but stdin is empty.");
      return 1;
    }
    secrets.push(token);
  } else if (token === undefined || token === "") {
    err(`The variable ${SECRET_VARIABLES.github} is not set. Set it, or give the token on stdin with --token-stdin.`);
    return 1;
  }
  if (!isGitHubToken(token)) {
    err(`${source} is not a token: it has a space, a line break or a character that is not ASCII.`);
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
    const text = JSON.stringify(record, null, 2);
    let written = true;
    if (command.out === null) out(text);
    else {
      try {
        await io.writeText(command.out, `${redactSecrets(text, secrets)}\n`);
        out(`The record is in ${command.out}.`);
      } catch (error) {
        // The record goes to stdout, so the facts of the probe stay.
        err(`The command cannot write the file ${command.out}: ${errorMessage(error)}`);
        out(text);
        written = false;
      }
    }
    if (!record.clean) {
      err("The probe did not remove its runner or its group. Remove each name that starts with runner-dispatch-probe on GitHub.");
      return 1;
    }
    return written ? 0 : 1;
  } catch (error) {
    err(errorMessage(error));
    return 1;
  }
}
