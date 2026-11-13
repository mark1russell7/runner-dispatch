import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import type { GitHubApi } from "@mark1russell7/runner-dispatch/github";
import type { ProxmoxTransport } from "@mark1russell7/runner-dispatch/proxmox-client";
import { countingSuffix, fakeGitHubApi, fakeProxmox, fakeWorld, type FakeProxmox, type FakeWorld } from "@mark1russell7/runner-dispatch/testing";
import { UNIT_BOUND_RULE, type Lifecycle } from "@mark1russell7/service";
import { nodeHostPorts, probeOnce } from "@mark1russell7/service/host";
import { fakeClock, fakeProcess, type FakeClock } from "@mark1russell7/service/testing";
import { describe, expect, it } from "vitest";
import {
  GITHUB_API_URL,
  livenessUrl,
  parseProgram,
  prepareProgram,
  readSecrets,
  runProgram,
  SECRET_VARIABLES,
  type LogLine,
  type Program,
  type ProgramPorts,
} from "./program.ts";
import { doc, GITHUB_TOKEN, groupApi, noProxmox, ORGANIZATION, PROXMOX_TOKEN, PVE, REPO, SECRETS, settle, wireOf } from "./fixtures.ts";

const programOf = (over: Record<string, unknown> = {}): Program => {
  const read = parseProgram(doc(over));
  if (!read.ok) throw new Error(read.problems.join(" "));
  return read.value;
};

const problemsOf = (value: unknown): readonly string[] => {
  const read = parseProgram(value);
  return read.ok ? [] : read.problems;
};

describe("parseProgram", () => {
  it("reads a document, with the default URL of GitHub, no organization, no probes and the default files", () => {
    const read = parseProgram(doc());
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.github).toEqual({ url: GITHUB_API_URL, organization: null, runnerGroup: null, publicRepositories: false });
    expect(read.value.probes).toBeNull();
    expect(read.value.proxmox.files).toBeNull();
    expect(read.value.settings.sizes).toEqual(["small"]);
    expect(read.value.times.pass).toBe(10);
    expect(read.value.profile).toBe("local");
  });

  it("reads an organization with its runner group, the probes with the default host, the files and a Windows path of the stop file", () => {
    const files = { check: "/run/rd/check.json", configuration: "/run/rd/configuration" };
    const read = parseProgram(
      doc({
        github: { url: "https://ghe.example/api/v3/", organization: "octo", runnerGroup: 3, publicRepositories: true },
        probes: { port: 9464 },
        proxmox: { ...(doc()["proxmox"] as object), files },
        stop: "C:\\runner-dispatch\\stop",
        profile: "daemon",
      }),
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.github).toEqual({ url: "https://ghe.example/api/v3", organization: "octo", runnerGroup: 3, publicRepositories: true });
    expect(read.value.probes).toEqual({ host: "127.0.0.1", port: 9464 });
    expect(read.value.proxmox.files).toEqual(files);
    expect(read.value.profile).toBe("daemon");
  });

  const bad: readonly (readonly [string, unknown, string])[] = [
    ["a value that is not an object", [], "The document is not an object."],
    ["another format", doc({ format: "dispatcher-program/2" }), 'The field format is not "dispatcher-program/1".'],
    ["an unknown field", doc({ token: "x" }), 'The document has the unknown field "token".'],
    ["trust rules with actors that are not a list", doc({ rules: { format: "trust-rules/1", repositories: [REPO], events: ["push"], actors: "octo" } }), "rules: The field actors is not a list."],
    ["times that are not a document", doc({ times: 10 }), "times: "],
    ["settings with another standard size", doc({ settings: { format: "dispatch-settings/1", prefix: "rd", capacity: 2, sizes: ["small"], standard: "large" } }), "settings: "],
    ["no loop", doc({ loop: undefined }), "The field loop is not an object."],
    ["a loop that breaks the time pass", doc({ loop: { sleep: 9, bound: 2, retry: 1, retryMax: 2, close: 0.5 } }), "loop: The longest time between two passes is 11 s."],
    ["an unknown field of the loop", doc({ loop: { sleep: 5, bound: 2, retry: 1, retryMax: 2, close: 0.5, jitter: 1 } }), 'The field loop has the unknown field "jitter".'],
    ["another profile", doc({ profile: "kubernetes" }), 'The field profile is not "local" or "daemon".'],
    ["a relative path of the stop file", doc({ stop: "stop" }), "The field stop is not an absolute path."],
    ["no field github", doc({ github: undefined }), "The field github is not an object."],
    ["an http URL of GitHub", doc({ github: { url: "http://ghe.example/api/v3" } }), "The field github.url is not an https URL with no query and no user."],
    ["a URL of GitHub with a user", doc({ github: { url: "https://user@ghe.example" } }), "The field github.url is not an https URL with no query and no user."],
    ["a bad organization", doc({ github: { organization: "-octo", runnerGroup: 3 } }), "The field github.organization is not a name of GitHub."],
    ["an organization with no runner group", doc({ github: { organization: "octo" } }), "The field github.runnerGroup is not a whole number from 1."],
    ["a runner group with no organization", doc({ github: { runnerGroup: 3 } }), "The field github.runnerGroup has no organization."],
    ["public repositories that are not true or false", doc({ github: { publicRepositories: "yes" } }), "The field github.publicRepositories is not true or false."],
    ["an unknown field of github", doc({ github: { token: "x" } }), 'The field github has the unknown field "token".'],
    ["no field proxmox", doc({ proxmox: "pve" }), "The field proxmox is not an object."],
    ["an http URL of Proxmox VE", doc({ proxmox: { url: "http://pve.example:8006", pool: "runners", sizes: {} } }), 'proxmox.url: The URL of Proxmox VE has the scheme "http:".'],
    ["a pool that is not a text", doc({ proxmox: { url: PVE, pool: 7, sizes: {} } }), "The field proxmox.pool is not a text."],
    ["sizes that are not an object", doc({ proxmox: { url: PVE, pool: "runners", sizes: [] } }), "The field proxmox.sizes is not an object."],
    ["files that are not an object", doc({ proxmox: { url: PVE, pool: "runners", sizes: {}, files: "/run" } }), "The field proxmox.files is not an object."],
    ["a size of the settings with no template", doc({ proxmox: { url: PVE, pool: "runners", sizes: {} } }), "The size small of the settings has no template in the field proxmox.sizes."],
    ["probes that are not an object", doc({ probes: 9464 }), "The field probes is not an object."],
    ["a port of the probes out of range", doc({ probes: { port: 70_000 } }), "The field probes.port is not a port from 1 to 65535."],
    ["a host of the probes with a space", doc({ probes: { port: 9464, host: "a b" } }), "The field probes.host is not a host name or an address."],
  ];
  for (const [name, value, wanted] of bad) {
    it(`gives a problem for ${name}`, () => {
      const problems = problemsOf(value);
      expect(problems.some((problem) => problem.startsWith(wanted))).toBe(true);
    });
  }

  it("gives each problem of a document together", () => {
    expect(problemsOf(doc({ format: "x", profile: "x", stop: "x" }))).toEqual([
      'The field format is not "dispatcher-program/1".',
      'The field profile is not "local" or "daemon".',
      "The field stop is not an absolute path.",
    ]);
  });
});

