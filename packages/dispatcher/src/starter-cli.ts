/**
 * The command line of the starter: `runner-dispatch-starter <root> --runner <folder> --check <file>`.
 *
 * The command starts the runner program of each folder in the root, one at a time, and it stops when no folder waits.
 * It needs no token. Each log line goes to stdout as one line of JSON, and each problem goes to stderr.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Clock } from "@mark1russell7/algebra/clock";
import { FOLDER_FILES } from "@mark1russell7/runner-dispatch/folder";
import { nodeProcess, type ProcessPort } from "@mark1russell7/service";
import { nodeHostPorts, type ProcessesPort, type SpawnRequest } from "@mark1russell7/service/host";
import { errorMessage } from "@mark1russell7/text";
import { redactSecrets } from "@mark1russell7/text/redact";
import type { CliIo } from "./cli.ts";
import { folderFilePath, nodeFolderStore, type StarterStore } from "./folders.ts";
import { startRunners, STARTER_TIMES, type OutputStream, type StarterTimes } from "./starter.ts";

/** These are the variables of the environment of the starter that the runner program gets. The runner program gets no other variable of the starter. */
export const KEPT_VARIABLES: readonly string[] = ["PATH", "HOME", "USER", "LANG", "TMPDIR"];

/** This variable of the runner program names the script that starts before each job. */
export const HOOK_VARIABLE = "ACTIONS_RUNNER_HOOK_JOB_STARTED";

/** The runner program reads its option `--jitconfig` from this variable, and it removes the variable before it starts a job. */
export const CONFIGURATION_VARIABLE = "ACTIONS_RUNNER_INPUT_JITCONFIG";

/** This text tells how to use the command. */
export const STARTER_USAGE: string = [
  "Usage: runner-dispatch-starter <root> --runner <folder> --check <file> [--node <file>] [--deadline <s>] [--poll <s>] [--grace <s>]",
  "",
  "  <root>      The absolute path of the root of the folders of the machines",
  "  --runner    The absolute path of the folder of the runner program, with run.sh",
  "  --check     The absolute path of the job-started program of @mark1russell7/runner-dispatch",
  "  --node      The absolute path of the Node.js of the check. The default is the Node.js of the command",
  `  --deadline  The longest time of one runner, in seconds. The default is ${STARTER_TIMES.deadline}`,
  `  --poll      The time between two reads of a folder, in seconds. The default is ${STARTER_TIMES.poll}`,
  `  --grace     The time from SIGINT to SIGKILL, in seconds. The default is ${STARTER_TIMES.grace}`,
  "  -h, --help  This text",
  "",
  "A SIGTERM or a SIGINT stops the runner that operates. The command then writes exited and stops.",
  "Exit codes: 0 no folder waits, or a stop at a signal. 1 a problem. 2 a bad command.",
].join("\n");

/** This record is the settings of the start of the runner program. */
export interface StarterSettings {
  readonly root: string;
  readonly runner: string;
  readonly check: string;
  /** This field is the Node.js of the check, or `null` for the Node.js of the command. */
  readonly node: string | null;
  readonly times: StarterTimes;
}

/** This record is a command: a start, the help, or a bad command with its problem. */
export type StarterCommand =
  | { readonly kind: "start"; readonly settings: StarterSettings }
  | { readonly kind: "help" }
  | { readonly kind: "usage"; readonly problem: string };

const PATH_OPTIONS = ["--runner", "--check", "--node"] as const;
const TIME_OPTIONS = ["--deadline", "--poll", "--grace"] as const;
const NUMBER = /^\d+(?:\.\d+)?$/;

/**
 * This function reads the arguments of the command. The help comes first: with `-h` or `--help`, the function does
 * not examine the other arguments.
 *
 * @param args - The arguments after the name of the command
 * @returns The command
 */
