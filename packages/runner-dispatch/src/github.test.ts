import { fakeClock } from "@mark1russell7/algebra/clock";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createDispatcher } from "./dispatcher.ts";
import {
  checkRunnerGroup,
  createGitHubSource,
  judgeRunnerGroup,
  OPEN_RUN_STATUSES,
  organizationScope,
  type GitHubAnswer,
  type GitHubApi,
  type GitHubRequest,
  type RunnerGroupFacts,
} from "./github.ts";
import type { MachineTimes } from "./lifecycle.ts";
import { decide, type TrustRules } from "./policy.ts";
import type { JobSource, RepositoryView } from "./ports.ts";
import type { RunKey, RunRecord } from "./records.ts";
import type { DispatchSettings } from "./settings.ts";
import { countingSuffix, fakeGitHubApi, fakeWorld, type FakeWorld, type WorldTimes } from "./testing.ts";

const REPO = "octo/app";
const OTHER = "octo/lib";
const SECRET = "secret-of-the-answer";
const RULES: TrustRules = { repositories: [REPO, OTHER], events: ["push", "pull_request"], actors: ["octo"] };
const TIMES: MachineTimes = { make: 60, register: 60, idle: 30, job: 600, retry: 5, retryMax: 40, pass: 10 };
const SETTINGS: DispatchSettings = { prefix: "rd", capacity: 3, sizes: ["small", "large"], standard: "small" };
const WORLD: WorldTimes = { boot: 2000, connect: 1000, destroy: 500 };
const FORK: Partial<RunRecord> = { event: "pull_request", headRepository: "evil/app", actor: "evil", triggeringActor: "evil" };
const signal = new AbortController().signal;

const runRecord = (runId = 100, over: Partial<RunRecord> = {}): RunRecord => ({
  repository: REPO,
  runId,
  runAttempt: 1,
  event: "push",
  headRepository: REPO,
  actor: "octo",
  triggeringActor: "octo",
  ...over,
});

/** This function gives a view in one order: the runs by id, the jobs by id and the runners by id. */
const sorted = (view: RepositoryView): RepositoryView => ({
  runs: [...view.runs]
    .sort((a, b) => a.run.runId - b.run.runId || a.run.runAttempt - b.run.runAttempt)
    .map((run) => ({ run: run.run, jobs: [...run.jobs].sort((a, b) => a.jobId - b.jobId) })),
  runners: [...view.runners].sort((a, b) => a.runnerId - b.runnerId),
  ...(view.scope === undefined ? {} : { scope: view.scope }),
});

/** This type is a client of the REST API that a test writes, with the record of each request. */
interface Scripted {
  readonly api: GitHubApi;
  readonly requests: GitHubRequest[];
}

/** This function makes a client that gives the answer of a function to each request. */
const scripted = (answer: (request: GitHubRequest) => GitHubAnswer): Scripted => {
  const requests: GitHubRequest[] = [];
  return {
    requests,
    api: {
      request(request: GitHubRequest): Promise<GitHubAnswer> {
        requests.push(request);
        return Promise.resolve(answer(request));
      },
    },
  };
};

const ok = (body: unknown): GitHubAnswer => ({ status: 200, body });
const runJson = (runId: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: runId,
  run_attempt: 1,
  event: "push",
  status: "queued",
  repository: { full_name: REPO },
  head_repository: { full_name: REPO },
  actor: { login: "octo" },
  triggering_actor: { login: "octo" },
  ...over,
});
const jobJson = (jobId: number, runId: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: jobId,
  run_id: runId,
  run_attempt: 1,
  status: "queued",
  labels: [`run-${runId}-1`],
  runner_name: null,
  ...over,
});

/**
 * This function makes a client for one repository with fixed runs, jobs and runners.
 * The runs go in the list of their status. The function `more` gives an answer first, or `null`.
 */
const repository = (
  runs: readonly Record<string, unknown>[],
  jobs: Readonly<Record<string, readonly unknown[]>> = {},
  runners: readonly unknown[] = [],
  more: (request: GitHubRequest) => GitHubAnswer | null = () => null,
): Scripted =>
  scripted((request) => {
    const given = more(request);
    if (given !== null) return given;
    const base = `/repos/${REPO}/actions`;
    if (request.path === `${base}/runs`) {
      const listed = runs.filter((run) => run["status"] === request.query["status"]);
      return ok({ total_count: listed.length, workflow_runs: listed });
    }
    const attempt = /^\/repos\/octo\/app\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/.exec(request.path);
    if (attempt !== null) {
      const list = jobs[`${attempt[1]}-${attempt[2]}`] ?? [];
      return ok({ total_count: list.length, jobs: list });
    }
    if (request.path === `${base}/runners`) return ok({ total_count: runners.length, runners });
    return { status: 404, body: { message: "Not Found" } };
  });

