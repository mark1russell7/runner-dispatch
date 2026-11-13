import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubApi } from "@mark1russell7/runner-dispatch/github";
import { countingSuffix, fakeGitHubApi, fakeProxmox, fakeWorld } from "@mark1russell7/runner-dispatch/testing";
import { fakeClock, fakeProcess } from "@mark1russell7/service/testing";
import type { RestExchange, RestReply } from "@procedures/gh";
import { describe, expect, it } from "vitest";
import { fileExists, main, nodePorts, parseCommand, restGitHubApi, USAGE, USER_AGENT, type CliIo } from "./cli.ts";
import { doc, GITHUB_TOKEN, groupApi, noProxmox, ORGANIZATION, PROXMOX_TOKEN, REPO, settle, wireOf } from "./fixtures.ts";
import { GITHUB_API_URL, SECRET_VARIABLES, type ProgramPorts } from "./program.ts";

const ENV = { [SECRET_VARIABLES.github]: GITHUB_TOKEN, [SECRET_VARIABLES.proxmox]: PROXMOX_TOKEN };
const FILE = "program.json";

/** This function gives the parts of Node.js of a test: the files, the environment, and the lines of each output. */
const memoryIo = (files: Readonly<Record<string, string>>, env: Readonly<Record<string, string | undefined>> = ENV) => {
  const out: string[] = [];
  const err: string[] = [];
  const read: string[] = [];
  const io: CliIo = {
    env,
    readText: (path) => {
      read.push(path);
      const text = files[path];
      return text === undefined ? Promise.reject(Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: "ENOENT" })) : Promise.resolve(text);
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return { io, out, err, read };
};

/** This function gives the ports of a check: a GitHub API, no Proxmox VE, and a signal that does not stop. */
const checkPorts = (api: GitHubApi<AbortSignal>, opened: { url: string; token: string }[] = []): Partial<ProgramPorts> => ({
  github: (options) => {
    opened.push(options);
    return api;
  },
  proxmox: () => noProxmox,
  exists: () => Promise.resolve(false),
  signal: new AbortController().signal,
});

const SECRET_TEXTS = [GITHUB_TOKEN, PROXMOX_TOKEN, "0123-secret-of-proxmox"];

describe("parseCommand", () => {
  it.each([
    [["program.json"], { kind: "run", path: "program.json", check: false }],
    [["--check", "program.json"], { kind: "run", path: "program.json", check: true }],
    [["program.json", "--check"], { kind: "run", path: "program.json", check: true }],
    [["-h"], { kind: "help" }],
    [["program.json", "--bad", "--help"], { kind: "help" }],
  ])("reads %j", (args, command) => {
    expect(parseCommand(args)).toEqual(command);
  });

  it.each([
    [[], "The command has no path of a program."],
    [["--check"], "The command has no path of a program."],
    [["a.json", "b.json"], "The command takes one path of a program."],
    [["a.json", "--check", "--check"], "The option --check is in the command two times."],
    [["a.json", "--dry-run"], "The option --dry-run is not an option of the command."],
  ])("refuses %j", (args, problem) => {
    expect(parseCommand(args)).toEqual({ kind: "usage", problem });
  });
});

