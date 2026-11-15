import { fakeClock, type FakeClock } from "@mark1russell7/service/testing";
import type { RestExchange, RestReply, RestTransport } from "@procedures/gh";
import { describe, expect, it } from "vitest";
import { settle } from "./fixtures.ts";
import {
  conditionalCost,
  groupFacts,
  headerOf,
  parsePermissions,
  PROBE_LABEL,
  PROBE_ROUNDS,
  PROBE_TRIES_MAX,
  PROBE_TRIES_MIN,
  probeGitHub,
  settingsProblems,
  tokenKind,
  type ProbePorts,
  type ProbeRecord,
  type ProbeSettings,
} from "./probe.ts";
import { parseProbeCommand, probeMain, PROBE_USAGE } from "./probe-cli.ts";
import { SECRET_VARIABLES } from "./program.ts";

const TOKEN = "github_pat_secret-of-the-probe";
const CONFIG = "SECRET-ONE-JOB-CONFIGURATION";
const BASE = "https://api.github.com";

/** This record has the options of the fake GitHub of a probe. */
interface FakeOptions {
  /** This field is the count of the used requests of one answer 304. The default is 0. */
  readonly cost304?: number;
  /** This function gives the requests of another client before the exchange with this index. */
  readonly others?: (index: number) => number;
  /** This field is the visibility that GitHub keeps for a new group. The default is the visibility of the request. */
  readonly keeps?: string;
  /** This function gives a status that refuses a request, or `null`. */
  readonly refuse?: (method: string, path: string) => number | null;
  /** This field is the count of the runs of the repository. The default is 1. */
  readonly runs?: number;
  /** This function runs before each exchange, with its method and path. */
  readonly before?: (method: string, path: string) => void;
}

/** This function gives the permissions header of a route of the fake. The names are the names of a test. */
const permissionsOf = (method: string, path: string): string => {
  if (path === "/repos/octo/app") return "metadata=read";
  if (path.includes("/actions/runs")) return "actions=read";
  if (path.startsWith("/orgs/")) return method === "GET" ? "organization_self_hosted_runners=read" : "organization_self_hosted_runners=write";
  return method === "GET" ? "administration=read; administration=write" : "administration=write";
};

