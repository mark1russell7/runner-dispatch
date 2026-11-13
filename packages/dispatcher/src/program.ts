import {
  parseDispatchSettings,
  parseMachineTimes,
  parseTrustRules,
  type DispatchSettings,
  type MachineTimes,
  type PassReport,
  type TrustRules,
} from "@mark1russell7/runner-dispatch";
import { checkRunnerGroup, createGitHubSource, type GitHubApi, type RunnerGroupCheck } from "@mark1russell7/runner-dispatch/github";
import { createProxmoxProvider, type MachineFiles, type ProxmoxSize } from "@mark1russell7/runner-dispatch/proxmox";
import { createProxmoxClient, isProxmoxToken, proxmoxUrlProblems, type ProxmoxTransport } from "@mark1russell7/runner-dispatch/proxmox-client";
import { lint } from "@mark1russell7/service";
import type { Clock, Finding, Lifecycle, ProcessPort, Scenario, ServiceBuilder, ServiceDescription } from "@mark1russell7/service";
import { probeServer } from "@mark1russell7/service/http";
import { declare, loopProblems, PROFILES, type LoopTimes } from "./index.ts";

const s = (value: number) => ({ value, unit: "s" });

/** This constant is the format id of the document of a dispatcher program. */
export const PROGRAM_FORMAT = "dispatcher-program/1";

/** This constant is the base URL of the REST API of GitHub, the default of the field `github.url`. */
export const GITHUB_API_URL = "https://api.github.com";

/** These constants are the names of the environment variables of the two secrets. No document has a secret. */
export const SECRET_VARIABLES: { readonly github: "RUNNER_DISPATCH_GITHUB_TOKEN"; readonly proxmox: "RUNNER_DISPATCH_PROXMOX_TOKEN" } = Object.freeze({
  github: "RUNNER_DISPATCH_GITHUB_TOKEN",
  proxmox: "RUNNER_DISPATCH_PROXMOX_TOKEN",
});

/**
 * This constant is the platform of the lint of the declaration: a host with no platform of pods.
 * No probe of a kubelet adds to the windows of the declaration.
 */
export const HOST_SCENARIO: Scenario = { platform: {}, probes: { readiness: s(0), liveness: s(0) } };

/** This constant is the longest time of the check of the runner group, in milliseconds. */
export const GROUP_CHECK_TIMEOUT_MS = 30_000;

/** This record tells how the program reads GitHub. */
export interface ProgramGitHub {
  /** This field is the base URL of the REST API. */
  readonly url: string;
  /** This field is the organization of the runners, or `null` for the runners of each repository. */
  readonly organization: string | null;
  /** This field is the id of the runner group of each new runner. It is `null` without an organization. */
  readonly runnerGroup: number | null;
  /** This field is `true` when the runner group can admit a public repository. */
  readonly publicRepositories: boolean;
}

/** This record tells how the program makes machines on Proxmox VE. */
export interface ProgramProxmox {
  /** This field is the base URL of the host, for example `https://pve.example:8006`. */
  readonly url: string;
  /** This field is the pool of the machines. */
  readonly pool: string;
  /** This field has the template of each size of a machine. */
  readonly sizes: Readonly<Record<string, ProxmoxSize>>;
  /** This field has the paths of the files in the machine, or `null` for the paths `MACHINE_FILES`. The image of the machine reads them. */
  readonly files: MachineFiles | null;
}

/** This record is the address of the server of the probes. */
export interface ProgramProbes {
  /** This field is the address of the server, for example `127.0.0.1`. */
  readonly host: string;
  /** This field is the port of the server. */
  readonly port: number;
}

/** This record is a dispatcher program: each document of a dispatcher, with no secret. */
export interface Program {
  readonly rules: TrustRules;
  readonly times: MachineTimes;
  readonly settings: DispatchSettings;
  readonly loop: LoopTimes;
  /** This field is the name of the profile of the shutdown: `local` or `daemon`. */
  readonly profile: keyof typeof PROFILES;
  /** This field is the path of the stop file. When the file is there, the stop switch is on. */
  readonly stop: string;
  readonly github: ProgramGitHub;
  readonly proxmox: ProgramProxmox;
  /** This field is the address of the server of the probes, or `null` for no server. */
  readonly probes: ProgramProbes | null;
}