describe("readSecrets", () => {
  const env = (github: string | undefined, proxmox: string | undefined) => ({ [SECRET_VARIABLES.github]: github, [SECRET_VARIABLES.proxmox]: proxmox });

  it("reads the two secrets", () => {
    expect(readSecrets(env(GITHUB_TOKEN, PROXMOX_TOKEN))).toEqual({ ok: true, value: SECRETS });
  });

  it("names each variable that is not set", () => {
    expect(readSecrets(env(undefined, ""))).toEqual({
      ok: false,
      problems: ["The variable RUNNER_DISPATCH_GITHUB_TOKEN is not set.", "The variable RUNNER_DISPATCH_PROXMOX_TOKEN is not set."],
    });
  });

  it("refuses a value of the wrong form, and no problem has the value", () => {
    const github = "ghp_secret with a space";
    const proxmox = "secret-with-no-user";
    const read = readSecrets(env(github, proxmox));
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problems).toEqual([
      "The variable RUNNER_DISPATCH_GITHUB_TOKEN is not a token: it has a space, a line break or a character that is not ASCII.",
      "The variable RUNNER_DISPATCH_PROXMOX_TOKEN is not of the form USER@REALM!TOKENID=SECRET.",
    ]);
    expect(read.problems.join(" ")).not.toContain("secret");
  });
});

describe("livenessUrl", () => {
  it("gives the URL of the probe, with the loopback address for an address of each interface", () => {
    expect(livenessUrl({ host: "127.0.0.1", port: 9464 })).toBe("http://127.0.0.1:9464/liveness");
    expect(livenessUrl({ host: "0.0.0.0", port: 9464 })).toBe("http://127.0.0.1:9464/liveness");
    expect(livenessUrl({ host: "::", port: 9464 })).toBe("http://[::1]:9464/liveness");
    expect(livenessUrl({ host: "runner-host", port: 1 })).toBe("http://runner-host:1/liveness");
  });
});