/** This function makes a fake REST API of GitHub at the level of a transport, with the counts of the primary limit. */
const fakeGitHub = (options: FakeOptions = {}) => {
  let used = 40;
  let index = 0;
  let nextRunner = 50;
  let nextGroup = 10;
  const sent: RestExchange[] = [];
  const groups = new Map<number, { id: number; name: string; visibility: string; default: boolean; allows_public_repositories: boolean; repositories: number[] }>([
    [1, { id: 1, name: "Default", visibility: "all", default: true, allows_public_repositories: false, repositories: [] }],
  ]);
  const runners = new Map<number, { id: number; name: string; labels: string[]; group: number; scope: string }>();
  const reply = (status: number, body: unknown, method: string, path: string, extra: Record<string, string> = {}): RestReply => ({
    status,
    headers: {
      "X-Accepted-GitHub-Permissions": permissionsOf(method, path),
      "X-RateLimit-Used": String(used),
      "X-RateLimit-Resource": "core",
      ...extra,
    },
    body,
  });
  const runsBody = (count: number): unknown => ({
    total_count: count,
    workflow_runs: Array.from({ length: count }, (_, at) => ({ id: 900 + at, run_attempt: 1, status: "completed" })),
  });
  const transport: RestTransport = (exchange) => {
    sent.push(exchange);
    used += options.others?.(index) ?? 0;
    index += 1;
    const url = new URL(exchange.url);
    const path = url.pathname;
    const method = exchange.method;
    options.before?.(method, path);
    if (exchange.headers["authorization"] !== `Bearer ${TOKEN}`) return Promise.resolve({ status: 401, headers: {}, body: { message: "Bad credentials" } });
    if (path === "/rate_limit") return Promise.resolve(reply(200, { resources: { core: { limit: 5000, used, remaining: 5000 - used } } }, method, path));
    const refused = options.refuse?.(method, path) ?? null;
    if (refused !== null) {
      used += 1;
      return Promise.resolve(reply(refused, { message: "Resource not accessible by personal access token" }, method, path));
    }
    if (method === "GET" && path === "/repos/octo/app/actions/runs" && url.searchParams.get("status") === "queued") {
      if (exchange.headers["if-none-match"] === 'W/"runs-v1"') {
        used += options.cost304 ?? 0;
        return Promise.resolve(reply(304, null, method, path, { ETag: 'W/"runs-v1"' }));
      }
      used += 1;
      return Promise.resolve(reply(200, runsBody(0), method, path, { ETag: 'W/"runs-v1"' }));
    }
    used += 1;
    const answer = (status: number, body: unknown = null): Promise<RestReply> => Promise.resolve(reply(status, body, method, path));
    if (method === "GET" && path === "/repos/octo/app") return answer(200, { id: 77, full_name: "octo/app", private: true });
    if (method === "GET" && path === "/repos/octo/app/actions/runs") return answer(200, runsBody(Math.min(options.runs ?? 1, 1)));
    if (method === "GET" && path === "/repos/octo/app/actions/runs/900") return answer(200, { id: 900, run_attempt: 1 });
    if (method === "GET" && path === "/repos/octo/app/actions/runs/900/attempts/1/jobs") return answer(200, { total_count: 0, jobs: [] });
    const scope = /^(\/repos\/octo\/app|\/orgs\/octo)\/actions\/runners(?:\/(.+))?$/.exec(path);
    if (scope !== null) {
      const at = scope[1] as string;
      const rest = scope[2];
      const mine = [...runners.values()].filter((runner) => runner.scope === at);
      if (method === "GET" && rest === undefined) return answer(200, { total_count: mine.length, runners: mine });
      if (method === "POST" && rest === "generate-jitconfig") {
        const body = exchange.body as { name: string; labels: string[]; runner_group_id: number };
        if (!groups.has(body.runner_group_id)) return answer(404, { message: "Not Found" });
        const id = nextRunner;
        nextRunner += 1;
        runners.set(id, { id, name: body.name, labels: body.labels, group: body.runner_group_id, scope: at });
        return answer(201, { runner: { id, name: body.name }, encoded_jit_config: CONFIG });
      }
      const runner = rest === undefined ? undefined : mine.find((each) => String(each.id) === rest);
      if (runner === undefined) return answer(404, { message: "Not Found" });
      if (method === "GET") {
        const labels = [{ id: 1, name: "self-hosted", type: "read-only" }, ...runner.labels.map((name, at) => ({ id: at + 2, name, type: "custom" }))];
        return answer(200, { id: runner.id, name: runner.name, status: "offline", busy: false, labels });
      }
      if (method === "DELETE") {
        runners.delete(runner.id);
        return answer(204);
      }
    }
    const group = /^\/orgs\/octo\/actions\/runner-groups(?:\/(\d+)(?:\/(repositories|runners))?)?$/.exec(path);
    if (group !== null) {
      const id = group[1] === undefined ? null : Number(group[1]);
      const found = id === null ? undefined : groups.get(id);
      if (id === null && method === "GET") return answer(200, { total_count: groups.size, runner_groups: [...groups.values()] });
      if (id === null && method === "POST") {
        const body = exchange.body as { name: string; visibility: string; selected_repository_ids: number[]; allows_public_repositories: boolean };
        const made = { id: nextGroup, name: body.name, visibility: options.keeps ?? body.visibility, default: false, allows_public_repositories: body.allows_public_repositories, repositories: body.selected_repository_ids };
        nextGroup += 1;
        groups.set(made.id, made);
        return answer(201, made);
      }
      if (found === undefined) return answer(404, { message: "Not Found" });
      if (method === "GET" && group[2] === undefined) return answer(200, found);
      if (method === "GET" && group[2] === "repositories") {
        return answer(200, { total_count: found.repositories.length, repositories: found.repositories.map((each) => ({ id: each, full_name: "octo/app", private: true })) });
      }
      if (method === "GET" && group[2] === "runners") {
        const members = [...runners.values()].filter((runner) => runner.group === found.id);
        return answer(200, { total_count: members.length, runners: members });
      }
      if (method === "DELETE") {
        if ([...runners.values()].some((runner) => runner.group === found.id)) return answer(422, { message: "The group has runners" });
        groups.delete(found.id);
        return answer(204);
      }
    }
    return answer(404, { message: "Not Found" });
  };
  return { transport, sent, runners, groups, used: (): number => used };
};