describe("createGitHubSource: the view", () => {
  it("lists the runs of each open status, and reads the jobs of each run and the runners", async () => {
    const at = repository(
      [runJson(100), runJson(101, { status: "in_progress", run_attempt: 2 })],
      {
        "100-1": [jobJson(1, 100)],
        "101-2": [jobJson(2, 101, { run_attempt: 2, status: "in_progress", runner_name: "rd-101-2-00000000" }), jobJson(3, 101, { run_attempt: 2, status: "completed" })],
      },
      [{ id: 7, name: "rd-101-2-00000000", os: "linux", status: "online", busy: true, labels: [] }],
    );
    const view = await createGitHubSource({ api: at.api }).view(REPO, [], signal);
    expect(view).toEqual({
      runs: [
        { run: runRecord(100), jobs: [{ repository: REPO, jobId: 1, runId: 100, runAttempt: 1, labels: ["run-100-1"], status: "queued", runner: null }] },
        {
          run: runRecord(101, { runAttempt: 2 }),
          jobs: [
            { repository: REPO, jobId: 2, runId: 101, runAttempt: 2, labels: ["run-101-1"], status: "in_progress", runner: "rd-101-2-00000000" },
            { repository: REPO, jobId: 3, runId: 101, runAttempt: 2, labels: ["run-101-1"], status: "completed", runner: null },
          ],
        },
      ],
      runners: [{ runnerId: 7, name: "rd-101-2-00000000", online: true, busy: true }],
    });
    expect(OPEN_RUN_STATUSES).toEqual(["queued", "in_progress", "requested", "waiting", "pending"]);
    expect(at.requests.map((request) => [request.method, request.path, request.query["status"] ?? null])).toEqual([
      ["GET", `/repos/${REPO}/actions/runs`, "queued"],
      ["GET", `/repos/${REPO}/actions/runs`, "in_progress"],
      ["GET", `/repos/${REPO}/actions/runs`, "requested"],
      ["GET", `/repos/${REPO}/actions/runs`, "waiting"],
      ["GET", `/repos/${REPO}/actions/runs`, "pending"],
      ["GET", `/repos/${REPO}/actions/runs/100/attempts/1/jobs`, null],
      ["GET", `/repos/${REPO}/actions/runs/101/attempts/2/jobs`, null],
      ["GET", `/repos/${REPO}/actions/runners`, null],
    ]);
    expect(at.requests.every((request) => request.query["per_page"] === "100" && request.query["page"] === "1" && request.body === null)).toBe(true);
  });

  it("sends 5 + r + 1 requests for a repository with r open runs and no named run that is not in the lists", async () => {
    for (const count of [0, 1, 4]) {
      const runs = Array.from({ length: count }, (_, index) => runJson(100 + index));
      const at = repository(runs);
      await createGitHubSource({ api: at.api }).view(REPO, runs.map((run) => ({ repository: REPO, runId: run["id"] as number, runAttempt: 1 })), signal);
      expect(at.requests.length).toBe(OPEN_RUN_STATUSES.length + count + 1);
    }
  });

  it("shows a run of each open status", async () => {
    const at = repository(["queued", "in_progress", "requested", "waiting", "pending"].map((status, index) => runJson(100 + index, { status })));
    const view = await createGitHubSource({ api: at.api }).view(REPO, [], signal);
    expect(view.runs.map((run) => run.run.runId)).toEqual([100, 101, 102, 103, 104]);
  });

  it("reads each field of the record of a run", async () => {
    const at = repository([
      runJson(100, {
        run_attempt: 3,
        event: "pull_request",
        repository: { full_name: "Octo/App" },
        head_repository: { full_name: "evil/app" },
        actor: { login: "first" },
        triggering_actor: { login: "second" },
      }),
    ], { "100-3": [] });
    const view = await createGitHubSource({ api: at.api }).view(REPO, [], signal);
    expect(view.runs.map((run) => run.run)).toEqual([
      { repository: "Octo/App", runId: 100, runAttempt: 3, event: "pull_request", headRepository: "evil/app", actor: "first", triggeringActor: "second" },
    ]);
  });

  it("keeps a run of two lists one time, with its newest try", async () => {
    const at = repository([runJson(100), runJson(100, { status: "in_progress", run_attempt: 2 }), runJson(100, { status: "waiting" })]);
    const view = await createGitHubSource({ api: at.api }).view(REPO, [], signal);
    expect(view.runs.map((run) => [run.run.runId, run.run.runAttempt])).toEqual([[100, 2]]);
  });

  it("does not show a job that does not wait for a runner yet, and refuses a status that it does not know", async () => {
    const held = repository([runJson(100)], { "100-1": [jobJson(1, 100, { status: "waiting" }), jobJson(2, 100, { status: "pending" }), jobJson(3, 100, { status: "requested" }), jobJson(4, 100)] });
    const view = await createGitHubSource({ api: held.api }).view(REPO, [], signal);
    expect(view.runs[0]?.jobs.map((job) => job.jobId)).toEqual([4]);
    const strange = repository([runJson(100)], { "100-1": [jobJson(1, 100, { status: "parked" })] });
    await expect(createGitHubSource({ api: strange.api }).view(REPO, [], signal)).rejects.toThrow(
      new Error('The job 1 has the status "parked", and the source does not know this status.'),
    );
  });

  it("gives the empty text for a field of the policy that GitHub does not give, and the policy refuses the run", async () => {
    const at = repository([runJson(100, { actor: null, triggering_actor: undefined, event: 7, head_repository: null })]);
    const view = await createGitHubSource({ api: at.api }).view(REPO, [], signal);
    const run = view.runs[0]?.run;
    expect(run).toEqual({ repository: REPO, runId: 100, runAttempt: 1, event: "", headRepository: null, actor: "", triggeringActor: "" });
    expect(decide(RULES, run as RunRecord).trusted).toBe(false);
  });

  it("refuses an answer with a run, a job or a runner of a bad shape", async () => {
    const cases: [Scripted, string][] = [
      [repository([runJson(100, { id: "100" })]), 'A run of the repository "octo/app" has no id or no number of its try.'],
      [repository([runJson(100, { run_attempt: 0 })]), 'A run of the repository "octo/app" has no id or no number of its try.'],
      [repository([runJson(100, { repository: { full_name: "evil/app" } })]), 'The run 100 is a run of the repository "evil/app", not of the repository "octo/app".'],
      [repository([runJson(100, { repository: null })]), "The run 100 has no repository."],
      [repository([runJson(100)], { "100-1": [jobJson(0, 100)] }), "A job of the run 100 has no id."],
      [repository([runJson(100)], { "100-1": [jobJson(1, 101)] }), "The job 1 is not a job of the run 100, try 1."],
      [repository([runJson(100)], { "100-1": [jobJson(1, 100, { run_attempt: 2 })] }), "The job 1 is not a job of the run 100, try 1."],
      [repository([runJson(100)], { "100-1": [jobJson(1, 100, { labels: [3] })] }), "The labels of the job 1 are not a list of texts."],
      [repository([runJson(100)], { "100-1": [jobJson(1, 100, { labels: "run-100-1" })] }), "The labels of the job 1 are not a list of texts."],
      [repository([runJson(100)], { "100-1": [jobJson(1, 100, { runner_name: 4 })] }), "The runner of the job 1 is not a text."],
      [repository([], {}, [{ id: 7, name: "rd", status: "online" }]), "A runner of the answer has no id, no name or no busy field."],
      [repository([], {}, [{ id: 7, name: "", status: "online", busy: false }]), "A runner of the answer has no id, no name or no busy field."],
    ];
    for (const [at, text] of cases) await expect(createGitHubSource({ api: at.api }).view(REPO, [], signal)).rejects.toThrow(new Error(text));
  });

  it("gives null for an empty runner name, and false for a runner whose status is not online", async () => {
    const at = repository([runJson(100)], { "100-1": [jobJson(1, 100, { runner_name: "" })] }, [
      { id: 7, name: "rd", status: "offline", busy: false },
      { id: 8, name: "rd-b", busy: true },
    ]);
    const view = await createGitHubSource({ api: at.api }).view(REPO, [], signal);
    expect([view.runs[0]?.jobs[0]?.runner, view.runners]).toEqual([
      null,
      [
        { runnerId: 7, name: "rd", online: false, busy: false },
        { runnerId: 8, name: "rd-b", online: false, busy: true },
      ],
    ]);
  });
});