/** This function gives the ports of a test, with a list of the log lines. */
const portsOf = (api: GitHubApi<AbortSignal>, transport: ProxmoxTransport<AbortSignal>, stop = false) => {
  const lines: LogLine[] = [];
  const opened: { url: string; token: string }[] = [];
  const ports: ProgramPorts = {
    github: (options) => {
      opened.push(options);
      return api;
    },
    proxmox: () => transport,
    exists: () => Promise.resolve(stop),
    log: (line) => lines.push(line),
    signal: new AbortController().signal,
  };
  return { ports, lines, opened };
};


describe("prepareProgram", () => {
  it("checks the runner group before each other part, then declares the service and finds no violated rule", async () => {
    const github = groupApi();
    const at = portsOf(github.api, noProxmox);
    const prepared = await prepareProgram(programOf(ORGANIZATION), SECRETS, at.ports);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.group).toEqual({ pass: true, problems: [] });
    expect(prepared.value.findings.filter((finding) => finding.verdict === "violated")).toEqual([]);
    expect(at.opened).toEqual([{ url: GITHUB_API_URL, token: GITHUB_TOKEN }]);
    expect(github.requests.map((request) => request.path)).toEqual(["/orgs/octo/actions/runner-groups/3", "/orgs/octo/actions/runner-groups/3/repositories"]);
    expect(at.lines.map((line) => line.event)).toEqual(["runner-group", "declaration"]);
  });

  it("refuses a runner group that admits each repository, and declares nothing", async () => {
    const github = groupApi({ visibility: "all" });
    const at = portsOf(github.api, noProxmox);
    expect(await prepareProgram(programOf(ORGANIZATION), SECRETS, at.ports)).toEqual({
      ok: false,
      problems: ["The runner group 3: The group admits each repository of the organization."],
    });
    expect(at.lines.map((line) => line.event)).toEqual(["runner-group"]);
  });

  it("refuses a runner group that admits a repository that the program does not serve", async () => {
    const github = groupApi({}, [REPO, "octo/secret"]);
    const prepared = await prepareProgram(programOf(ORGANIZATION), SECRETS, portsOf(github.api, noProxmox).ports);
    expect(prepared).toEqual({ ok: false, problems: ['The runner group 3: The group admits the repository "octo/secret", and the dispatcher does not serve it.'] });
  });

  it("sends no request without an organization", async () => {
    const github = groupApi();
    const at = portsOf(github.api, noProxmox);
    const prepared = await prepareProgram(programOf(), SECRETS, at.ports);
    expect(prepared.ok && prepared.value.group).toBeNull();
    expect(github.requests).toEqual([]);
    expect(at.lines.map((line) => line.event)).toEqual(["declaration"]);
  });

  it("refuses a declaration that lint() finds violated: a bound of a pass that the drain of the profile can cut", async () => {
    const at = portsOf(groupApi().api, noProxmox);
    const prepared = await prepareProgram(programOf({ loop: { sleep: 1, bound: 4, retry: 1, retryMax: 2, close: 0.5 } }), SECRETS, at.ports);
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.problems.length).toBe(1);
    expect(prepared.problems).toEqual([`The declaration violates the rule ${UNIT_BOUND_RULE} at passes.`]);
    const declared = at.lines.find((line) => line.event === "declaration");
    expect(declared?.event === "declaration" && declared.findings.some((finding) => finding.verdict === "violated")).toBe(true);
  });

  it("gives a template that the provider refuses as a problem", async () => {
    const program = programOf({ proxmox: { url: PVE, pool: "runners", sizes: { small: { node: "pve1", template: 0 } } } });
    const prepared = await prepareProgram(program, SECRETS, portsOf(groupApi().api, noProxmox).ports);
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.problems.length).toBe(1);
    expect(prepared.problems[0]).toMatch(/template/);
  });

  it("prepares the program of the README with no finding violated", async () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const block = /## The program[\s\S]*?```json\r?\n([\s\S]*?)```/.exec(readme)?.[1];
    expect(block).toBeDefined();
    const read = parseProgram(JSON.parse(block ?? "null"));
    expect(read.ok ? [] : read.problems).toEqual([]);
    if (!read.ok) return;
    const prepared = await prepareProgram(read.value, SECRETS, portsOf(groupApi().api, noProxmox).ports);
    expect(prepared.ok ? [] : prepared.problems).toEqual([]);
  });

  it("throws when GitHub gives no answer to the check of the runner group, and the error has no token", async () => {
    const api: GitHubApi<AbortSignal> = { request: () => Promise.reject(new Error("The network is down.")) };
    await expect(prepareProgram(programOf(ORGANIZATION), SECRETS, portsOf(api, noProxmox).ports)).rejects.toThrow("The network is down.");
  });
});

