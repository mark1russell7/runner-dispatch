import { isObject, isRepositoryName, show } from "./policy.ts";
import type {
  JobSource,
  JobStatus,
  RepositoryView,
  RunnerRegistration,
  RunnerRequest,
  SourceJob,
  SourceRun,
  SourceRunner,
  StopSignal,
} from "./ports.ts";
import { foldName, isId, sameName, type RunKey, type RunRecord } from "./records.ts";

/** This type is the method of a request to the REST API of GitHub. */
export type GitHubMethod = "GET" | "POST" | "DELETE";

/** This record is one request to the REST API of GitHub. */
export interface GitHubRequest {
  /** This field is the method of the request. */
  readonly method: GitHubMethod;
  /** This field is the path of the request, for example `/repos/octo/app/actions/runners`. Each part of the path is a valid name. */
  readonly path: string;
  /** This field has the parameters of the query, for example `per_page`. */
  readonly query: Readonly<Record<string, string>>;
  /** This field is the JSON body of the request. It is `null` for a request with no body. */
  readonly body: unknown;
}

/** This record is the answer of GitHub to one request. */
export interface GitHubAnswer {
  /**
   * This field is the HTTP status of the answer.
   * When a conditional request gets the status 304, the client gives the stored answer with its status 200.
   */
  readonly status: number;
  /** This field is the JSON body of the answer. It is `null` for an answer with no body. */
  readonly body: unknown;
}

/**
 * This port is a client of the REST API of GitHub. The client adds the credential and the version of the API to each request.
 * It sends a conditional request when it has an answer with an `ETag`, and it limits the rate of its requests.
 * Each status is an answer. The method throws only when it gets no answer, or when the signal stops the request.
 */
export interface GitHubApi<Signal extends StopSignal = StopSignal> {
  /** This method sends one request and gives the answer of GitHub. */
  request(request: GitHubRequest, signal: Signal): Promise<GitHubAnswer>;
}

/** This record has the options of a GitHub source. */
export interface GitHubSourceOptions<Signal extends StopSignal = StopSignal> {
  /** This field is the client of the REST API. */
  readonly api: GitHubApi<Signal>;
  /** This field is the id of the runner group of each new runner. The default group of a repository or of an organization has the id 1. */
  readonly runnerGroup?: number;
  /**
   * This field names the organization of the runners. The source then registers each runner on the organization, and each repository must be a repository of it.
   * When it is absent, the source registers each runner on the repository of its run.
   */
  readonly organization?: string;
}

/** This list has each status of a run that is not completed. The source lists the runs of each status. */
export const OPEN_RUN_STATUSES = ["queued", "in_progress", "requested", "waiting", "pending"] as const;

/** This list has each status of a job that does not wait for a runner yet. The view does not show such a job. */
export const HELD_JOB_STATUSES = ["waiting", "requested", "pending"] as const;

/** This constant is the count of the items on one page of a list. GitHub gives 100 items at most. */
export const PAGE_SIZE = 100;

/** This constant is the largest count of the runs that GitHub gives for a list with a status. */
export const RUN_LIST_LIMIT = 1000;

const JOB_STATUSES: readonly string[] = ["queued", "in_progress", "completed"];

/** This function gives the value of a field of an object, or `undefined`. */
const field = (value: unknown, key: string): unknown => (isObject(value) ? value[key] : undefined);

/** This function gives a text with a character, or the empty text. The policy refuses a record with an empty text. */
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** This function shows a status in a sentence. */
const showStatus = (status: unknown): string => (Number.isSafeInteger(status) ? String(status) : "that is not a number");

/**
 * This function gives the path of a repository in the REST API.
 *
 * @param repository - The repository, as `owner/name`
 * @returns The path, as `/repos/owner/name`
 * @throws TypeError when the repository is not a name as `owner/name`
 */
function repositoryPath(repository: string): string {
  const name = isRepositoryName(repository) ? repository.slice(repository.indexOf("/") + 1) : "";
  if (name === "" || name === "." || name === "..") {
    throw new TypeError(`The repository ${show(repository)} is not a name as owner/name.`);
  }
  return `/repos/${repository}`;
}

/** This pattern is the name of an organization of GitHub. */
const ORGANIZATION = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