describe("createGitHubSource: the pages of a list", () => {
  /** This function makes a client whose list of queued runs has the pages of a function. */
  const paged = (page: (number: number) => GitHubAnswer): Scripted =>
    repository([], {}, [], (request) => (request.path.endsWith("/runs") && request.query["status"] === "queued" ? page(Number(request.query["page"])) : null));

  it("reads each page to the count of the list", async () => {
    const at = paged((number) => ok({ total_count: 3, workflow_runs: number === 1 ? [runJson(100), runJson(101)] : number === 2 ? [runJson(102)] : [] }));
    const view = await createGitHubSource({ api: at.api }).view(REPO, [], signal);
    expect(view.runs.map((run) => run.run.runId)).toEqual([100, 101, 102]);
    expect(at.requests.filter((request) => request.query["status"] === "queued").map((request) => request.query["page"])).toEqual(["1", "2"]);
  });

  it("reads a list of 1,000 runs, the most that GitHub gives", async () => {
    const at = paged((number) => ok({ total_count: 1000, workflow_runs: Array.from({ length: number <= 10 ? 100 : 0 }, (_, index) => runJson(number * 1000 + index)) }));
    const view = await createGitHubSource({ api: at.api }).view(REPO, [], signal);
    expect(view.runs.length).toBe(1000);
  });

  it("refuses a list that changed between its pages, that ended before its count, or that has more items than its count", async () => {
    const cases: [(number: number) => GitHubAnswer, string][] = [
      [(number) => ok({ total_count: number === 1 ? 3 : 2, workflow_runs: [runJson(100 + number)] }), `The list /repos/${REPO}/actions/runs changed between its pages.`],
      [(number) => ok({ total_count: 3, workflow_runs: number === 1 ? [runJson(100)] : [] }), `The list /repos/${REPO}/actions/runs ended before its count of 3 items.`],
      [() => ok({ total_count: 1, workflow_runs: [runJson(100), runJson(101)] }), `The list /repos/${REPO}/actions/runs has 2 items, and its count is 1.`],
      [() => ok({ total_count: 1001, workflow_runs: [runJson(100)] }), `The list /repos/${REPO}/actions/runs has 1001 items, and GitHub gives 1000 at most.`],
      [() => ok({ total_count: -1, workflow_runs: [] }), `The answer to the list /repos/${REPO}/actions/runs has no count or no field workflow_runs.`],
      [() => ok({ total_count: 1, runs: [runJson(100)] }), `The answer to the list /repos/${REPO}/actions/runs has no count or no field workflow_runs.`],
      [() => ok(null), `The answer to the list /repos/${REPO}/actions/runs has no count or no field workflow_runs.`],
    ];
    for (const [page, text] of cases) await expect(createGitHubSource({ api: paged(page).api }).view(REPO, [], signal)).rejects.toThrow(new Error(text));
  });

  it("refuses a status that is not 200, and the error has no part of the body", async () => {
    for (const status of [304, 403, 404, 429, 500]) {
      const at = paged(() => ({ status, body: { message: SECRET } }));
      const error = await createGitHubSource({ api: at.api })
        .view(REPO, [], signal)
        .catch((caught: unknown) => caught);
      expect(error).toEqual(new Error(`GitHub answered the list /repos/${REPO}/actions/runs with the status ${status}.`));
    }
    const odd = paged(() => ({ status: Number.NaN, body: null }));
    await expect(createGitHubSource({ api: odd.api }).view(REPO, [], signal)).rejects.toThrow(
      new Error(`GitHub answered the list /repos/${REPO}/actions/runs with the status that is not a number.`),
    );
  });
});