export function parseStarterCommand(args: readonly string[]): StarterCommand {
  if (args.includes("-h") || args.includes("--help")) return { kind: "help" };
  const values = new Map<string, string>();
  const roots: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if ((PATH_OPTIONS as readonly string[]).includes(arg) || (TIME_OPTIONS as readonly string[]).includes(arg)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) return { kind: "usage", problem: `The option ${arg} has no value.` };
      if (values.has(arg)) return { kind: "usage", problem: `The option ${arg} is in the command two times.` };
      values.set(arg, value);
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) return { kind: "usage", problem: `The option ${arg} is not an option of the command.` };
    roots.push(arg);
  }
  if (roots.length !== 1) return { kind: "usage", problem: "The command takes one root." };
  const root = roots[0] as string;
  if (!isAbsolute(root)) return { kind: "usage", problem: "The root is not an absolute path." };
  for (const option of ["--runner", "--check"] as const) {
    if (!values.has(option)) return { kind: "usage", problem: `The command has no option ${option}.` };
  }
  for (const option of PATH_OPTIONS) {
    const value = values.get(option);
    if (value !== undefined && !isAbsolute(value)) return { kind: "usage", problem: `The value of the option ${option} is not an absolute path.` };
  }
  const times: Record<keyof StarterTimes, number> = { ...STARTER_TIMES };
  for (const option of TIME_OPTIONS) {
    const value = values.get(option);
    if (value === undefined) continue;
    const seconds = Number(value);
    const name = option.slice(2) as keyof StarterTimes;
    if (!NUMBER.test(value) || (name !== "grace" && seconds === 0)) {
      return { kind: "usage", problem: `The value of the option ${option} is not a number of seconds${name === "grace" ? "" : " above 0"}.` };
    }
    times[name] = seconds;
  }
  return {
    kind: "start",
    settings: { root, runner: values.get("--runner") as string, check: values.get("--check") as string, node: values.get("--node") ?? null, times },
  };
}