/**
 * This function gives the scope of the runners of an organization, as the view of a GitHub source names it.
 *
 * @param organization - The name of the organization
 * @returns The scope, as `organization:<name>` with the name in small letters
 */
export function organizationScope(organization: string): string {
  return `organization:${foldName(organization)}`;
}
/** This function sends one request. It stops before the request when the signal is aborted. */
function sendTo<Signal extends StopSignal>(api: GitHubApi<Signal>, request: GitHubRequest, signal: Signal): Promise<GitHubAnswer> {
  if (signal.aborted) return Promise.reject(new Error(`The signal stopped the request ${request.method} ${request.path}.`));
  return api.request(request, signal);
}

/**
 * This function reads each page of a list. It throws when the list changes between its pages, or when the items and the count differ.
 * The text of an error does not have the body of an answer.
 */
async function listAll<Signal extends StopSignal>(
  api: GitHubApi<Signal>,
  path: string,
  query: Readonly<Record<string, string>>,
  key: string,
  signal: Signal,
  limit: number,
): Promise<unknown[]> {
  const items: unknown[] = [];
  let total: number | null = null;
  for (let page = 1; ; page += 1) {
    const answer = await sendTo(api, { method: "GET", path, query: { ...query, per_page: String(PAGE_SIZE), page: String(page) }, body: null }, signal);
    if (answer.status !== 200) throw new Error(`GitHub answered the list ${path} with the status ${showStatus(answer.status)}.`);
    const count = field(answer.body, "total_count");
    const part = field(answer.body, key);
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || !Array.isArray(part)) {
      throw new Error(`The answer to the list ${path} has no count or no field ${key}.`);
    }
    if (total === null) total = count;
    if (count !== total) throw new Error(`The list ${path} changed between its pages.`);
    if (total > limit) throw new Error(`The list ${path} has ${total} items, and GitHub gives ${limit} at most.`);
    items.push(...(part as unknown[]));
    if (items.length >= total) break;
    if (part.length === 0) throw new Error(`The list ${path} ended before its count of ${total} items.`);
  }
  if (items.length !== total) throw new Error(`The list ${path} has ${items.length} items, and its count is ${total}.`);
  return items;
}

/** This record is a run of a list, with its status. */
interface ListedRun {
  readonly record: RunRecord;
  readonly status: string;
}

/**
 * This function reads one run of an answer of GitHub.
 * A field of the policy that the answer does not give is the empty text, and the policy refuses such a record.
 *
 * @param value - The run, as GitHub gives it
 * @param repository - The repository of the request
 * @returns The record of the run and its status
 * @throws Error when the run has no id, no number of its try, or a different repository
 */
function readRun(value: unknown, repository: string): ListedRun {
  const runId = field(value, "id");
  const runAttempt = field(value, "run_attempt");
  const name = field(field(value, "repository"), "full_name");
  if (!isId(runId) || !isId(runAttempt)) {
    throw new Error(`A run of the repository ${show(repository)} has no id or no number of its try.`);
  }
  if (typeof name !== "string") throw new Error(`The run ${runId} has no repository.`);
  if (!sameName(name, repository)) {
    throw new Error(`The run ${runId} is a run of the repository ${show(name)}, not of the repository ${show(repository)}.`);
  }
  const head = field(field(value, "head_repository"), "full_name");
  return {
    record: {
      repository: name,
      runId,
      runAttempt,
      event: text(field(value, "event")),
      headRepository: typeof head === "string" ? head : null,
      actor: text(field(field(value, "actor"), "login")),
      triggeringActor: text(field(field(value, "triggering_actor"), "login")),
    },
    status: text(field(value, "status")),
  };
}

/**
 * This function reads one job of an answer of GitHub.
 *
 * @param value - The job, as GitHub gives it
 * @param run - The run of the request
 * @returns The job, or `null` for a job that does not wait for a runner yet
 * @throws Error when the job has a bad shape, a different run or a status that the source does not know
 */