describe("main", () => {
  it("writes the help to stdout with the exit code 0, and reads no file", async () => {
    const at = memoryIo({});
    expect(await main(["--help"], at.io)).toBe(0);
    expect(at.out).toEqual([USAGE]);
    expect(at.err).toEqual([]);
    expect(at.read).toEqual([]);
  });

  it("gives a bad command the exit code 2, with its problem and the help on stderr", async () => {
    const at = memoryIo({});
    expect(await main(["a.json", "b.json"], at.io)).toBe(2);
    expect(at.err).toEqual(["The command takes one path of a program.", USAGE]);
    expect(at.read).toEqual([]);
  });

  it("names the code of a program file that it cannot read", async () => {
    const at = memoryIo({});
    expect(await main(["missing.json"], at.io)).toBe(1);
    expect(at.err).toEqual(["The command cannot read the program file missing.json (ENOENT)."]);
  });

  it("refuses a program file that is not JSON", async () => {
    const at = memoryIo({ [FILE]: "{ format:" });
    expect(await main([FILE], at.io)).toBe(1);
    expect(at.err).toEqual([`The program file ${FILE} is not JSON.`]);
  });

  it("gives each problem of the program and of the tokens together, and names no value of a token", async () => {
    const env = { [SECRET_VARIABLES.proxmox]: "a-bad-proxmox-value" };
    const at = memoryIo({ [FILE]: JSON.stringify(doc({ profile: "fast" })) }, env);
    expect(await main([FILE], at.io)).toBe(1);
    expect(at.err.length).toBe(3);
    expect(at.err.slice(1)).toEqual([
      `The variable ${SECRET_VARIABLES.github} is not set.`,
      `The variable ${SECRET_VARIABLES.proxmox} is not of the form USER@REALM!TOKENID=SECRET.`,
    ]);
    expect(at.err[0]).toMatch(/profile/);
    expect(at.err.join("\n")).not.toContain("a-bad-proxmox-value");
    expect(at.out).toEqual([]);
  });

  it("checks a program with --check: the runner group, the declaration, then one line checked, and starts nothing", async () => {
    const github = groupApi();
    const opened: { url: string; token: string }[] = [];
    const at = memoryIo({ [FILE]: JSON.stringify(doc(ORGANIZATION)) });
    expect(await main([FILE, "--check"], at.io, checkPorts(github.api, opened))).toBe(0);
    expect(at.err).toEqual([]);
    expect(at.out.map((line) => (JSON.parse(line) as { event: string }).event)).toEqual(["runner-group", "declaration", "checked"]);
    expect(opened).toEqual([{ url: GITHUB_API_URL, token: GITHUB_TOKEN }]);
    expect(github.requests.length).toBe(2);
    for (const secret of SECRET_TEXTS) expect(at.out.join("\n")).not.toContain(secret);
  });

  it("refuses a runner group that admits a repository that the program does not serve", async () => {
    const at = memoryIo({ [FILE]: JSON.stringify(doc(ORGANIZATION)) });
    expect(await main([FILE, "--check"], at.io, checkPorts(groupApi({}, [REPO, "octo/secret"]).api))).toBe(1);
    expect(at.err).toEqual(['The runner group 3: The group admits the repository "octo/secret", and the dispatcher does not serve it.']);
  });

  it("removes each form of each token from an error text", async () => {
    const api: GitHubApi<AbortSignal> = {
      request: () => Promise.reject(new Error(`No answer for ${GITHUB_TOKEN}, ${encodeURIComponent(PROXMOX_TOKEN)} and 0123-secret-of-proxmox.`)),
    };
    const at = memoryIo({ [FILE]: JSON.stringify(doc(ORGANIZATION)) });
    expect(await main([FILE, "--check"], at.io, checkPorts(api))).toBe(1);
    expect(at.err).toEqual(["No answer for [secret], [secret] and [secret]."]);
  });

  it("runs a program on fakes: a job ends, the log lines have no token and no configuration, and a SIGTERM gives the exit code 0", async () => {
    const clock = fakeClock(0);
    const world = fakeWorld({ clock, times: { boot: 2000, connect: 1000, destroy: 500 } });
    const pve = fakeProxmox({ pool: "runners", templates: [{ vmid: 9000, node: "pve1", agent: true }] });
    const process = fakeProcess({ clock });
    const at = memoryIo({ [FILE]: JSON.stringify(doc()) });
    let code: number | null = null;
    const ended = main([FILE], at.io, {
      github: () => fakeGitHubApi(world).api as GitHubApi<AbortSignal>,
      proxmox: () => wireOf(pve.api),
      exists: () => Promise.resolve(false),
      clock,
      process,
      random: () => 0,
      suffix: countingSuffix(),
    }).then((exit) => {
      code = exit;
    });
    const advance = async (ms: number, step: number): Promise<void> => {
      for (let moved = 0; moved < ms && code === null; moved += step) {
        await clock.advance(step);
        pve.tick();
        await settle();
      }
    };
    await advance(1000, 100);
    world.addRun(
      { repository: REPO, runId: 100, runAttempt: 1, event: "push", headRepository: REPO, actor: "octo", triggeringActor: "octo" },
      [{ labels: ["run-100-1"], duration: 4000 }],
    );
    await advance(30_000, 500);
    expect(pve.vms().filter((vm) => !vm.template).length).toBe(1);

    process.signal("SIGTERM");
    await advance(20_000, 100);
    await ended;
    expect(code).toBe(0);
    expect(at.err).toEqual([]);
    const events = at.out.map((line) => (JSON.parse(line) as { event: string }).event);
    expect(events[0]).toBe("declaration");
    expect(events).toContain("pass");
    for (const secret of [...SECRET_TEXTS, ...world.secrets()]) expect(at.out.join("\n")).not.toContain(secret);
  });
});