const UNSAFE = /['\r\n\0]/;

/**
 * This function gives the script that the runner program starts before each job. It starts the check with the path of
 * the file `check.json` of the folder.
 *
 * Each path is in the script, thus no variable of a job changes the check or its settings.
 *
 * @param node - The absolute path of Node.js
 * @param check - The absolute path of the job-started program
 * @param settings - The absolute path of the file `check.json`
 * @returns The text of the script
 * @throws RangeError when a path is not absolute, or has a quotation mark or a line break
 */
export function hookScript(node: string, check: string, settings: string): string {
  for (const path of [node, check, settings]) {
    if (!isAbsolute(path) || UNSAFE.test(path)) throw new RangeError("A path of the hook script is not an absolute path with no quotation mark and no line break.");
  }
  return `#!/bin/sh\nexec '${node}' '${check}' '${settings}'\n`;
}

/**
 * This function gives the environment of the runner program. It has only the kept variables of the starter, the hook
 * script and the configuration.
 *
 * @param env - The environment of the starter
 * @param hook - The absolute path of the hook script
 * @param configuration - The one-job configuration
 * @returns The environment
 */
export function runnerEnvironment(env: Readonly<Record<string, string | undefined>>, hook: string, configuration: string): Readonly<Record<string, string>> {
  const kept: Record<string, string> = {};
  for (const name of KEPT_VARIABLES) {
    const value = env[name];
    if (value !== undefined) kept[name] = value;
  }
  return { ...kept, [HOOK_VARIABLE]: hook, [CONFIGURATION_VARIABLE]: configuration };
}

/** This port keeps the hook scripts of the runners in one temporary folder. */
export interface HookFolder {
  /** This method writes the hook script of a folder, with the mode `0o700`, and gives its path. */
  write(folder: string, text: string): Promise<string>;
  /** This method removes the temporary folder. */
  remove(): Promise<void>;
}

/** These are the ports of the command. A test gives fakes. */
export interface StarterCliPorts {
  readonly processes: Pick<ProcessesPort, "spawn" | "signal" | "signalGroup">;
  readonly clock: Pick<Clock, "now" | "after">;
  readonly wall: () => number;
  readonly store: (root: string) => StarterStore;
  readonly hooks: () => Promise<HookFolder>;
  /** This field is the Node.js of the command, the default of `--node`. */
  readonly node: string;
  readonly process?: ProcessPort | undefined;
}

/** This function gives the hook folder of Node.js: a new folder in the temporary folder of the system. */
export async function nodeHookFolder(): Promise<HookFolder> {
  const path = await mkdtemp(join(tmpdir(), "runner-dispatch-hooks-"));
  return {
    async write(folder, text) {
      const file = join(path, `${folder}.sh`);
      await writeFile(file, text, { mode: 0o700, flag: "wx" });
      return file;
    },
    remove: () => rm(path, { recursive: true, force: true }),
  };
}

/** This function gives the ports of Node.js for the command. */
export function nodeStarterPorts(): StarterCliPorts {
  const host = nodeHostPorts();
  return {
    processes: host.processes,
    clock: host.clock,
    wall: host.wall,
    store: (root) => nodeFolderStore(root),
    hooks: nodeHookFolder,
    node: process.execPath,
  };
}

/** This function gives each complete line of a stream to `line`, and keeps the rest of the stream until the next part. */
const lineSplitter = (line: (text: string) => void) => {
  let rest = "";
  const decoder = new TextDecoder();
  return {
    add(chunk: string | Uint8Array): void {
      rest += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      const parts = rest.split("\n");
      rest = parts.pop() ?? "";
      for (const part of parts) line(part.replace(/\r$/, ""));
    },
    flush(): void {
      if (rest !== "") line(rest);
      rest = "";
    },
  };
};

/**
 * This function is the command. It starts the runner program of each folder that waits, and it stops when no folder waits.
 *
 * - Each output line of a runner program goes to stdout as the line `output`.
 * - Each line goes through `redactSecrets` with each configuration that the starter read.
 *
 * @param args - The arguments after the name of the command
 * @param io - The environment and the two outputs
 * @param ports - The processes, the clocks, the store and the hook folder
 * @returns The exit code: 0 when no folder waits or at a signal, 1 for a problem and 2 for a bad command
 */
export async function starterMain(args: readonly string[], io: CliIo, ports: StarterCliPorts = nodeStarterPorts()): Promise<number> {
  const command = parseStarterCommand(args);
  if (command.kind === "help") {
    io.out(STARTER_USAGE);
    return 0;
  }
  if (command.kind === "usage") {
    io.err(command.problem);
    io.err(STARTER_USAGE);
    return 2;
  }
  const { settings } = command;
  const configurations: string[] = [];
  const out = (value: unknown): void => io.out(redactSecrets(JSON.stringify(value), configurations));
  const err = (line: string): void => io.err(redactSecrets(line, configurations));

  let store: StarterStore;
  try {
    store = ports.store(settings.root);
  } catch (error) {
    err(errorMessage(error));
    return 1;
  }
  const stop = new AbortController();
  const host = ports.process ?? nodeProcess;
  const offs = (["SIGINT", "SIGTERM"] as const).map((trigger) => host.on(trigger, () => stop.abort()));
  const splitters = new Map<string, ReturnType<typeof lineSplitter>>();
  let hooks: HookFolder | null = null;
  try {
    const folder = await ports.hooks();
    hooks = folder;
    const request = async (name: string, configuration: string): Promise<SpawnRequest> => {
      configurations.push(configuration.trim());
      const script = hookScript(settings.node ?? ports.node, settings.check, folderFilePath(settings.root, name, FOLDER_FILES.check));
      const hook = await folder.write(name, script);
      return { program: join(settings.runner, "run.sh"), args: [], cwd: settings.runner, env: runnerEnvironment(io.env, hook, configuration.trim()), ipc: false };
    };
    const output = (name: string, stream: OutputStream, chunk: string | Uint8Array): void => {
      const key = `${name}\n${stream}`;
      let splitter = splitters.get(key);
      if (splitter === undefined) {
        splitter = lineSplitter((line) => out({ event: "output", folder: name, stream, line }));
        splitters.set(key, splitter);
      }
      splitter.add(chunk);
    };
    const result = await startRunners(
      {
        store,
        processes: ports.processes,
        clock: ports.clock,
        wall: ports.wall,
        request,
        log: (line) => {
          if (line.event === "exited") for (const [key, splitter] of splitters) if (key.startsWith(`${line.exit.folder}\n`)) splitter.flush();
          out(line);
        },
        output,
      },
      settings.times,
      stop.signal,
    );
    out({ event: "starter", end: result.end, runners: result.runners.length });
    return 0;
  } catch (error) {
    err(errorMessage(error));
    return 1;
  } finally {
    for (const off of offs) off();
    await hooks?.remove();
  }
}