describe("createGitHubSource: the named runs", () => {
  const named = (runId: number, runAttempt = 1, name = REPO): RunKey => ({ repository: name, runId, runAttempt });
  const lookup = (answer: GitHubAnswer, jobs: Readonly<Record<string, readonly unknown[]>> = {}): Scripted =>
    repository([], jobs, [], (request) => (request.path === `/repos/${REPO}/actions/runs/100` ? answer : null));

  it("asks for a named run that is not in the lists, and shows it when it is not completed", async () => {
    const at = lookup(ok(runJson(100, { status: "in_progress" })), { "100-1": [jobJson(1, 100, { status: "in_progress", runner_name: "rd-100-1-00000000" })] });
    const view = await createGitHubSource({ api: at.api }).view(REPO, [named(100)], signal);
    expect(view.runs.map((run) => [run.run.runId, run.jobs.map((job) => job.status)])).toEqual([[100, ["in_progress"]]]);
    expect(at.requests.map((request) => request.path)).toContain(`/repos/${REPO}/actions/runs/100`);
  });

  it("does not show a named run that is completed or not there", async () => {
    for (const answer of [ok(runJson(100, { status: "completed" })), { status: 404, body: { message: SECRET } }]) {
      const view = await createGitHubSource({ api: lookup(answer).api }).view(REPO, [named(100)], signal);
      expect(view.runs).toEqual([]);
    }
  });

  it("shows the newest try of a named run in place of the named try", async () => {
    const at = lookup(ok(runJson(100, { run_attempt: 2 })), { "100-2": [jobJson(1, 100, { run_attempt: 2 })] });
    const view = await createGitHubSource({ api: at.api }).view(REPO, [named(100)], signal);
    expect(view.runs.map((run) => [run.run.runId, run.run.runAttempt])).toEqual([[100, 2]]);
  });

  it("does not ask for a named run of the lists, of a different repository, or with no id", async () => {
    const at = repository([runJson(100)]);
    await createGitHubSource({ api: at.api }).view(REPO, [named(100), named(100, 2), named(200, 1, OTHER), named(0)], signal);
    expect(at.requests.some((request) => /\/runs\/\d+$/.test(request.path))).toBe(false);
  });

  it("asks one time for a named run with a name in a different case", async () => {
    const at = lookup(ok(runJson(100)));
    const view = await createGitHubSource({ api: at.api }).view(REPO, [named(100, 1, "Octo/App")], signal);
    expect(view.runs.map((run) => run.run.runId)).toEqual([100]);
  });

  it("refuses an answer with a different run, and a status that is not 200 or 404, with no part of the body", async () => {
    await expect(createGitHubSource({ api: lookup(ok(runJson(101))).api }).view(REPO, [named(100)], signal)).rejects.toThrow(
      new Error("GitHub answered the request for the run 100 with a different run."),
    );
    await expect(createGitHubSource({ api: lookup({ status: 500, body: SECRET }).api }).view(REPO, [named(100)], signal)).rejects.toThrow(
      new Error("GitHub answered the request for the run 100 with the status 500."),
    );
  });
});

describe("createGitHubSource: the runners", () => {
  const REQUEST = { repository: REPO, name: "rd-100-1-00000000", labels: ["run-100-1", "small"] };
  const registered = (over: Record<string, unknown> = {}): GitHubAnswer => ({
    status: 201,
    body: { runner: { id: 9, name: REQUEST.name, status: "offline", busy: false, labels: [] }, encoded_jit_config: SECRET, ...over },
  });

  it("asks for a one-job configuration with the name, the labels and the runner group", async () => {
    const at = scripted(() => registered());
    expect(await createGitHubSource({ api: at.api }).register(REQUEST, signal)).toEqual({ runnerId: 9, configuration: SECRET });
    expect(at.requests).toEqual([
      {
        method: "POST",
        path: `/repos/${REPO}/actions/runners/generate-jitconfig`,
        query: {},
        body: { name: REQUEST.name, runner_group_id: 1, labels: REQUEST.labels },
      },
    ]);
    const group = scripted(() => registered());
    await createGitHubSource({ api: group.api, runnerGroup: 4 }).register(REQUEST, signal);
    expect((group.requests[0]?.body as { runner_group_id: number }).runner_group_id).toBe(4);
  });

  it("refuses a refusal of GitHub and an answer with no configuration, and the error has no part of the body", async () => {
    const cases: [GitHubAnswer, string][] = [
      [{ status: 409, body: { message: SECRET } }, 'GitHub answered the request for the runner "rd-100-1-00000000" with the status 409.'],
      [{ status: 200, body: { encoded_jit_config: SECRET, runner: { id: 9, name: REQUEST.name } } }, 'GitHub answered the request for the runner "rd-100-1-00000000" with the status 200.'],
      [registered({ encoded_jit_config: "" }), 'The answer to the request for the runner "rd-100-1-00000000" has no runner id or no configuration.'],
      [registered({ runner: { id: "9", name: REQUEST.name } }), 'The answer to the request for the runner "rd-100-1-00000000" has no runner id or no configuration.'],
      [registered({ runner: { id: 9, name: "rd-other" } }), 'GitHub registered the runner 9 with a name that is not "rd-100-1-00000000".'],
    ];
    for (const [answer, text] of cases) {
      const error = await createGitHubSource({ api: scripted(() => answer).api })
        .register(REQUEST, signal)
        .catch((caught: unknown) => caught);
      expect(error).toEqual(new Error(text));
      expect(String((error as Error).message)).not.toContain(SECRET);
    }
  });

  it("refuses a request with no name or no labels before it asks GitHub", async () => {
    const at = scripted(() => registered());
    const source = createGitHubSource({ api: at.api });
    await expect(source.register({ ...REQUEST, name: "" }, signal)).rejects.toThrow(new TypeError("The name of a runner is not a text with a character."));
    await expect(source.register({ ...REQUEST, labels: [] }, signal)).rejects.toThrow(new TypeError('The labels of the runner "rd-100-1-00000000" are not a list of texts.'));
    await expect(source.register({ ...REQUEST, labels: ["small", ""] }, signal)).rejects.toThrow(new TypeError('The labels of the runner "rd-100-1-00000000" are not a list of texts.'));
    expect(at.requests).toEqual([]);
  });

  it("removes a runner, and succeeds when GitHub does not have it", async () => {
    for (const status of [204, 404]) {
      const at = scripted(() => ({ status, body: null }));
      await createGitHubSource({ api: at.api }).remove(REPO, 9, signal);
      expect(at.requests).toEqual([{ method: "DELETE", path: `/repos/${REPO}/actions/runners/9`, query: {}, body: null }]);
    }
    const busy = scripted(() => ({ status: 422, body: { message: SECRET } }));
    await expect(createGitHubSource({ api: busy.api }).remove(REPO, 9, signal)).rejects.toThrow(
      new Error("GitHub answered the request to remove the runner 9 with the status 422."),
    );
  });

  it("refuses a runner id that is not a whole number from 1 before it asks GitHub", async () => {
    const at = scripted(() => ({ status: 204, body: null }));
    for (const runnerId of [0, -1, 1.5, Number.NaN]) {
      await expect(createGitHubSource({ api: at.api }).remove(REPO, runnerId, signal)).rejects.toThrow(new RangeError("The id of a runner is not a whole number from 1."));
    }
    expect(at.requests).toEqual([]);
  });
});