/** This type is the result of a reader: the value, or the list of the problems. */
export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problems: readonly string[] };

/** This record has the two secrets of a program. */
export interface Secrets {
  /** This field is the token of the REST API of GitHub. */
  readonly github: string;
  /** This field is the API token of Proxmox VE, as `USER@REALM!TOKENID=SECRET`. */
  readonly proxmox: string;
}

const PROGRAM_KEYS: readonly string[] = ["format", "rules", "times", "settings", "loop", "profile", "stop", "github", "proxmox", "probes"];
const GITHUB_KEYS: readonly string[] = ["url", "organization", "runnerGroup", "publicRepositories"];
const PROXMOX_KEYS: readonly string[] = ["url", "pool", "sizes", "files"];
const PROBES_KEYS: readonly string[] = ["host", "port"];
const LOOP_KEYS: readonly string[] = ["sleep", "bound", "retry", "retryMax", "close"];
const GITHUB_TOKEN = /^[!-~]{1,1024}$/;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);
const isWhole = (value: unknown, low: number, high: number): value is number => typeof value === "number" && Number.isInteger(value) && value >= low && value <= high;

/** This function gives a problem for each key of a record that the list does not have. */
const unknownKeys = (record: Readonly<Record<string, unknown>>, keys: readonly string[], where: string): string[] =>
  Object.keys(record)
    .filter((key) => !keys.includes(key))
    .map((key) => `The ${where} has the unknown field ${JSON.stringify(key.slice(0, 40))}.`);

/** This function gives the problems of a document of a part, each with the name of the part. */
const within = (part: string, problems: readonly string[]): string[] => problems.map((problem) => `${part}: ${problem}`);

function readGitHub(value: unknown, problems: string[]): ProgramGitHub | null {
  if (!isRecord(value)) {
    problems.push("The field github is not an object.");
    return null;
  }
  problems.push(...unknownKeys(value, GITHUB_KEYS, "field github"));
  const url = value["url"] ?? GITHUB_API_URL;
  if (typeof url !== "string" || !/^https:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/.test(url)) problems.push("The field github.url is not an https URL with no query and no user.");
  const organization = value["organization"] ?? null;
  if (organization !== null && (typeof organization !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(organization))) {
    problems.push("The field github.organization is not a name of GitHub.");
  }
  const runnerGroup = value["runnerGroup"] ?? null;
  if (organization !== null && !isWhole(runnerGroup, 1, Number.MAX_SAFE_INTEGER)) {
    problems.push("The field github.runnerGroup is not a whole number from 1. A program with an organization names its runner group.");
  }
  if (organization === null && runnerGroup !== null) problems.push("The field github.runnerGroup has no organization. A runner of a repository is in its default group.");
  const publicRepositories = value["publicRepositories"] ?? false;
  if (typeof publicRepositories !== "boolean") problems.push("The field github.publicRepositories is not true or false.");
  return {
    url: String(url).replace(/\/+$/, ""),
    organization: typeof organization === "string" ? organization : null,
    runnerGroup: typeof runnerGroup === "number" ? runnerGroup : null,
    publicRepositories: publicRepositories === true,
  };
}

function readProxmox(value: unknown, problems: string[]): ProgramProxmox | null {
  if (!isRecord(value)) {
    problems.push("The field proxmox is not an object.");
    return null;
  }
  problems.push(...unknownKeys(value, PROXMOX_KEYS, "field proxmox"));
  problems.push(...within("proxmox.url", proxmoxUrlProblems(value["url"])));
  if (typeof value["pool"] !== "string") problems.push("The field proxmox.pool is not a text.");
  if (!isRecord(value["sizes"])) problems.push("The field proxmox.sizes is not an object.");
  const files = value["files"] ?? null;
  if (files !== null && !isRecord(files)) problems.push("The field proxmox.files is not an object.");
  return {
    url: String(value["url"]),
    pool: String(value["pool"]),
    sizes: (isRecord(value["sizes"]) ? value["sizes"] : {}) as Readonly<Record<string, ProxmoxSize>>,
    files: isRecord(files) ? (files as unknown as MachineFiles) : null,
  };
}