/** This function gives the ports of a probe on a fake, with a fake clock and a counting suffix. */
const portsOf = (transport: RestTransport, clock: FakeClock, over: Partial<ProbePorts> = {}): ProbePorts => {
  let next = 0;
  return {
    token: TOKEN,
    baseUrl: BASE,
    userAgent: "runner-dispatch",
    transport,
    suffix: () => {
      next += 1;
      return `0000000${next}`;
    },
    now: () => "2026-11-15T20:00:00.000Z",
    signal: new AbortController().signal,
    cleanupSignal: () => new AbortController().signal,
    clock,
    ...over,
  };
};

/** This function moves a fake clock until the work ends. A request that changes data waits one second on the clock. */
const drive = async <T>(clock: FakeClock, work: Promise<T>): Promise<T> => {
  let done = false;
  const result = work.finally(() => {
    done = true;
  });
  for (let round = 0; round < 2000 && !done; round += 1) {
    await settle();
    if (!done) await clock.advance(250);
  }
  return result;
};

const REPOSITORY: ProbeSettings = { repository: "octo/app", organization: null, labels: [PROBE_LABEL], tries: 3, group: false };
const ORGANIZATION: ProbeSettings = { ...REPOSITORY, organization: "octo", group: true };

/** This function makes a probe on a fake GitHub. */
const probe = async (settings: ProbeSettings, options: FakeOptions = {}, over: Partial<ProbePorts> = {}) => {
  const github = fakeGitHub(options);
  const clock = fakeClock(0);
  const record = await drive(clock, probeGitHub(settings, portsOf(github.transport, clock, over)));
  return { github, record };
};

const stepsOf = (record: ProbeRecord): string[] => record.steps.map((step) => step.step);

describe("tokenKind", () => {
  it.each([
    ["github_pat_abc", "fine-grained"],
    ["ghp_abc", "classic"],
    ["gho_abc", "oauth"],
    ["ghs_abc", "app-installation"],
    ["ghu_abc", "app-user"],
    ["abc", "unknown"],
  ])("gives the kind of %s", (token, kind) => {
    expect(tokenKind(token)).toBe(kind);
  });
});

describe("parsePermissions", () => {
  it.each([
    ["actions=read", [[{ name: "actions", level: "read" }]]],
    ["repository_projects=write; organization_projects=admin", [[{ name: "repository_projects", level: "write" }], [{ name: "organization_projects", level: "admin" }]]],
    ["a=read, b=write;c=admin", [[{ name: "a", level: "read" }, { name: "b", level: "write" }], [{ name: "c", level: "admin" }]]],
    ["metadata", [[{ name: "metadata", level: "" }]]],
    ["", []],
    [" ; ", []],
  ])("reads %j", (header, sets) => {
    expect(parsePermissions(header)).toEqual(sets);
  });
});

describe("headerOf", () => {
  it("finds a header with no difference of letter case, and joins two values", () => {
    const reply: RestReply = { status: 200, headers: { "X-RateLimit-Used": "7", vary: ["accept", "authorization"] }, body: null };
    expect(headerOf(reply, "x-ratelimit-used")).toBe("7");
    expect(headerOf(reply, "vary")).toBe("accept, authorization");
    expect(headerOf(reply, "etag")).toBeNull();
  });
});

describe("groupFacts", () => {
  it("keeps the fields of the check, and gives null for a field that is absent or of another type", () => {
    expect(groupFacts({ id: 3, name: "home", visibility: "selected", default: false, allows_public_repositories: false, restricted_to_workflows: true, runners_url: "x" })).toEqual({
      id: 3,
      name: "home",
      visibility: "selected",
      default: false,
      allowsPublicRepositories: false,
      restrictedToWorkflows: true,
    });
    expect(groupFacts({ id: "3" })).toEqual({ id: null, name: null, visibility: null, default: null, allowsPublicRepositories: null, restrictedToWorkflows: null });
  });
});