describe("createGitHubSource: the runners of an organization", () => {
  const REQUEST = { repository: REPO, name: "rd-100-1-00000000", labels: ["run-100-1", "small"] };
  const organization = (runners: readonly unknown[] = []): Scripted =>
    repository([], {}, [], (request) => {
      if (request.path === "/orgs/Octo/actions/runners") return ok({ total_count: runners.length, runners });
      if (request.path === "/orgs/Octo/actions/runners/generate-jitconfig") {
        return { status: 201, body: { runner: { id: 9, name: REQUEST.name }, encoded_jit_config: SECRET } };
      }
      if (request.path === "/orgs/Octo/actions/runners/9") return { status: 204, body: null };
      return null;
    });

  it("lists, registers and removes the runners on the paths of the organization, and the view names the scope", async () => {
    const at = organization([{ id: 9, name: REQUEST.name, status: "online", busy: false }]);
    const source = createGitHubSource({ api: at.api, organization: "Octo", runnerGroup: 3 });
    expect(organizationScope("Octo")).toBe("organization:octo");
    expect(await source.view(REPO, [], signal)).toEqual({ runs: [], runners: [{ runnerId: 9, name: REQUEST.name, online: true, busy: false }], scope: "organization:octo" });
    expect(await source.register({ ...REQUEST, repository: "OCTO/lib" }, signal)).toEqual({ runnerId: 9, configuration: SECRET });
    await source.remove(OTHER, 9, signal);
    expect(at.requests.slice(OPEN_RUN_STATUSES.length).map((request) => [request.method, request.path])).toEqual([
      ["GET", "/orgs/Octo/actions/runners"],
      ["POST", "/orgs/Octo/actions/runners/generate-jitconfig"],
      ["DELETE", "/orgs/Octo/actions/runners/9"],
    ]);
    expect(at.requests[OPEN_RUN_STATUSES.length + 1]?.body).toEqual({ name: REQUEST.name, runner_group_id: 3, labels: REQUEST.labels });
    // The runs stay the runs of the repository.
    expect(at.requests.slice(0, OPEN_RUN_STATUSES.length).every((request) => request.path === `/repos/${REPO}/actions/runs`)).toBe(true);
  });

  it("gives no scope in a view of the runners of a repository", async () => {
    expect(await createGitHubSource({ api: repository([]).api }).view(REPO, [], signal)).not.toHaveProperty("scope");
  });

  it("refuses a repository of a different owner before each request", async () => {
    const at = organization();
    const source = createGitHubSource({ api: at.api, organization: "octo" });
    const text = 'The repository "evil/app" is not a repository of the organization "octo".';
    await expect(source.view("evil/app", [], signal)).rejects.toThrow(new RangeError(text));
    await expect(source.register({ ...REQUEST, repository: "evil/app" }, signal)).rejects.toThrow(new RangeError(text));
    await expect(source.remove("evil/app", 9, signal)).rejects.toThrow(new RangeError(text));
    await expect(source.view("octopus/app", [], signal)).rejects.toThrow(RangeError);
    expect(at.requests).toEqual([]);
  });

  it("refuses an organization that is not a name of GitHub", () => {
    const at = scripted(() => ok(null));
    for (const name of ["", "-octo", "octo-", "oc/to", "octo app", "../x", "a".repeat(40)]) {
      expect(() => createGitHubSource({ api: at.api, organization: name })).toThrow(
        new RangeError(`The organization ${JSON.stringify(name)} of a GitHub source is not a name of GitHub.`),
      );
    }
    expect(() => createGitHubSource({ api: at.api, organization: 5 as unknown as string })).toThrow(
      new RangeError("The organization a value of the type number of a GitHub source is not a name of GitHub."),
    );
    expect(() => createGitHubSource({ api: at.api, organization: "a".repeat(39) })).not.toThrow();
    expect(() => createGitHubSource({ api: at.api, organization: "o" })).not.toThrow();
    expect(() => createGitHubSource({ api: at.api, organization: "my-org-2" })).not.toThrow();
  });
});