function readProbes(value: unknown, problems: string[]): ProgramProbes | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    problems.push("The field probes is not an object.");
    return null;
  }
  problems.push(...unknownKeys(value, PROBES_KEYS, "field probes"));
  const host = value["host"] ?? "127.0.0.1";
  if (typeof host !== "string" || !/^[A-Za-z0-9.:-]{1,253}$/.test(host)) problems.push("The field probes.host is not a host name or an address.");
  if (!isWhole(value["port"], 1, 65_535)) problems.push("The field probes.port is not a port from 1 to 65535.");
  return { host: String(host), port: Number(value["port"]) };
}

function readLoop(value: unknown, problems: string[]): LoopTimes | null {
  if (!isRecord(value)) {
    problems.push("The field loop is not an object.");
    return null;
  }
  problems.push(...unknownKeys(value, LOOP_KEYS, "field loop"));
  return value as unknown as LoopTimes;
}

/**
 * This function reads the document of a dispatcher program. The document has each document of a dispatcher, and no secret.
 *
 * - The fields `rules`, `times` and `settings` are the documents `trust-rules/1`, `machine-times/1` and `dispatch-settings/1`.
 * - The field `loop` has the times of the loop. They keep the time `pass` of the machines.
 * - Proxmox VE has a template for each size of the settings.
 *
 * @param value - The parsed JSON of the document
 * @returns The program, or each problem
 */
export function parseProgram(value: unknown): Result<Program> {
  if (!isRecord(value)) return { ok: false, problems: ["The document is not an object."] };
  const problems: string[] = [];
  if (value["format"] !== PROGRAM_FORMAT) problems.push(`The field format is not "${PROGRAM_FORMAT}".`);
  problems.push(...unknownKeys(value, PROGRAM_KEYS, "document"));
  const rules = parseTrustRules(value["rules"]);
  if (!rules.ok) problems.push(...within("rules", rules.problems));
  const times = parseMachineTimes(value["times"]);
  if (!times.ok) problems.push(...within("times", times.problems));
  const settings = parseDispatchSettings(value["settings"]);
  if (!settings.ok) problems.push(...within("settings", settings.problems));
  const loop = readLoop(value["loop"], problems);
  if (loop !== null && times.ok) problems.push(...within("loop", loopProblems(loop, times.times.pass)));
  const profile = value["profile"];
  if (profile !== "local" && profile !== "daemon") problems.push('The field profile is not "local" or "daemon".');
  const stop = value["stop"];
  if (typeof stop !== "string" || !(stop.startsWith("/") || /^[A-Za-z]:[\\/]/.test(stop))) problems.push("The field stop is not an absolute path.");
  const github = readGitHub(value["github"], problems);
  const proxmox = readProxmox(value["proxmox"], problems);
  const probes = readProbes(value["probes"], problems);
  if (settings.ok && proxmox !== null) {
    for (const size of settings.settings.sizes) {
      if (!Object.hasOwn(proxmox.sizes, size)) problems.push(`The size ${size} of the settings has no template in the field proxmox.sizes.`);
    }
  }
  if (problems.length > 0 || !rules.ok || !times.ok || !settings.ok || loop === null || github === null || proxmox === null) return { ok: false, problems };
  return {
    ok: true,
    value: { rules: rules.rules, times: times.times, settings: settings.settings, loop, profile: profile as Program["profile"], stop: String(stop), github, proxmox, probes },
  };
}

/**
 * This function reads the two secrets from the environment. The text of a problem names the variable, and it has no value.
 *
 * @param env - The environment of the process
 * @returns The secrets, or each problem
 */