describe("conditionalCost", () => {
  /** This function gives the counts of a measure with no other client: two reads, the first request, the tries, and a read. */
  const clean = (tries: number, cost: number, start = 40): number[] => {
    const used = [start, start, start + 1];
    for (let index = 1; index <= tries; index += 1) used.push(start + 1 + index * cost);
    used.push(used[used.length - 1] as number);
    return used;
  };
  const all304 = (tries: number): number[] => Array.from({ length: tries }, () => 304);

  it("gives the cost of an answer 304 for each count of tries", () => {
    for (let tries = PROBE_TRIES_MIN; tries <= 8; tries += 1) {
      for (const cost of [0, 1, 2]) {
        expect(conditionalCost(clean(tries, cost), all304(tries))).toMatchObject({ tries, notModified: tries, clean: true, noisy: false, cost, reason: null });
      }
    }
  });

  it("gives no read when another client sends requests in any one gap of the sequence", () => {
    for (let tries = PROBE_TRIES_MIN; tries <= 6; tries += 1) {
      for (const cost of [0, 1]) {
        const length = tries + 4;
        for (let gap = 1; gap < length; gap += 1) {
          for (const amount of [1, 2, 5]) {
            const used = clean(tries, cost).map((count, index) => (index >= gap ? count + amount : count));
            const measure = conditionalCost(used, all304(tries));
            expect(measure.cost, `tries ${tries}, cost ${cost}, gap ${gap}, amount ${amount}`).toBeNull();
            expect(measure.clean).toBe(false);
            expect(measure.noisy).toBe(true);
          }
        }
      }
    }
  });

  it("gives no read for one try, a missing count, a count that falls, or an answer that is not 304", () => {
    expect(conditionalCost(clean(1, 0), all304(1)).reason).toBe(`The measure needs ${PROBE_TRIES_MIN} conditional requests or more.`);
    expect(conditionalCost([40, 40, 41, null, 41, 41], all304(2)).reason).toBe("A step of the measure has no count of the used requests.");
    expect(conditionalCost([40, 40, 41], all304(2)).reason).toBe("A step of the measure has no count of the used requests.");
    expect(conditionalCost([40, 40, 41, 40, 39, 39], all304(2)).cost).toBeNull();
    expect(conditionalCost(clean(3, 0), [304, 200, 304])).toMatchObject({ noisy: false, reason: "GitHub did not answer each conditional request with the status 304." });
    expect(conditionalCost(clean(1, 0), all304(1)).noisy).toBe(false);
  });
});

describe("settingsProblems", () => {
  it("accepts the settings of a repository and of an organization", () => {
    expect(settingsProblems(REPOSITORY)).toEqual([]);
    expect(settingsProblems(ORGANIZATION)).toEqual([]);
  });

  it("gives each problem", () => {
    expect(settingsProblems({ repository: "app", organization: "-octo", labels: [], tries: 1, group: false })).toEqual([
      'The repository "app" is not a name as owner/name.',
      'The organization "-octo" is not a name of GitHub.',
      "The one-job runner has no label.",
      `The count of the conditional requests is not a whole number from ${PROBE_TRIES_MIN} to ${PROBE_TRIES_MAX}.`,
    ]);
    expect(settingsProblems({ ...REPOSITORY, organization: "other", labels: ["a b", "x,y"] })).toEqual([
      "The repository is not a repository of the organization.",
      'The label "a b" has a space, a comma or more than 100 characters.',
      'The label "x,y" has a space, a comma or more than 100 characters.',
    ]);
    expect(settingsProblems({ ...REPOSITORY, group: true })).toEqual(["A probe group needs an organization."]);
  });

  it("refuses settings that are not valid before a request", async () => {
    const github = fakeGitHub();
    await expect(probeGitHub({ ...REPOSITORY, tries: 0 }, portsOf(github.transport, fakeClock(0)))).rejects.toThrow(RangeError);
    expect(github.sent).toEqual([]);
  });
});