describe("the check of a runner group", () => {
  const group = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 3,
    name: "home",
    visibility: "selected",
    default: false,
    allows_public_repositories: false,
    ...over,
  });
  const repo = (full_name: string, closed = true): Record<string, unknown> => ({ id: 1, full_name, private: closed });
  const RULES_OF_GROUP = { served: [REPO, OTHER] };

  it("passes a group that names each served repository and no other repository, and admits no public repository", () => {
    expect(judgeRunnerGroup({ group: group(), repositories: [repo("Octo/App"), repo(OTHER)] }, RULES_OF_GROUP)).toEqual({ pass: true, problems: [] });
    const open = { group: group({ allows_public_repositories: true }), repositories: [repo(REPO, false), repo(OTHER)] };
    expect(judgeRunnerGroup(open, { ...RULES_OF_GROUP, publicRepositories: true })).toEqual({ pass: true, problems: [] });
  });

  it("gives each problem of a group", () => {
    const cases: [RunnerGroupFacts, string[]][] = [
      [{ group: group({ visibility: "all" }), repositories: null }, ["The group admits each repository of the organization."]],
      [{ group: group({ visibility: "private" }), repositories: null }, ["The group admits each private repository of the organization."]],
      [{ group: group({ visibility: "some" }), repositories: null }, ['The group has the visibility "some", and the check does not know it.']],
      [{ group: group(), repositories: null }, ["The group names its repositories, and the check has no list of them."]],
      [{ group: group({ allows_public_repositories: true }), repositories: [repo(REPO), repo(OTHER)] }, ["The group admits public repositories."]],
      [{ group: group({ allows_public_repositories: "no" }), repositories: [repo(REPO), repo(OTHER)] }, ["The group has no field allows_public_repositories."]],
      [
        { group: group(), repositories: [repo(REPO), repo(OTHER), repo("octo/secret")] },
        ['The group admits the repository "octo/secret", and the dispatcher does not serve it.'],
      ],
      [{ group: group(), repositories: [repo(REPO)] }, ['The group does not name the served repository "octo/lib".']],
      [
        { group: group(), repositories: [repo(REPO, false), repo(OTHER)] },
        ['The served repository "octo/app" is public, and the group admits no public repository.'],
      ],
      [
        { group: group(), repositories: [repo(REPO), repo(OTHER), { full_name: "octo/x" }, "octo/y"] },
        ["A repository of the group has no name or no field private.", "A repository of the group has no name or no field private."],
      ],
      [{ group: null, repositories: null }, ["The group has no field allows_public_repositories.", "The group has no visibility."]],
    ];
    for (const [facts, problems] of cases) expect(judgeRunnerGroup(facts, RULES_OF_GROUP)).toEqual({ pass: false, problems });
  });

  it("reads the group and the pages of its repositories", async () => {
    const at = scripted((request) => {
      if (request.path === "/orgs/octo/actions/runner-groups/3") return ok(group());
      if (request.path === "/orgs/octo/actions/runner-groups/3/repositories") {
        const all = [repo(REPO), repo(OTHER)];
        const part = request.query["page"] === "1" ? all.slice(0, 1) : all.slice(1);
        return ok({ total_count: all.length, repositories: part });
      }
      return { status: 404, body: null };
    });
    expect(await checkRunnerGroup(at.api, "octo", 3, RULES_OF_GROUP, signal)).toEqual({ pass: true, problems: [] });
    expect(at.requests.map((request) => [request.path, request.query["page"] ?? null])).toEqual([
      ["/orgs/octo/actions/runner-groups/3", null],
      ["/orgs/octo/actions/runner-groups/3/repositories", "1"],
      ["/orgs/octo/actions/runner-groups/3/repositories", "2"],
    ]);
  });

  it("does not read the repositories of a group that does not name them", async () => {
    const at = scripted(() => ok(group({ visibility: "all" })));
    expect((await checkRunnerGroup(at.api, "octo", 3, RULES_OF_GROUP, signal)).pass).toBe(false);
    expect(at.requests.length).toBe(1);
  });

  it("throws when GitHub does not give the group, and the error has no part of the body", async () => {
    const cases: [GitHubAnswer, string][] = [
      [{ status: 403, body: { message: SECRET } }, "GitHub answered the request for the runner group 3 with the status 403."],
      [{ status: 200, body: { ...group(), id: 4, name: SECRET } }, "GitHub answered the request for the runner group 3 with a different group."],
    ];
    for (const [answer, text] of cases) {
      const error = await checkRunnerGroup(scripted(() => answer).api, "octo", 3, RULES_OF_GROUP, signal).catch((caught: unknown) => caught);
      expect(error).toEqual(new Error(text));
    }
    const list = scripted((request) => (request.path.endsWith("/repositories") ? { status: 500, body: { message: SECRET } } : ok(group())));
    await expect(checkRunnerGroup(list.api, "octo", 3, RULES_OF_GROUP, signal)).rejects.toThrow(
      new Error("GitHub answered the list /orgs/octo/actions/runner-groups/3/repositories with the status 500."),
    );
  });

  it("refuses an organization or a group that is not valid before it asks GitHub", async () => {
    const at = scripted(() => ok(group()));
    await expect(checkRunnerGroup(at.api, "oc/to", 3, RULES_OF_GROUP, signal)).rejects.toThrow(new RangeError('The organization "oc/to" is not a name of GitHub.'));
    for (const id of [0, 1.5, -1]) {
      await expect(checkRunnerGroup(at.api, "octo", id, RULES_OF_GROUP, signal)).rejects.toThrow(new RangeError("The runner group is not a whole number from 1."));
    }
    await expect(checkRunnerGroup(at.api, "octo", 3, RULES_OF_GROUP, { aborted: true })).rejects.toThrow(
      new Error("The signal stopped the request GET /orgs/octo/actions/runner-groups/3."),
    );
    expect(at.requests).toEqual([]);
  });
});