export function readSecrets(env: Readonly<Record<string, string | undefined>>): Result<Secrets> {
  const github = env[SECRET_VARIABLES.github];
  const proxmox = env[SECRET_VARIABLES.proxmox];
  const problems: string[] = [];
  if (github === undefined || github === "") problems.push(`The variable ${SECRET_VARIABLES.github} is not set.`);
  else if (!GITHUB_TOKEN.test(github)) problems.push(`The variable ${SECRET_VARIABLES.github} is not a token: it has a space, a line break or a character that is not ASCII.`);
  if (proxmox === undefined || proxmox === "") problems.push(`The variable ${SECRET_VARIABLES.proxmox} is not set.`);
  else if (!isProxmoxToken(proxmox)) problems.push(`The variable ${SECRET_VARIABLES.proxmox} is not of the form USER@REALM!TOKENID=SECRET.`);
  return problems.length > 0 || github === undefined || proxmox === undefined ? { ok: false, problems } : { ok: true, value: { github, proxmox } };
}

/** This record is one line of the log of a program. No line has a secret or a one-job configuration. */
export type LogLine =
  | { readonly event: "pass"; readonly report: Omit<PassReport, "lives">; readonly machines: number }
  | { readonly event: "pass-failed"; readonly failures: number; readonly text: string }
  | { readonly event: "problem"; readonly text: string }
  | { readonly event: "runner-group"; readonly check: RunnerGroupCheck }
  | { readonly event: "declaration"; readonly findings: readonly Pick<Finding, "rule" | "scope" | "verdict">[] };

/** These are the ports of a program: the clients of the two APIs, the stop file, the log, and the parts of a test. */
export interface ProgramPorts {
  /** This function makes the client of the REST API of GitHub. */
  readonly github: (options: { readonly url: string; readonly token: string }) => GitHubApi<AbortSignal>;
  /** This function makes the transport of the client of Proxmox VE, for its base URL. */
  readonly proxmox: (url: string) => ProxmoxTransport<AbortSignal>;
  /** This function tells if the stop file is there. */
  readonly exists: (path: string) => Promise<boolean>;
  /** This function writes one line of the log. */
  readonly log: (line: LogLine) => void;
  /** This clock is for a test. The default is the clock of the platform. */
  readonly clock?: Clock | undefined;
  /** This process is for a test. The default is the process of Node.js. */
  readonly process?: ProcessPort | undefined;
  /** This function is for a test. It gives the random numbers of the jitter. */
  readonly random?: (() => number) | undefined;
  /** This function is for a test. It gives the last part of the name of a new machine. */
  readonly suffix?: (() => string) | undefined;
  /** This signal is for a test. It stops the check of the runner group. The default is a timeout of `GROUP_CHECK_TIMEOUT_MS`. */
  readonly signal?: AbortSignal | undefined;
}

/** This record is a prepared program: the builder of the service, its declaration as data, and the findings of its lint. */
export interface Prepared {
  readonly builder: ServiceBuilder;
  readonly description: ServiceDescription;
  readonly findings: readonly Finding[];
  /** This field is the result of the check of the runner group, or `null` without an organization. */
  readonly group: RunnerGroupCheck | null;
}

/** This function tells if a pass did something: a log keeps only these passes, and each change of the count of waits. */
const busy = (report: PassReport): boolean =>
  report.stopped !== false ||
  report.cut ||
  report.steps.length + report.adopted.length + report.destroys.length + report.removals.length + report.made.length + report.failures.length > 0;

/** This function gives the text of an error, for a problem. */
const textOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * This function prepares a program. It starts nothing, and it sends only the requests of the check of the runner group.
 *
 * - With an organization, it checks that the runner group admits only the served repositories, before the first pass.
 * - It declares the service, and it examines the declaration with `lint()` on a host with no platform of pods.
 * - A check that fails, an option that a part refuses and a rule that the declaration violates are each a problem.
 *
 * @param program - The program
 * @param secrets - The two secrets
 * @param ports - The ports of the program
 * @returns The prepared program, or each problem
 * @throws Error when GitHub does not answer the check of the runner group. The text of the error has no secret.
 */