describe("probeGitHub", () => {
  it("measures the requests of a repository, makes a one-job runner and removes it", async () => {
    const { github, record } = await probe(REPOSITORY);
    expect(stepsOf(record)).toEqual([
      "rate",
      "rate-again",
      "runs",
      "runs-conditional",
      "runs-conditional",
      "runs-conditional",
      "rate-after",
      "repository",
      "runs-newest",
      "run",
      "jobs",
      "runners",
      "register",
      "runner",
      "runner-remove",
    ]);
    expect(record).toMatchObject({ format: "github-probe/1", at: "2026-11-15T20:00:00.000Z", repository: "octo/app", organization: null, token: "fine-grained", scopes: null });
    expect(record.conditional).toMatchObject({ tries: 3, notModified: 3, clean: true, noisy: false, cost: 0, reason: null });
    expect(record.rounds).toBe(1);
    expect(record.runner).toEqual({
      made: true,
      labels: [
        { name: "self-hosted", type: "read-only" },
        { name: PROBE_LABEL, type: "custom" },
      ],
      removed: true,
    });
    expect(record.groups).toBeNull();
    expect(record.group).toBeNull();
    expect(record.clean).toBe(true);
    expect(github.runners.size).toBe(0);
    const register = record.steps.find((step) => step.step === "register");
    expect(register).toMatchObject({ method: "POST", path: "/repos/octo/app/actions/runners/generate-jitconfig", status: 201, permissions: "administration=write" });
    expect(register?.sets).toEqual([[{ name: "administration", level: "write" }]]);
    expect(record.steps.find((step) => step.step === "runners")?.sets).toHaveLength(2);
    expect(record.steps.find((step) => step.step === "runs")?.path).toBe("/repos/octo/app/actions/runs?page=1&per_page=100&status=queued");
  });

  it("keeps no token and no one-job configuration in the record", async () => {
    const { github, record } = await probe(ORGANIZATION);
    const text = JSON.stringify(record);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(CONFIG);
    expect(github.sent.every((exchange) => exchange.headers["authorization"] === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("measures the cost of an answer 304 that counts", async () => {
    const { record } = await probe(REPOSITORY, { cost304: 1 });
    expect(record.conditional).toMatchObject({ clean: true, cost: 1, used: [40, 40, 41, 42, 43, 44, 44] });
  });

  it("repeats a round with the requests of another client, and gives the read of the next clean round", async () => {
    const { record } = await probe(REPOSITORY, { others: (index) => (index === 5 ? 1 : 0) });
    expect(record.rounds).toBe(2);
    expect(record.conditional).toMatchObject({ clean: true, noisy: false, cost: 0, used: [42, 42, 43, 43, 43, 43, 43] });
    expect(stepsOf(record).slice(0, 14)).toEqual([...Array.from({ length: 2 }, () => ["rate", "rate-again", "runs", "runs-conditional", "runs-conditional", "runs-conditional", "rate-after"]).flat()]);
    expect(stepsOf(record)[14]).toBe("repository");
  });

  it("gives no read of the cost when another client uses the token in each round", async () => {
    const { record } = await probe(REPOSITORY, { others: () => 1 });
    expect(record.rounds).toBe(PROBE_ROUNDS);
    expect(record.conditional).toMatchObject({ clean: false, noisy: true, cost: null, reason: "The count changed between two reads of the rate: another client used the token." });
    expect(stepsOf(record).filter((step) => step === "rate-after")).toHaveLength(PROBE_ROUNDS);
    expect(record.clean).toBe(true);
  });

  it("skips the run and its jobs in a repository with no run", async () => {
    const { record } = await probe(REPOSITORY, { runs: 0 });
    expect(stepsOf(record)).not.toContain("run");
    expect(stepsOf(record)).not.toContain("jobs");
    expect(record.runner.made).toBe(true);
  });

  it("makes a probe group in an organization, puts the runner in it, and removes the runner before the group", async () => {
    const { github, record } = await probe(ORGANIZATION);
    expect(stepsOf(record).slice(12)).toEqual(["runner-groups", "group-make", "group", "group-repositories", "register", "runner", "group-runners", "runner-remove", "group-remove"]);
    expect(record.groups).toEqual([{ id: 1, name: "Default", visibility: "all", default: true, allowsPublicRepositories: false, restrictedToWorkflows: null }]);
    expect(record.group).toEqual({
      made: { id: 10, name: "runner-dispatch-probe-00000001", visibility: "selected", default: false, allowsPublicRepositories: false, restrictedToWorkflows: null },
      check: { pass: true, problems: [] },
      runnerInGroup: true,
      removed: true,
    });
    expect(record.runner).toMatchObject({ made: true, removed: true });
    expect(record.clean).toBe(true);
    expect(github.groups.size).toBe(1);
    expect(record.steps.find((step) => step.step === "register")?.path).toBe("/orgs/octo/actions/runners/generate-jitconfig");
    const register = github.sent.find((exchange) => exchange.url.endsWith("/generate-jitconfig"));
    expect(register?.body).toEqual({ name: "runner-dispatch-probe-00000002", runner_group_id: 10, labels: [PROBE_LABEL] });
  });

  it("gives the problems of the check when GitHub keeps another visibility for the group", async () => {
    const { record } = await probe(ORGANIZATION, { keeps: "all" });
    expect(record.group?.made?.visibility).toBe("all");
    expect(record.group?.check).toEqual({ pass: false, problems: ["The group admits each repository of the organization."] });
    expect(record.group?.removed).toBe(true);
    expect(record.clean).toBe(true);
  });

  it("puts the runner in the default group when GitHub refuses the probe group", async () => {
    const { github, record } = await probe(ORGANIZATION, { refuse: (method, path) => (method === "POST" && path === "/orgs/octo/actions/runner-groups" ? 403 : null) });
    expect(record.group).toEqual({ made: null, check: null, runnerInGroup: false, removed: true });
    expect(record.steps.find((step) => step.step === "group-make")).toMatchObject({ status: 403, permissions: "organization_self_hosted_runners=write" });
    const register = github.sent.find((exchange) => exchange.url.endsWith("/generate-jitconfig"));
    expect((register?.body as { runner_group_id: number }).runner_group_id).toBe(1);
    expect(record.clean).toBe(true);
  });

  it("makes no runner when GitHub refuses the one-job configuration", async () => {
    const { record } = await probe(REPOSITORY, { refuse: (method, path) => (method === "POST" && path.endsWith("/generate-jitconfig") ? 403 : null) });
    expect(record.runner).toEqual({ made: false, labels: [], removed: true });
    expect(stepsOf(record).at(-1)).toBe("register");
    expect(record.clean).toBe(true);
  });

  it("still removes the runner and the group after a stop of the signal", async () => {
    const controller = new AbortController();
    const { github, record } = await probe(
      ORGANIZATION,
      {
        before: (method, path) => {
          if (method === "POST" && path.endsWith("/generate-jitconfig")) controller.abort();
        },
      },
      { signal: controller.signal },
    );
    expect(record.steps.find((step) => step.step === "runner")).toMatchObject({ status: null, problem: expect.stringContaining("The signal stopped the request") });
    expect(record.runner).toMatchObject({ made: true, removed: true });
    expect(record.group?.removed).toBe(true);
    expect(record.clean).toBe(true);
    expect(github.runners.size).toBe(0);
    expect(github.groups.size).toBe(1);
  });

  it("tells when a runner or a group stays on GitHub", async () => {
    const { github, record } = await probe(ORGANIZATION, { refuse: (method) => (method === "DELETE" ? 500 : null) });
    expect(record.runner).toMatchObject({ made: true, removed: false });
    expect(record.group).toMatchObject({ removed: false });
    expect(record.clean).toBe(false);
    expect(github.runners.size).toBe(1);
  });

  it("records a refusal of each request with its status and its permissions", async () => {
    const { record } = await probe(REPOSITORY, { refuse: (_method, path) => (path.includes("/actions/runs") ? 403 : null) });
    for (const step of record.steps.filter((each) => each.path.includes("/actions/runs"))) {
      expect(step).toMatchObject({ status: 403, permissions: "actions=read", problem: null });
    }
    expect(record.conditional).toMatchObject({ cost: null, noisy: false });
    expect(record.rounds).toBe(1);
  });
});

describe("parseProbeCommand", () => {
  it.each([
    [["--repository", "octo/app"], { ...REPOSITORY, tries: 5 }],
    [["--repository", "octo/app", "--organization", "octo", "--group", "--tries", "2"], { ...ORGANIZATION, tries: 2 }],
    [["--label", "a", "--repository", "octo/app", "--label", "b"], { ...REPOSITORY, labels: ["a", "b"], tries: 5 }],
  ])("reads %j", (args, settings) => {
    expect(parseProbeCommand(args)).toEqual({ kind: "probe", settings });
  });

  it.each([
    [[], "The command has no option --repository."],
    [["--repository"], "The option --repository has no value."],
    [["--repository", "--group"], "The option --repository has no value."],
    [["--repository", "octo/app", "--repository", "octo/b"], "The option --repository is in the command two times."],
    [["--repository", "octo/app", "--group", "--group"], "The option --group is in the command two times."],
    [["--repository", "octo/app", "--bad"], "The option --bad is not an option of the command."],
    [["octo/app"], "The argument octo/app has no option."],
    [["--repository", "octo/app", "--tries", "x"], `The count of the conditional requests is not a whole number from ${PROBE_TRIES_MIN} to ${PROBE_TRIES_MAX}.`],
    [["--repository", "octo/app", "--group"], "A probe group needs an organization."],
  ])("refuses %j", (args, problem) => {
    expect(parseProbeCommand(args)).toEqual({ kind: "usage", problem });
  });

  it("gives the help first", () => {
    expect(parseProbeCommand(["--bad", "-h"])).toEqual({ kind: "help" });
  });
});

describe("probeMain", () => {
  const io = (env: Readonly<Record<string, string | undefined>>) => {
    const out: string[] = [];
    const err: string[] = [];
    return { io: { env, out: (line: string) => out.push(line), err: (line: string) => err.push(line) }, out, err };
  };
  const ENV = { [SECRET_VARIABLES.github]: TOKEN };

  it("writes the record as JSON and exits with 0", async () => {
    const github = fakeGitHub();
    const clock = fakeClock(0);
    const at = io(ENV);
    const code = await drive(clock, probeMain(["--repository", "octo/app", "--tries", "2"], at.io, { transport: github.transport, clock, now: () => "2026-11-15T20:00:00.000Z" }));
    expect(code).toBe(0);
    expect(at.err).toEqual([]);
    const record = JSON.parse(at.out.join("\n")) as ProbeRecord;
    expect(record).toMatchObject({ format: "github-probe/1", repository: "octo/app", token: "fine-grained", clean: true });
    expect(at.out.join("\n")).not.toContain(TOKEN);
  });

  it("exits with 1 when the probe leaves a runner on GitHub", async () => {
    const github = fakeGitHub({ refuse: (method) => (method === "DELETE" ? 500 : null) });
    const clock = fakeClock(0);
    const at = io(ENV);
    const code = await drive(clock, probeMain(["--repository", "octo/app"], at.io, { transport: github.transport, clock }));
    expect(code).toBe(1);
    expect(at.err).toEqual(["The probe did not remove its runner or its group. Remove each name that starts with runner-dispatch-probe on GitHub."]);
  });

  it("gives the help, a bad command, and a missing or bad token", async () => {
    const help = io({});
    expect(await probeMain(["--help"], help.io)).toBe(0);
    expect(help.out).toEqual([PROBE_USAGE]);
    const bad = io(ENV);
    expect(await probeMain([], bad.io)).toBe(2);
    expect(bad.err).toEqual(["The command has no option --repository.", PROBE_USAGE]);
    const none = io({});
    expect(await probeMain(["--repository", "octo/app"], none.io)).toBe(1);
    expect(none.err).toEqual([`The variable ${SECRET_VARIABLES.github} is not set.`]);
    const space = io({ [SECRET_VARIABLES.github]: "a b" });
    expect(await probeMain(["--repository", "octo/app"], space.io)).toBe(1);
    expect(space.err).toEqual([`The variable ${SECRET_VARIABLES.github} is not a token: it has a space, a line break or a character that is not ASCII.`]);
  });

  it("removes the token from the text of each error", async () => {
    const at = io(ENV);
    const transport: RestTransport = () => Promise.reject(new Error(`The transport failed with ${TOKEN}.`));
    const clock = fakeClock(0);
    const code = await drive(clock, probeMain(["--repository", "octo/app"], at.io, { transport, clock }));
    expect(code).toBe(0);
    const record = JSON.parse(at.out.join("\n")) as ProbeRecord;
    expect(record.steps.every((step) => step.status === null && step.problem !== null && step.problem.includes("The transport failed"))).toBe(true);
    expect(record.runner).toEqual({ made: false, labels: [], removed: true });
    expect(at.out.join("\n")).not.toContain(TOKEN);
  });
});