function readJob(value: unknown, run: RunRecord): SourceJob | null {
  const jobId = field(value, "id");
  const status = field(value, "status");
  const labels = field(value, "labels");
  const runner = field(value, "runner_name");
  if (!isId(jobId)) throw new Error(`A job of the run ${run.runId} has no id.`);
  if (field(value, "run_id") !== run.runId || field(value, "run_attempt") !== run.runAttempt) {
    throw new Error(`The job ${jobId} is not a job of the run ${run.runId}, try ${run.runAttempt}.`);
  }
  if ((HELD_JOB_STATUSES as readonly unknown[]).includes(status)) return null;
  if (typeof status !== "string" || !JOB_STATUSES.includes(status)) {
    throw new Error(`The job ${jobId} has the status ${show(status)}, and the source does not know this status.`);
  }
  if (!Array.isArray(labels) || !labels.every((label) => typeof label === "string")) {
    throw new Error(`The labels of the job ${jobId} are not a list of texts.`);
  }
  if (runner !== null && runner !== undefined && typeof runner !== "string") {
    throw new Error(`The runner of the job ${jobId} is not a text.`);
  }
  return {
    repository: run.repository,
    jobId,
    runId: run.runId,
    runAttempt: run.runAttempt,
    labels: [...(labels as string[])],
    status: status as JobStatus,
    runner: typeof runner === "string" && runner.length > 0 ? runner : null,
  };
}

/**
 * This function reads one runner registration of an answer of GitHub.
 *
 * @param value - The runner, as GitHub gives it
 * @returns The runner registration
 * @throws Error when the runner has a bad shape
 */
function readRunner(value: unknown): SourceRunner {
  const runnerId = field(value, "id");
  const name = field(value, "name");
  const busy = field(value, "busy");
  if (!isId(runnerId) || typeof name !== "string" || name.length === 0 || typeof busy !== "boolean") {
    throw new Error("A runner of the answer has no id, no name or no busy field.");
  }
  return { runnerId, name, online: field(value, "status") === "online", busy };
}

/**
 * This function makes a source of jobs on the REST API of GitHub, for runners that register on a repository or on an organization.
 * Its view uses one list of runs for each open status and a request for each named run that is not in the lists.
 * It then reads the jobs of each open run and the runners of the scope.
 * With an organization, each view lists the runners of the organization, and it has the scope `organizationScope(organization)`.
 *
 * @param options - The client of the REST API, the runner group and the organization
 * @returns The source
 * @throws RangeError when the runner group is not a whole number from 1, or the organization is not a name of GitHub
 */