/** This record is a program that runs on a fake world, a fake GitHub and a fake Proxmox VE. */
interface Run {
  readonly clock: FakeClock;
  readonly world: FakeWorld;
  readonly pve: FakeProxmox;
  readonly lines: LogLine[];
  readonly life: Lifecycle;
  advance(ms: number): Promise<void>;
}

/** This function gives a port that the system has free at this time. */
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("The server has no port."))));
    });
  });

const runOn = async (over: Record<string, unknown> = {}): Promise<Run> => {
  const clock = fakeClock(0);
  const world = fakeWorld({ clock, times: { boot: 2000, connect: 1000, destroy: 500 } });
  const pve = fakeProxmox({ pool: "runners", templates: [{ vmid: 9000, node: "pve1", agent: true }] });
  const at = portsOf(fakeGitHubApi(world).api as GitHubApi<AbortSignal>, wireOf(pve.api));
  const process = fakeProcess({ clock });
  const ports: ProgramPorts = { ...at.ports, clock, process, random: () => 0, suffix: countingSuffix() };
  const prepared = await prepareProgram(programOf(over), SECRETS, ports);
  if (!prepared.ok) throw new Error(prepared.problems.join(" "));
  let ended = false;
  const started = runProgram(prepared.value, ports).finally(() => {
    ended = true;
  });
  for (let step = 0; step < 50 && !ended; step += 1) {
    await clock.advance(0);
    await settle();
  }
  const life = await started;
  return {
    clock,
    world,
    pve,
    lines: at.lines,
    life,
    async advance(ms: number): Promise<void> {
      for (let moved = 0; moved < ms; moved += 500) {
        await clock.advance(500);
        pve.tick();
        await settle();
      }
    },
  };
};

describe("a program on fakes", () => {
  it("makes a machine on Proxmox VE for a job, gives it the configuration, logs no secret, and ends with the exit code 0", async () => {
    const run = await runOn();
    expect(run.life.health.probe("liveness").status).toBe(200);
    run.world.addRun(
      { repository: REPO, runId: 100, runAttempt: 1, event: "push", headRepository: REPO, actor: "octo", triggeringActor: "octo" },
      [{ labels: ["run-100-1"], duration: 4000 }],
    );
    await run.advance(30_000);

    const clones = run.pve.requests.filter((request) => request.method === "POST" && request.path.endsWith("/clone"));
    expect(clones.length).toBe(1);
    const made = run.pve.vms().filter((vm) => !vm.template);
    expect(made.length).toBe(1);
    const secrets = run.world.secrets();
    expect(secrets.length).toBe(1);
    expect([...(made[0]?.files.values() ?? [])].some((content) => content.includes(secrets[0] ?? "-"))).toBe(true);

    const passes = run.lines.filter((line) => line.event === "pass");
    expect(passes.length).toBeGreaterThan(0);
    // The job ended in the 30 seconds. Thus its record is in the log, with the bounds of its times.
    const measured = run.lines.filter((line) => line.event === "job-measure");
    expect(measured).toMatchObject([{ record: { format: "job-measure/1", repository: REPO, runId: 100, last: "completed" }, spans: { run: { low: expect.any(Number) } } }]);
    const logged = JSON.stringify(run.lines);
    for (const secret of [...secrets, GITHUB_TOKEN, PROXMOX_TOKEN, "0123-secret-of-proxmox"]) expect(logged).not.toContain(secret);

    const exit = run.life.shutdown("The test ended.");
    for (let step = 0; step < 200 && run.life.state !== "exited"; step += 1) await run.advance(100);
    expect(await exit).toBe(0);
  });

  it("answers the liveness probe on the port of its probe server, and closes the port at the shutdown", async () => {
    const port = await freePort();
    const url = livenessUrl({ host: "127.0.0.1", port });
    const run = await runOn({ probes: { port } });
    expect(await probeOnce({ kind: "http", url }, 2000, nodeHostPorts())).toEqual({ ok: true });
    const exit = run.life.shutdown("The test ended.");
    for (let step = 0; step < 200 && run.life.state !== "exited"; step += 1) await run.advance(100);
    expect(await exit).toBe(0);
    expect((await probeOnce({ kind: "http", url }, 2000, nodeHostPorts())).ok).toBe(false);
  });
});