describe("createGitHubSource: the names and the signal", () => {
  it("refuses a repository that is not a name as owner/name, before each request", async () => {
    const at = scripted(() => ok({ total_count: 0, workflow_runs: [] }));
    const source = createGitHubSource({ api: at.api });
    for (const name of ["octo", "octo/app/x", "octo/..", "octo/.", "../app", "octo/a b", "octo/app?x=1", "", "octo/app#"]) {
      const text = `The repository ${JSON.stringify(name)} is not a name as owner/name.`;
      await expect(source.view(name, [], signal)).rejects.toThrow(new TypeError(text));
      await expect(source.register({ repository: name, name: "rd", labels: ["x"] }, signal)).rejects.toThrow(new TypeError(text));
      await expect(source.remove(name, 1, signal)).rejects.toThrow(new TypeError(text));
    }
    expect(at.requests).toEqual([]);
  });

  it("sends no request after the signal stops", async () => {
    const at = scripted(() => ok({ total_count: 0, workflow_runs: [] }));
    const stopped = { aborted: true };
    const source = createGitHubSource({ api: at.api });
    await expect(source.view(REPO, [], stopped)).rejects.toThrow(new Error(`The signal stopped the request GET /repos/${REPO}/actions/runs.`));
    await expect(source.remove(REPO, 9, stopped)).rejects.toThrow(new Error(`The signal stopped the request DELETE /repos/${REPO}/actions/runners/9.`));
    expect(at.requests).toEqual([]);
  });

  it("refuses a runner group that is not a whole number from 1", () => {
    const at = scripted(() => ok(null));
    for (const runnerGroup of [0, 1.5, -2]) {
      expect(() => createGitHubSource({ api: at.api, runnerGroup })).toThrow(new RangeError("The runner group of a GitHub source is not a whole number from 1."));
    }
  });
});

describe("fakeGitHubApi", () => {
  const made = (pageSize = 2): { world: FakeWorld; source: JobSource; api: ReturnType<typeof fakeGitHubApi> } => {
    const world = fakeWorld({ clock: fakeClock(0), times: WORLD });
    const api = fakeGitHubApi(world, { pageSize });
    return { world, api, source: createGitHubSource({ api: api.api }) };
  };

  it("gives the lists in pages, with the newest run first", async () => {
    const at = made(2);
    for (const runId of [100, 101, 102]) at.world.addRun(runRecord(runId), [{ labels: ["ubuntu-latest"], duration: 0 }]);
    const first = await at.api.api.request({ method: "GET", path: `/repos/${REPO}/actions/runs`, query: { status: "queued", per_page: "100", page: "1" }, body: null }, signal);
    expect(first.status).toBe(200);
    expect((first.body as { total_count: number; workflow_runs: { id: number }[] }).workflow_runs.map((run) => run.id)).toEqual([102, 101]);
    const view = await at.source.view(REPO, [], signal);
    expect(view.runs.map((run) => run.run.runId)).toEqual([102, 101, 100]);
    // The test sent one request, and the view read two pages.
    expect(at.api.requests().filter((request) => request.query["status"] === "queued").map((request) => request.query["page"])).toEqual(["1", "1", "2"]);
  });

  it("answers 409 for a runner name that the repository has, 422 for a busy runner and 404 for a runner that is not there", async () => {
    const at = made();
    const request = { repository: REPO, name: "rd-100-1-00000000", labels: ["run-100-1"] };
    const runner = await at.source.register(request, signal);
    await expect(at.source.register(request, signal)).rejects.toThrow(new Error('GitHub answered the request for the runner "rd-100-1-00000000" with the status 409.'));
    await at.source.remove(REPO, runner.runnerId, signal);
    await at.source.remove(REPO, runner.runnerId, signal);
    expect(at.api.requests().map((each) => each.method)).toEqual(["POST", "POST", "DELETE", "DELETE"]);
    expect(at.world.runners()).toEqual([]);
  });

  it("keeps the runners of an organization and of a repository in separate scopes, and answers 404 for an organization that the world does not have", async () => {
    const world = fakeWorld({ clock: fakeClock(0), times: WORLD, organizations: ["octo"] });
    const api = fakeGitHubApi(world);
    const source = createGitHubSource({ api: api.api, organization: "octo" });
    const request = { repository: REPO, name: "rd-100-1-00000000", labels: ["run-100-1"] };
    const made = await source.register(request, signal);
    expect(world.runners().map((runner) => runner.scope)).toEqual(["octo"]);
    expect([world.scopeOf(REPO), world.scopeOf("Octo/Lib"), world.scopeOf("evil/app"), world.organizations()]).toEqual(["octo", "octo", "evil/app", ["octo"]]);
    expect((await source.view(OTHER, [], signal)).runners.map((runner) => runner.name)).toEqual([request.name]);
    expect(sorted(await source.view(OTHER, [], signal))).toEqual(sorted(await world.source.view(OTHER, [], signal)));
    // The repository has no runner of its own, and a runner of the repository is not a runner of the organization.
    const own = createGitHubSource({ api: api.api });
    expect((await own.view(REPO, [], signal)).runners).toEqual([]);
    await own.register({ ...request, name: "rd-100-1-00000001" }, signal);
    expect(world.runners().map((runner) => [runner.name, runner.scope])).toEqual([
      [request.name, "octo"],
      ["rd-100-1-00000001", REPO],
    ]);
    expect((await source.view(REPO, [], signal)).runners.map((runner) => runner.name)).toEqual([request.name]);
    const missing = await api.api.request({ method: "GET", path: "/orgs/evil/actions/runners", query: {}, body: null }, signal);
    expect(missing.status).toBe(404);
    const unknown = await api.api.request({ method: "GET", path: "/orgs/octo/actions/runs", query: {}, body: null }, signal);
    expect(unknown.status).toBe(404);
    await source.remove(OTHER, made.runnerId, signal);
    expect(world.runners().map((runner) => runner.name)).toEqual(["rd-100-1-00000001"]);
  });

  it("refuses a page size that is not a whole number from 1", () => {
    const world = fakeWorld({ clock: fakeClock(0), times: WORLD });
    expect(() => fakeGitHubApi(world, { pageSize: 0 })).toThrow(new RangeError("The page size of a fake API is not a whole number from 1."));
  });
});

