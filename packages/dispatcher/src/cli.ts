/**
 * The command line of the dispatcher: `runner-dispatch <program.json> [--check]`.
 *
 * The command reads the document of a program and the two tokens, and it makes the ports of Node.js.
 * These are the REST client of `@procedures/gh` for GitHub, the transport of `src/transport.ts` for Proxmox VE, and the stop file.
 * Each log line goes to stdout as one line of JSON. Each problem goes to stderr. Each line goes through `redactSecrets`
 * of `@mark1russell7/text/redact` with the two tokens, thus no output has a token.
 */
import { access, readFile } from "node:fs/promises";
import type { GitHubApi } from "@mark1russell7/runner-dispatch/github";
import { redactSecrets } from "@mark1russell7/text/redact";
import { createRestClient, type RestClientOptions } from "@procedures/gh";
import { parseProgram, prepareProgram, readSecrets, runProgram, SECRET_VARIABLES, type LogLine, type ProgramPorts } from "./program.ts";
import { proxmoxTransport } from "./transport.ts";

/** This constant is the `user-agent` header of each request to GitHub. */
export const USER_AGENT = "runner-dispatch";

/** This text tells how to use the command. */
export const USAGE: string = [
  "Usage: runner-dispatch <program.json> [--check]",
  "",
  "  <program.json>  The document dispatcher-program/1 of the program",
  "  --check         Prepare the program, write its log lines, and stop before the first pass",
  "  -h, --help      This text",
  "",
  `The tokens come from the variables ${SECRET_VARIABLES.github} and ${SECRET_VARIABLES.proxmox}.`,
  "Each log line goes to stdout as one line of JSON. Problems go to stderr. No output has a token.",
  "Exit codes: 0 a stop with no error or a check with no problem, 1 a problem, 2 a bad command.",
].join("\n");

/** This record is a command: a run or a check of a program, the help, or a bad command with its problem. */
export type Command =
  | { readonly kind: "run"; readonly path: string; readonly check: boolean }
  | { readonly kind: "help" }
  | { readonly kind: "usage"; readonly problem: string };

/**
 * This function reads the arguments of the command. The help comes first: with `-h` or `--help`, the other arguments
 * are not examined.
 *
 * @param args - The arguments after the name of the command
 * @returns The command
 */
export function parseCommand(args: readonly string[]): Command {
  if (args.includes("-h") || args.includes("--help")) return { kind: "help" };
  let path: string | null = null;
  let check = false;
  for (const arg of args) {
    if (arg === "--check") {
      if (check) return { kind: "usage", problem: "The option --check is in the command two times." };
      check = true;
    } else if (arg.startsWith("-")) {
      return { kind: "usage", problem: `The option ${arg} is not an option of the command.` };
    } else if (path === null) {
      path = arg;
    } else {
      return { kind: "usage", problem: "The command takes one path of a program." };
    }
  }
  return path === null ? { kind: "usage", problem: "The command has no path of a program." } : { kind: "run", path, check };
}

/** This record has the parts of Node.js that the command uses: the environment, the program file and the two outputs. */
export interface CliIo {
  /** This field is the environment of the process. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** This function reads a text file. */
  readText(path: string): Promise<string>;
  /** This function writes one line to stdout. */
  out(line: string): void;
  /** This function writes one line to stderr. */
  err(line: string): void;
}

/** This function gives the parts of Node.js for the command. */
export function nodeIo(): CliIo {
  return {
    env: process.env,
    readText: (path) => readFile(path, "utf8"),
    out: (line) => {
      process.stdout.write(`${line}\n`);
    },
    err: (line) => {
      process.stderr.write(`${line}\n`);
    },
  };
}

/**
 * This function makes the GitHub API of the dispatcher on the REST client of `@procedures/gh`. The client adds the
 * token, sends a conditional request for a stored answer, and keeps the limits of the rate of GitHub.
 *
 * @param options - The options of the REST client
 * @returns The GitHub API
 */
export function restGitHubApi(options: RestClientOptions): GitHubApi<AbortSignal> {
  const client = createRestClient(options);
  return {
    async request(request, signal) {
      const answer = await client.request({ method: request.method, path: request.path, query: request.query, body: request.body }, signal);
      return { status: answer.status, body: answer.body };
    },
  };
}

/**
 * This function tells if a file is there. A file that is not there gives `false`. Each other error goes to the caller.
 * Thus a stop file that the process cannot examine makes the pass fail, and the stop switch does not change.
 *
 * @param path - The path of the file
 * @returns `true` when the file is there
 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

/**
 * This function gives the ports of a program on Node.js. A test gives its own ports in `over`.
 *
 * @param write - The function that writes one line of the log
 * @param over - The ports that replace the ports of Node.js
 * @returns The ports
 */
export function nodePorts(write: (line: string) => void, over: Partial<ProgramPorts> = {}): ProgramPorts {
  return {
    github: ({ url, token }) => restGitHubApi({ token, baseUrl: url, userAgent: USER_AGENT }),
    proxmox: proxmoxTransport,
    exists: fileExists,
    log: (line: LogLine) => write(JSON.stringify(line)),
    ...over,
  };
}

/** This function gives the texts of the tokens in the environment: each value, and the secret part of a token of Proxmox VE. */
const tokensOf = (env: Readonly<Record<string, string | undefined>>): string[] =>
  Object.values(SECRET_VARIABLES).flatMap((name) => {
    const value = env[name];
    if (value === undefined || value === "") return [];
    const split = value.indexOf("=");
    return split > 0 && split < value.length - 1 ? [value, value.slice(split + 1)] : [value];
  });

/** This function gives the text of an error for a problem. */
const textOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * This function is the command. It reads the program and the two tokens, and it prepares the program.
 * With `--check`, it stops after the preparation. Else it starts the service, and it waits for its exit.
 *
 * @param args - The arguments after the name of the command
 * @param io - The environment, the program file and the two outputs
 * @param over - The ports that replace the ports of Node.js, for a test
 * @returns The exit code: 0 for a stop with no error or a check with no problem, 1 for a problem, 2 for a bad command
 */
export async function main(args: readonly string[], io: CliIo, over: Partial<ProgramPorts> = {}): Promise<number> {
  const tokens = tokensOf(io.env);
  const out = (line: string): void => io.out(redactSecrets(line, tokens));
  const err = (line: string): void => io.err(redactSecrets(line, tokens));
  const command = parseCommand(args);
  if (command.kind === "help") {
    out(USAGE);
    return 0;
  }
  if (command.kind === "usage") {
    err(command.problem);
    err(USAGE);
    return 2;
  }
  let text: string;
  try {
    text = await io.readText(command.path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    err(`The command cannot read the program file ${command.path}${typeof code === "string" ? ` (${code})` : ""}.`);
    return 1;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    err(`The program file ${command.path} is not JSON.`);
    return 1;
  }
  const program = parseProgram(value);
  const secrets = readSecrets(io.env);
  if (!program.ok || !secrets.ok) {
    for (const problem of [...(program.ok ? [] : program.problems), ...(secrets.ok ? [] : secrets.problems)]) err(problem);
    return 1;
  }
  const ports = nodePorts(out, over);
  try {
    const prepared = await prepareProgram(program.value, secrets.value, ports);
    if (!prepared.ok) {
      for (const problem of prepared.problems) err(problem);
      return 1;
    }
    if (command.check) {
      out(JSON.stringify({ event: "checked" }));
      return 0;
    }
    const life = await runProgram(prepared.value, ports);
    return await life.done;
  } catch (error) {
    err(textOf(error));
    return 1;
  }
}