export function createGitHubSource<Signal extends StopSignal = StopSignal>(options: GitHubSourceOptions<Signal>): JobSource<Signal> {
  const { api, organization } = options;
  const runnerGroup = options.runnerGroup ?? 1;
  if (!isId(runnerGroup)) throw new RangeError("The runner group of a GitHub source is not a whole number from 1.");
  if (organization !== undefined && (typeof organization !== "string" || !ORGANIZATION.test(organization))) {
    throw new RangeError(`The organization ${show(organization)} of a GitHub source is not a name of GitHub.`);
  }

  /**
   * This function gives the path of the runners of a repository: the path of the repository, or the path of the organization.
   * It throws when the repository is not a repository of the organization.
   */
  const runnersPath = (repository: string): string => {
    const base = repositoryPath(repository);
    if (organization === undefined) return `${base}/actions/runners`;
    if (!sameName(repository.slice(0, repository.indexOf("/")), organization)) {
      throw new RangeError(`The repository ${show(repository)} is not a repository of the organization ${show(organization)}.`);
    }
    return `/orgs/${organization}/actions/runners`;
  };

  const send = (request: GitHubRequest, signal: Signal): Promise<GitHubAnswer> => sendTo(api, request, signal);
  const list = (path: string, query: Readonly<Record<string, string>>, key: string, signal: Signal, limit: number): Promise<unknown[]> =>
    listAll(api, path, query, key, signal, limit);

  return {
    async view(repository: string, runs: readonly RunKey[], signal: Signal): Promise<RepositoryView> {
      const base = repositoryPath(repository);
      const runnersAt = runnersPath(repository);
      const open = new Map<number, RunRecord>();
      const keep = (listed: ListedRun): void => {
        if (listed.status === "completed") return;
        const known = open.get(listed.record.runId);
        if (known === undefined || known.runAttempt < listed.record.runAttempt) open.set(listed.record.runId, listed.record);
      };
      for (const status of OPEN_RUN_STATUSES) {
        const items = await list(`${base}/actions/runs`, { status }, "workflow_runs", signal, RUN_LIST_LIMIT);
        for (const item of items) keep(readRun(item, repository));
      }
      for (const named of runs) {
        if (!sameName(named.repository, repository) || !isId(named.runId) || open.has(named.runId)) continue;
        const answer = await send({ method: "GET", path: `${base}/actions/runs/${named.runId}`, query: {}, body: null }, signal);
        if (answer.status === 404) continue;
        if (answer.status !== 200) {
          throw new Error(`GitHub answered the request for the run ${named.runId} with the status ${showStatus(answer.status)}.`);
        }
        const found = readRun(answer.body, repository);
        if (found.record.runId !== named.runId) throw new Error(`GitHub answered the request for the run ${named.runId} with a different run.`);
        keep(found);
      }
      const sourceRuns: SourceRun[] = [];
      for (const run of open.values()) {
        const path = `${base}/actions/runs/${run.runId}/attempts/${run.runAttempt}/jobs`;
        const items = await list(path, {}, "jobs", signal, Number.MAX_SAFE_INTEGER);
        const jobs = items.map((item) => readJob(item, run)).filter((job): job is SourceJob => job !== null);
        sourceRuns.push({ run, jobs });
      }
      const runners = (await list(runnersAt, {}, "runners", signal, Number.MAX_SAFE_INTEGER)).map(readRunner);
      return organization === undefined ? { runs: sourceRuns, runners } : { runs: sourceRuns, runners, scope: organizationScope(organization) };
    },

    async register(request: RunnerRequest, signal: Signal): Promise<RunnerRegistration> {
      const runnersAt = runnersPath(request.repository);
      const { name, labels } = request;
      if (typeof name !== "string" || name.length === 0) throw new TypeError("The name of a runner is not a text with a character.");
      if (!Array.isArray(labels) || labels.length === 0 || !labels.every((label) => typeof label === "string" && label.length > 0)) {
        throw new TypeError(`The labels of the runner ${show(name)} are not a list of texts.`);
      }
      const answer = await send(
        { method: "POST", path: `${runnersAt}/generate-jitconfig`, query: {}, body: { name, runner_group_id: runnerGroup, labels: [...labels] } },
        signal,
      );
      // The body of a refusal can have the configuration or a name from outside. The text of the error does not have it.
      if (answer.status !== 201) {
        throw new Error(`GitHub answered the request for the runner ${show(name)} with the status ${showStatus(answer.status)}.`);
      }
      const runner = field(answer.body, "runner");
      const runnerId = field(runner, "id");
      const configuration = field(answer.body, "encoded_jit_config");
      if (!isId(runnerId) || typeof configuration !== "string" || configuration.length === 0) {
        throw new Error(`The answer to the request for the runner ${show(name)} has no runner id or no configuration.`);
      }
      if (field(runner, "name") !== name) throw new Error(`GitHub registered the runner ${runnerId} with a name that is not ${show(name)}.`);
      return { runnerId, configuration };
    },

    async remove(repository: string, runnerId: number, signal: Signal): Promise<void> {
      const runnersAt = runnersPath(repository);
      if (!isId(runnerId)) throw new RangeError("The id of a runner is not a whole number from 1.");
      const answer = await send({ method: "DELETE", path: `${runnersAt}/${runnerId}`, query: {}, body: null }, signal);
      if (answer.status !== 204 && answer.status !== 404) {
        throw new Error(`GitHub answered the request to remove the runner ${runnerId} with the status ${showStatus(answer.status)}.`);
      }
    },
  };
}

/** This record has the facts of a runner group of an organization, as GitHub gives them. */
export interface RunnerGroupFacts {
  /** This field is the runner group. */
  readonly group: unknown;
  /** This list has each repository that the group names. It is `null` when the group does not name its repositories. */
  readonly repositories: readonly unknown[] | null;
}

/** This record has the rules of the check of a runner group. */
export interface RunnerGroupRules {
  /** This list has each served repository, as `owner/name`. */
  readonly served: readonly string[];
  /** This field is `true` when the group can admit a public repository. The default is `false`. */
  readonly publicRepositories?: boolean;
}

/** This record is the result of the check of a runner group. */
export interface RunnerGroupCheck {
  /** This field is `true` when the check found no problem. */
  readonly pass: boolean;
  /** This list has one sentence for each problem. */
  readonly problems: readonly string[];
}

