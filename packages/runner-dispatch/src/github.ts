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
import { isId, sameName, type RunKey, type RunRecord } from "./records.ts";

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
  /** This field is the id of the runner group of each new runner. The default group of a repository has the id 1. */
  readonly runnerGroup?: number;
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
 * This function makes a source of jobs on the REST API of GitHub, for runners that register on a repository.
 * Its view uses one list of runs for each open status and a request for each named run that is not in the lists.
 * It then reads the jobs of each open run and the runners.
 *
 * @param options - The client of the REST API and the runner group
 * @returns The source
 * @throws RangeError when the runner group is not a whole number from 1
 */
export function createGitHubSource<Signal extends StopSignal = StopSignal>(options: GitHubSourceOptions<Signal>): JobSource<Signal> {
  const { api } = options;
  const runnerGroup = options.runnerGroup ?? 1;
  if (!isId(runnerGroup)) throw new RangeError("The runner group of a GitHub source is not a whole number from 1.");

  /** This function sends one request. It stops before the request when the signal is aborted. */
  const send = (request: GitHubRequest, signal: Signal): Promise<GitHubAnswer> => {
    if (signal.aborted) return Promise.reject(new Error(`The signal stopped the request ${request.method} ${request.path}.`));
    return api.request(request, signal);
  };

  /**
   * This function reads each page of a list. It throws when the list changes between its pages, or when the items and the count differ.
   * The text of an error does not have the body of an answer.
   */
  const list = async (
    path: string,
    query: Readonly<Record<string, string>>,
    key: string,
    signal: Signal,
    limit: number,
  ): Promise<unknown[]> => {
    const items: unknown[] = [];
    let total: number | null = null;
    for (let page = 1; ; page += 1) {
      const answer = await send({ method: "GET", path, query: { ...query, per_page: String(PAGE_SIZE), page: String(page) }, body: null }, signal);
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
  };

  return {
    async view(repository: string, runs: readonly RunKey[], signal: Signal): Promise<RepositoryView> {
      const base = repositoryPath(repository);
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
      const runners = (await list(`${base}/actions/runners`, {}, "runners", signal, Number.MAX_SAFE_INTEGER)).map(readRunner);
      return { runs: sourceRuns, runners };
    },

    async register(request: RunnerRequest, signal: Signal): Promise<RunnerRegistration> {
      const base = repositoryPath(request.repository);
      const { name, labels } = request;
      if (typeof name !== "string" || name.length === 0) throw new TypeError("The name of a runner is not a text with a character.");
      if (!Array.isArray(labels) || labels.length === 0 || !labels.every((label) => typeof label === "string" && label.length > 0)) {
        throw new TypeError(`The labels of the runner ${show(name)} are not a list of texts.`);
      }
      const answer = await send(
        { method: "POST", path: `${base}/actions/runners/generate-jitconfig`, query: {}, body: { name, runner_group_id: runnerGroup, labels: [...labels] } },
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
      const base = repositoryPath(repository);
      if (!isId(runnerId)) throw new RangeError("The id of a runner is not a whole number from 1.");
      const answer = await send({ method: "DELETE", path: `${base}/actions/runners/${runnerId}`, query: {}, body: null }, signal);
      if (answer.status !== 204 && answer.status !== 404) {
        throw new Error(`GitHub answered the request to remove the runner ${runnerId} with the status ${showStatus(answer.status)}.`);
      }
    },
  };
}