export async function prepareProgram(program: Program, secrets: Secrets, ports: ProgramPorts): Promise<Result<Prepared>> {
  const api = ports.github({ url: program.github.url, token: secrets.github });
  let group: RunnerGroupCheck | null = null;
  if (program.github.organization !== null && program.github.runnerGroup !== null) {
    const signal = ports.signal ?? AbortSignal.timeout(GROUP_CHECK_TIMEOUT_MS);
    group = await checkRunnerGroup(
      api,
      program.github.organization,
      program.github.runnerGroup,
      { served: program.rules.repositories, publicRepositories: program.github.publicRepositories },
      signal,
    );
    ports.log({ event: "runner-group", check: group });
    if (!group.pass) return { ok: false, problems: group.problems.map((problem) => `The runner group ${program.github.runnerGroup}: ${problem}`) };
  }

  let builder: ServiceBuilder;
  let waits = -1;
  try {
    const client = createProxmoxClient({ url: program.proxmox.url, token: secrets.proxmox, transport: ports.proxmox(program.proxmox.url) });
    const provider = createProxmoxProvider({
      api: client,
      pool: program.proxmox.pool,
      sizes: program.proxmox.sizes,
      ...(program.proxmox.files === null ? {} : { files: program.proxmox.files }),
      problem: (text) => ports.log({ event: "problem", text }),
    });
    const source = createGitHubSource({
      api,
      ...(program.github.organization === null ? {} : { organization: program.github.organization }),
      ...(program.github.runnerGroup === null ? {} : { runnerGroup: program.github.runnerGroup }),
    });
    builder = declare({
      rules: program.rules,
      times: program.times,
      settings: program.settings,
      source,
      provider,
      stopped: () => ports.exists(program.stop),
      loop: program.loop,
      profile: PROFILES[program.profile],
      onReport: (report) => {
        if (!busy(report) && report.waits.length === waits) return;
        waits = report.waits.length;
        const { lives, ...rest } = report;
        ports.log({ event: "pass", report: rest, machines: lives.length });
      },
      onError: (error, failures) => ports.log({ event: "pass-failed", failures, text: textOf(error) }),
      clock: ports.clock,
      random: ports.random,
      suffix: ports.suffix,
    });
    if (program.probes !== null) builder = builder.healthServer(probeServer({ host: program.probes.host, port: program.probes.port, server_retry_after: s(1) }));
  } catch (error) {
    if (error instanceof RangeError) return { ok: false, problems: [error.message] };
    throw error;
  }

  const description = builder.describe();
  const findings = lint(description, HOST_SCENARIO, []);
  ports.log({ event: "declaration", findings: findings.map(({ rule, scope, verdict }) => ({ rule, scope, verdict })) });
  const violated = findings.filter((finding) => finding.verdict === "violated");
  if (violated.length > 0) {
    return { ok: false, problems: violated.map((finding) => `The declaration violates the rule ${finding.rule} at ${finding.scope}.`) };
  }
  return { ok: true, value: { builder, description, findings, group } };
}

/**
 * This function starts a prepared program. The program operates until its shutdown.
 *
 * @param prepared - The prepared program
 * @param ports - The ports of the program. Give the clock of `prepareProgram` again.
 * @returns The lifecycle of the service. Its promise `done` gives the exit code.
 */
export function runProgram(prepared: Prepared, ports: Pick<ProgramPorts, "clock" | "process">): Promise<Lifecycle> {
  return prepared.builder.run({ ...(ports.clock === undefined ? {} : { clock: ports.clock }), ...(ports.process === undefined ? {} : { process: ports.process }) });
}

/**
 * This function gives the URL of the liveness probe of a program.
 * An address that takes each interface gives the loopback address.
 *
 * @param probes - The address of the server of the probes
 * @returns The URL
 */
export function livenessUrl(probes: ProgramProbes): string {
  const host = probes.host === "0.0.0.0" ? "127.0.0.1" : probes.host === "::" ? "::1" : probes.host;
  return `http://${host.includes(":") ? `[${host}]` : host}:${probes.port}/liveness`;
}