/**
 * This function decides if the runners of a group serve only the served repositories. It has no effect.
 * A runner of an organization can take a job of each repository that its group admits. Thus the group must admit each served repository and no other repository.
 *
 * - The group must name its repositories: the visibility `selected`.
 * - The group must admit no public repository, unless the rules permit it.
 * - Each named repository must be a served repository, and each served repository must be a named repository that the group admits.
 *
 * @param facts - The group and its repositories, as GitHub gives them
 * @param rules - The served repositories, and the permission for a public repository
 * @returns The result, with each problem
 */
export function judgeRunnerGroup(facts: RunnerGroupFacts, rules: RunnerGroupRules): RunnerGroupCheck {
  const problems: string[] = [];
  const allowsPublic = field(facts.group, "allows_public_repositories");
  const visibility = field(facts.group, "visibility");
  const publicPermitted = rules.publicRepositories === true;
  if (typeof allowsPublic !== "boolean") problems.push("The group has no field allows_public_repositories.");
  else if (allowsPublic && !publicPermitted) problems.push("The group admits public repositories.");
  if (visibility === "all") problems.push("The group admits each repository of the organization.");
  else if (visibility === "private") problems.push("The group admits each private repository of the organization.");
  else if (typeof visibility !== "string") problems.push("The group has no visibility.");
  else if (visibility !== "selected") problems.push(`The group has the visibility ${show(visibility)}, and the check does not know it.`);
  else if (facts.repositories === null) problems.push("The group names its repositories, and the check has no list of them.");
  else {
    const named: { readonly name: string; readonly open: boolean }[] = [];
    for (const each of facts.repositories) {
      const name = field(each, "full_name");
      const closed = field(each, "private");
      if (!isRepositoryName(name) || typeof closed !== "boolean") problems.push("A repository of the group has no name or no field private.");
      else named.push({ name, open: !closed });
    }
    for (const each of named) {
      if (!rules.served.some((served) => sameName(served, each.name))) {
        problems.push(`The group admits the repository ${show(each.name)}, and the dispatcher does not serve it.`);
      } else if (each.open && allowsPublic !== true) {
        problems.push(`The served repository ${show(each.name)} is public, and the group admits no public repository.`);
      }
    }
    for (const served of rules.served) {
      if (!named.some((each) => sameName(each.name, served))) problems.push(`The group does not name the served repository ${show(served)}.`);
    }
  }
  return { pass: problems.length === 0, problems };
}

/**
 * This function reads a runner group of an organization and its repositories, and it checks them with `judgeRunnerGroup`.
 * The program of the service uses it before its first pass. The credential needs the permission to read the runners of the organization.
 *
 * @param api - The client of the REST API
 * @param organization - The name of the organization
 * @param runnerGroup - The id of the runner group
 * @param rules - The served repositories, and the permission for a public repository
 * @param signal - The signal that stops the requests
 * @returns The result, with each problem
 * @throws RangeError when the organization or the group is not valid
 * @throws Error when GitHub does not give the group or its list. The text of the error does not have the body of an answer.
 */
export async function checkRunnerGroup<Signal extends StopSignal = StopSignal>(
  api: GitHubApi<Signal>,
  organization: string,
  runnerGroup: number,
  rules: RunnerGroupRules,
  signal: Signal,
): Promise<RunnerGroupCheck> {
  if (typeof organization !== "string" || !ORGANIZATION.test(organization)) {
    throw new RangeError(`The organization ${show(organization)} is not a name of GitHub.`);
  }
  if (!isId(runnerGroup)) throw new RangeError("The runner group is not a whole number from 1.");
  const path = `/orgs/${organization}/actions/runner-groups/${runnerGroup}`;
  const answer = await sendTo(api, { method: "GET", path, query: {}, body: null }, signal);
  if (answer.status !== 200) throw new Error(`GitHub answered the request for the runner group ${runnerGroup} with the status ${showStatus(answer.status)}.`);
  if (field(answer.body, "id") !== runnerGroup) throw new Error(`GitHub answered the request for the runner group ${runnerGroup} with a different group.`);
  const repositories =
    field(answer.body, "visibility") === "selected" ? await listAll(api, `${path}/repositories`, {}, "repositories", signal, Number.MAX_SAFE_INTEGER) : null;
  return judgeRunnerGroup({ group: answer.body, repositories }, rules);
}