describe("restGitHubApi", () => {
  /** This function gives a transport that answers from a script, and keeps each exchange. */
  const wire = (reply: (exchange: RestExchange, index: number) => RestReply) => {
    const sent: RestExchange[] = [];
    const transport = (exchange: RestExchange): Promise<RestReply> => {
      sent.push(exchange);
      return Promise.resolve(reply(exchange, sent.length - 1));
    };
    return { sent, transport };
  };

  it("sends a GET with the token, the user agent and the query on the base URL, and gives a stored answer for a 304", async () => {
    const at = wire((_, index) => (index === 0 ? { status: 200, headers: { etag: '"v1"' }, body: { total_count: 0 } } : { status: 304, headers: {}, body: null }));
    const api = restGitHubApi({ token: GITHUB_TOKEN, baseUrl: "https://ghe.example/api/v3", userAgent: USER_AGENT, transport: at.transport });
    const request = { method: "GET", path: "/orgs/octo/actions/runner-groups/3/repositories", query: { per_page: "100", page: "1" }, body: null } as const;
    const signal = new AbortController().signal;
    expect(await api.request(request, signal)).toEqual({ status: 200, body: { total_count: 0 } });
    expect(await api.request(request, signal)).toEqual({ status: 200, body: { total_count: 0 } });
    expect(at.sent.map((exchange) => exchange.url)).toEqual([
      "https://ghe.example/api/v3/orgs/octo/actions/runner-groups/3/repositories?page=1&per_page=100",
      "https://ghe.example/api/v3/orgs/octo/actions/runner-groups/3/repositories?page=1&per_page=100",
    ]);
    expect(at.sent[0]?.headers).toMatchObject({ authorization: `Bearer ${GITHUB_TOKEN}`, "user-agent": USER_AGENT });
    expect(at.sent[1]?.headers["if-none-match"]).toBe('"v1"');
  });

  it("sends a POST with its JSON body, and gives each status as an answer", async () => {
    const at = wire(() => ({ status: 422, headers: {}, body: { message: "Validation Failed" } }));
    const api = restGitHubApi({ token: GITHUB_TOKEN, transport: at.transport });
    const body = { name: "rd-1", runner_group_id: 3, labels: ["run-100-1"] };
    const answer = await api.request({ method: "POST", path: "/orgs/octo/actions/runners/generate-jitconfig", query: {}, body }, new AbortController().signal);
    expect(answer).toEqual({ status: 422, body: { message: "Validation Failed" } });
    expect(at.sent).toEqual([expect.objectContaining({ method: "POST", url: "https://api.github.com/orgs/octo/actions/runners/generate-jitconfig", body })]);
  });
});

describe("the ports of Node.js", () => {
  it("tells if the stop file is there, and gives an error that is not ENOENT to the caller", async () => {
    const folder = await mkdtemp(join(tmpdir(), "runner-dispatch-cli-"));
    try {
      const stop = join(folder, "stop");
      expect(await fileExists(stop)).toBe(false);
      expect(await fileExists(join(folder, "no-folder", "stop"))).toBe(false);
      await writeFile(stop, "");
      expect(await fileExists(stop)).toBe(true);
      await expect(fileExists("\0")).rejects.toThrow();
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it("writes each log line as one line of JSON, and keeps the ports of a test", () => {
    const lines: string[] = [];
    const exists = (): Promise<boolean> => Promise.resolve(true);
    const ports = nodePorts((line) => lines.push(line), { exists });
    ports.log({ event: "problem", text: "A problem." });
    expect(lines).toEqual(['{"event":"problem","text":"A problem."}']);
    expect(ports.exists).toBe(exists);
  });
});