describe("the GitHub source on a fake world: each scenario", () => {
  type Kind = "trusted" | "fork";
  const scenario = fc.record({
    runs: fc.array(
      fc.record({
        at: fc.integer({ min: 0, max: 40 }).map((seconds) => seconds * 1000),
        repository: fc.constantFrom(REPO, OTHER),
        kind: fc.constantFrom<Kind>("trusted", "trusted", "fork"),
        jobs: fc.array(fc.record({ own: fc.boolean(), duration: fc.integer({ min: 0, max: 15_000 }) }), { minLength: 1, maxLength: 3 }),
        cancel: fc.option(fc.integer({ min: 0, max: 60 }).map((seconds) => seconds * 1000), { nil: null }),
      }),
      { minLength: 1, maxLength: 5 },
    ),
    pageSize: fc.integer({ min: 1, max: 4 }),
    period: fc.constantFrom(1000, 5000),
    organization: fc.boolean(),
  });
  const LIMIT = 600_000;

  it("gives the view of the fake source at each pass, and the dispatcher on it does each served job one time", async () => {
    const seen = { working: 0, completed: 0, busy: 0, offline: 0, paged: 0, cancelled: 0, organization: 0, shared: 0 };
    await fc.assert(
      fc.asyncProperty(scenario, async (given) => {
        const clock = fakeClock(0);
        const world = fakeWorld({ clock, times: WORLD, ...(given.organization ? { organizations: ["octo"] } : {}) });
        const fake = fakeGitHubApi(world, { pageSize: given.pageSize });
        const source = createGitHubSource({ api: fake.api, ...(given.organization ? { organization: "octo" } : {}) });
        const dispatcher = createDispatcher({
          rules: RULES,
          times: TIMES,
          settings: SETTINGS,
          source,
          provider: world.provider,
          now: () => clock.now(),
          suffix: countingSuffix(),
          stopped: () => false,
        });
        const runs = given.runs.map((run, index) => ({ ...run, runId: 100 + index }));
        const record = (run: (typeof runs)[number]): RunRecord =>
          runRecord(run.runId, { repository: run.repository, headRepository: run.repository, ...(run.kind === "fork" ? FORK : {}) });
        const pending = [...runs].sort((a, b) => a.at - b.at);
        const cancels = runs.filter((run) => run.cancel !== null).sort((a, b) => (a.cancel ?? 0) - (b.cancel ?? 0));
        const served = (run: (typeof runs)[number], own: boolean): boolean => run.kind === "trusted" && own && run.cancel === null;
        const last = Math.max(...runs.map((run) => Math.max(run.at, run.cancel ?? 0)));
        while (clock.now() <= LIMIT) {
          const now = clock.now();
          while (pending[0] !== undefined && pending[0].at <= now) {
            const run = pending.shift();
            if (run === undefined) break;
            world.addRun(record(run), run.jobs.map((job) => ({ labels: job.own ? [`run-${run.runId}-1`] : ["ubuntu-latest"], duration: job.duration })));
          }
          while (cancels[0] !== undefined && (cancels[0].cancel ?? 0) <= now) {
            const run = cancels.shift();
            if (run !== undefined && !pending.includes(run)) world.cancelRun(record(run));
          }
          // The two sources give the same view of each repository, also for a name in a different case.
          const named: RunKey[] = [
            ...world.machines().map(({ machine }) => ({ repository: machine.repository, runId: machine.runId, runAttempt: machine.runAttempt })),
            { repository: REPO, runId: 999, runAttempt: 1 },
            ...runs.map((run) => ({ repository: run.repository, runId: run.runId, runAttempt: 1 })),
          ];
          for (const name of [REPO, OTHER, "Octo/App"]) {
            const view = sorted(await source.view(name, named, signal));
            expect(view).toEqual(sorted(await world.source.view(name, named, signal)));
            const jobs = view.runs.flatMap((run) => run.jobs);
            if (jobs.some((job) => job.status === "in_progress")) seen.working += 1;
            if (jobs.some((job) => job.status === "completed")) seen.completed += 1;
            if (view.runners.some((runner) => runner.busy)) seen.busy += 1;
            if (view.runners.some((runner) => !runner.online)) seen.offline += 1;
          }
          await dispatcher.pass(signal);
          await clock.advance(given.period);
          const done = runs.every((run, index) =>
            run.jobs.every((job, place) => !served(run, job.own) || world.jobs().filter((each) => each.runId === 100 + index)[place]?.status === "completed"),
          );
          if (now >= last && done && world.machines().length === 0 && world.runners().length === 0) break;
        }
        const jobs = world.jobs();
        for (const run of runs) {
          const mine = jobs.filter((job) => job.runId === run.runId);
          run.jobs.forEach((job, place) => {
            if (served(run, job.own)) expect(mine[place]).toMatchObject({ status: "completed", ran: true, result: "success" });
            if (run.kind === "fork") expect(mine[place]?.ran).toBe(false);
          });
        }
        expect(world.machines()).toEqual([]);
        expect(world.runners()).toEqual([]);
        const starts = world.events().filter((event) => event.kind === "job-started" || event.kind === "job-refused");
        expect(new Set(starts.map((event) => event.name)).size).toBe(starts.length);
        if (fake.requests().some((request) => request.query["page"] === "2")) seen.paged += 1;
        if (world.jobs().some((job) => job.result === "cancelled" && job.runner !== null)) seen.cancelled += 1;
        // The views of the two repositories of an organization show the same runners. The dispatcher removes each runner one time at most.
        const removals = fake.requests().filter((request) => request.method === "DELETE").map((request) => request.path);
        expect(new Set(removals).size).toBe(removals.length);
        if (given.organization) seen.organization += 1;
        if (given.organization && removals.length > 0 && runs.some((run) => run.repository === OTHER)) seen.shared += 1;
      }),
      { numRuns: 200, seed: 20261112 },
    );
    // The scenarios reach each state that the view shows.
    expect(Object.entries(seen).filter(([, count]) => count === 0)).toEqual([]);
  }, 300_000);
});
