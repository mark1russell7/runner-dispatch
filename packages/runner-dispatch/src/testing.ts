import { checkJob, type CheckRefusal, type CheckSettings, type JobEnvironment } from "./check.ts";
import { organizationScope, PAGE_SIZE, RUN_LIST_LIMIT, type GitHubAnswer, type GitHubApi, type GitHubRequest } from "./github.ts";
import { isObject } from "./policy.ts";
import type {
  JobSource,
  JobStatus,
  MachineProvider,
  MachineRequest,
  MachineStatus,
  ProviderMachine,
  RepositoryView,
  RunnerRegistration,
  RunnerRequest,
  SourceJob,
  SourceRunner,
  StopSignal,
} from "./ports.ts";
import { isId, sameName, sameRun, type MachineRecord, type RunKey, type RunRecord } from "./records.ts";

/** This type is the clock of a fake world. The clocks of `@mark1russell7/algebra/clock` have this shape. */
export interface WorldClock {
  /** This method gives the time, in milliseconds. */
  now(): number;
  /** This method starts `run` after `ms` milliseconds. */
  after(ms: number, run: () => void): unknown;
}

/** This record has the times of a fake world, each in milliseconds. */
export interface WorldTimes {
  /** This field is the time from the request for a machine to the time that it operates. */
  readonly boot: number;
  /** This field is the time from the start of a machine to the connection of its runner. */
  readonly connect: number;
  /** This field is the time from the request to destroy a machine to the time that it is not there. */
  readonly destroy: number;
}

/** This type names a request to a fake world. */
export type WorldRequest = "view" | "register" | "remove" | "machines" | "make" | "destroy";

/**
 * This type is a fault of one request. The request throws for each fault.
 * `refuse` tells that the request has no effect. `lose` tells that the request has its effect, and the answer is lost.
 */
export type WorldFault = "refuse" | "lose";

/** This record has the options of a fake world. */
export interface FakeWorldOptions {
  /** This field is the clock of the world. */
  readonly clock: WorldClock;
  /** This field has the times of the world. */
  readonly times: WorldTimes;
  /** This function gives the fault of a request, or `null`. The target is a repository, or the name of a runner or of a machine. */
  readonly faults?: (request: WorldRequest, target: string) => WorldFault | null;
  /**
   * This list has each organization of the world. The source registers the runners of a repository of an organization on the organization.
   * It registers each other runner on its repository. The default is no organization.
   */
  readonly organizations?: readonly string[];
}

/** This record is a job that a test adds to a run. */
export interface WorldJobInput {
  /** This list has the labels that the job asks for. It has one label at least. */
  readonly labels: readonly string[];
  /** This field is the time that the steps of the job take, in milliseconds. */
  readonly duration: number;
}

/**
 * This type is the end of a job in a fake world:
 *
 * - `success`: the steps of the job ended.
 * - `refused`: the check on the machine refused the job, and no step started.
 * - `lost`: the machine of the job stopped or was destroyed.
 * - `cancelled`: the test cancelled the run of the job.
 */
export type WorldJobResult = "success" | "refused" | "lost" | "cancelled";

/** This record is one job of a fake world. */
export interface WorldJob extends SourceJob {
  /** This field is `true` when a step of the job started. */
  readonly ran: boolean;
  /** This field is the end of the job. It is `null` for a job that is not completed. */
  readonly result: WorldJobResult | null;
  /** This list has each rule of the check on the machine that refused the job. */
  readonly refusals: readonly CheckRefusal[];
}

/** This record is one run of a fake world, with its jobs. */
export interface WorldRun {
  /** This field is the record of the run. */
  readonly run: RunRecord;
  /** This list has each job of the run. */
  readonly jobs: readonly WorldJob[];
}

/** This record is one runner registration of a fake world. */
export interface WorldRunner extends SourceRunner {
  /** This field is the scope of the registration: a repository as `owner/name`, or an organization. */
  readonly scope: string;
  /** This list has the labels of the runner. */
  readonly labels: readonly string[];
}

/** This record is the store of the runner registrations of a fake world, by scope. The faults of the world apply to each request. */
export interface WorldRegistry {
  /** This method makes a registration in a scope. It throws when the scope has a runner with the name. */
  register(scope: string, name: string, labels: readonly string[], signal: StopSignal): Promise<RunnerRegistration>;
  /** This method removes a registration of a scope. It succeeds when the registration is not there, and it throws for a runner with a job. */
  remove(scope: string, runnerId: number, signal: StopSignal): Promise<void>;
}

/** This record is one event of a fake world, for the report of a test. */
export interface WorldEvent {
  /** This field is the time of the event, in milliseconds. */
  readonly at: number;
  /** This field names the event. */
  readonly kind:
    | "registered"
    | "removed"
    | "asked"
    | "operating"
    | "online"
    | "job-started"
    | "job-refused"
    | "job-ended"
    | "job-lost"
    | "destroy-asked"
    | "halted"
    | "gone";
  /** This field is the name of the machine or of the runner. */
  readonly name: string;
  /** This field is the id of the job of the event, or `null`. */
  readonly jobId: number | null;
}

/**
 * This type is a fake world for the tests of a dispatcher: a source of jobs and a provider of machines on one clock.
 * It does what GitHub and a hypervisor do, in the parts that a dispatcher reads:
 *
 * - A machine operates after the time `boot`. Its runner connects after the time `connect`, when its registration is there.
 * - A connected runner with no job takes a queued job of a repository of its scope when it has each label of the job.
 *   The scope of a registration is its repository, or an organization of the world. An organization admits each of its repositories.
 * - At the start of a job, the machine does the check `checkJob` with its settings. A refused job ends, and no step starts.
 * - A runner does one job. The source removes its registration at the end of the job.
 * - A machine is not there after the time `destroy` from the request. Until then, it works.
 * - A job fails when its machine stops or is not there. The registration of its runner stays.
 */
export interface FakeWorld {
  /** This field is the source of the jobs. */
  readonly source: JobSource;
  /** This field is the provider of the machines. */
  readonly provider: MachineProvider;
  /** This method adds a run with its jobs. It gives the id of each job. */
  addRun(run: RunRecord, jobs: readonly WorldJobInput[]): readonly number[];
  /** This method cancels a run: each job that is not completed ends with no more steps. */
  cancelRun(run: RunKey): void;
  /** This method removes a machine at once, as a hypervisor that loses it. */
  lose(name: string): void;
  /** This method stops a machine. The machine stays in the list of the provider. */
  halt(name: string): void;
  /** This method gives each machine of the provider. */
  machines(): readonly ProviderMachine[];
  /** This method gives each runner registration. */
  runners(): readonly WorldRunner[];
  /** This method gives the scope where the source registers the runners of a repository: the repository, or its organization. */
  scopeOf(repository: string): string;
  /** This method gives each organization of the world. */
  organizations(): readonly string[];
  /** This field is the store of the registrations by scope. A fake REST API uses it. */
  readonly registry: WorldRegistry;
  /** This method gives each run with its jobs, also a completed run. */
  runs(): readonly WorldRun[];
  /** This method gives each job, also the completed jobs. */
  jobs(): readonly WorldJob[];
  /** This method gives the largest count of machines at one time. */
  peak(): number;
  /** This method gives each one-job configuration that the source gave. */
  secrets(): readonly string[];
  /** This method gives each event, in its sequence. */
  events(): readonly WorldEvent[];
}

interface JobState {
  readonly repository: string;
  readonly jobId: number;
  readonly runId: number;
  readonly runAttempt: number;
  readonly labels: readonly string[];
  readonly duration: number;
  status: JobStatus;
  runner: string | null;
  ran: boolean;
  result: WorldJobResult | null;
  refusals: readonly CheckRefusal[];
}

interface RunState {
  readonly run: RunRecord;
  readonly jobs: JobState[];
}

interface RunnerState {
  readonly runnerId: number;
  readonly name: string;
  readonly scope: string;
  readonly labels: readonly string[];
  readonly configuration: string;
  online: boolean;
  job: JobState | null;
}

interface MachineState {
  readonly machine: MachineRecord;
  readonly configuration: string;
  readonly check: CheckSettings;
  status: MachineStatus;
  ending: boolean;
}

/** This function gives the variables that the runner program gives to the check, from the record of a run. */
const environmentOf = (run: RunRecord): JobEnvironment => ({
  GITHUB_REPOSITORY: run.repository,
  GITHUB_RUN_ID: String(run.runId),
  GITHUB_RUN_ATTEMPT: String(run.runAttempt),
  GITHUB_EVENT_NAME: run.event,
  GITHUB_ACTOR: run.actor,
  GITHUB_TRIGGERING_ACTOR: run.triggeringActor,
});

/** This function gives the document of the event file of a job, from the record of its run. */
const eventOf = (run: RunRecord): unknown => {
  const repository = { full_name: run.repository };
  if (!run.event.startsWith("pull_request")) return { repository };
  return { repository, pull_request: { head: { repo: run.headRepository === null ? null : { full_name: run.headRepository } } } };
};

const jobOf = (job: JobState): WorldJob => ({
  repository: job.repository,
  jobId: job.jobId,
  runId: job.runId,
  runAttempt: job.runAttempt,
  labels: [...job.labels],
  status: job.status,
  runner: job.runner,
  ran: job.ran,
  result: job.result,
  refusals: job.refusals,
});

/**
 * This function makes a fake world.
 *
 * @param options - The clock, the times and the faults
 * @returns The world, with no run, no runner and no machine
 * @throws RangeError when a time is not a number from 0
 */
export function fakeWorld(options: FakeWorldOptions): FakeWorld {
  const { clock, times } = options;
  for (const key of ["boot", "connect", "destroy"] as const) {
    if (!Number.isFinite(times[key]) || times[key] < 0) throw new RangeError(`The time ${key} of a fake world is not a number from 0.`);
  }
  const runs: RunState[] = [];
  const runners: RunnerState[] = [];
  const machines = new Map<string, MachineState>();
  const events: WorldEvent[] = [];
  const secrets: string[] = [];
  let ids = 0;
  let peak = 0;

  const note = (kind: WorldEvent["kind"], name: string, jobId: number | null = null): void => {
    events.push({ at: clock.now(), kind, name, jobId });
  };
  /** This function does the start of a request: it stops for an aborted signal and for the fault `refuse`. */
  const begin = (request: WorldRequest, target: string, signal: StopSignal): WorldFault | null => {
    if (signal.aborted) throw new Error(`The signal stopped the request ${request}.`);
    const fault = options.faults?.(request, target) ?? null;
    if (fault === "refuse") throw new Error(`The fake world refused the request ${request}.`);
    return fault;
  };
  const end = (request: WorldRequest, fault: WorldFault | null): void => {
    if (fault === "lose") throw new Error(`The fake world lost the answer of the request ${request}.`);
  };
  const unregister = (runner: RunnerState): void => {
    const index = runners.indexOf(runner);
    if (index >= 0) runners.splice(index, 1);
  };
  const organizations = [...(options.organizations ?? [])];
  /** This function gives the organization of a repository, or `null` when its owner is not an organization of the world. */
  const organizationOf = (repository: string): string | null => {
    const owner = repository.slice(0, Math.max(repository.indexOf("/"), 0));
    return organizations.find((each) => sameName(each, owner)) ?? null;
  };
  const scopeOf = (repository: string): string => organizationOf(repository) ?? repository;
  /** This function tells if a runner of a scope can take a job of a repository. */
  const admits = (scope: string, repository: string): boolean => sameName(scope, repository) || sameName(scope, organizationOf(repository));

  const finish = (runner: RunnerState, job: JobState, result: WorldJobResult): void => {
    job.status = "completed";
    job.result = result;
    runner.job = null;
    note(result === "lost" ? "job-lost" : result === "refused" ? "job-refused" : "job-ended", runner.name, job.jobId);
  };
  const start = (runner: RunnerState, job: JobState, run: RunRecord, check: CheckSettings): void => {
    job.status = "in_progress";
    job.runner = runner.name;
    runner.job = job;
    const answer = checkJob(check, environmentOf(run), eventOf(run));
    job.refusals = answer.refusals;
    if (!answer.pass) {
      finish(runner, job, "refused");
      unregister(runner);
      return;
    }
    job.ran = true;
    note("job-started", runner.name, job.jobId);
    clock.after(job.duration, () => {
      if (runner.job !== job || job.status !== "in_progress") return;
      finish(runner, job, "success");
      unregister(runner);
    });
  };
  /** This function gives each connected runner with no job the first queued job that it can take. */
  const settle = (): void => {
    for (const runner of [...runners]) {
      if (!runner.online || runner.job !== null) continue;
      const machine = machines.get(runner.name);
      if (machine === undefined) continue;
      for (const run of runs) {
        if (!admits(runner.scope, run.run.repository)) continue;
        const job = run.jobs.find((each) => each.status === "queued" && each.labels.every((label) => runner.labels.includes(label)));
        if (job === undefined) continue;
        start(runner, job, run.run, machine.check);
        break;
      }
    }
  };
  /** This function does what the end of a machine does to its runner: the runner is not connected, and its job fails. */
  const disconnect = (name: string): void => {
    const runner = runners.find((each) => each.name === name);
    if (runner === undefined) return;
    runner.online = false;
    if (runner.job !== null) finish(runner, runner.job, "lost");
  };
  const gone = (name: string): void => {
    if (!machines.delete(name)) return;
    note("gone", name);
    disconnect(name);
  };

  const registry: WorldRegistry = {
    register(scope: string, name: string, labels: readonly string[], signal: StopSignal): Promise<RunnerRegistration> {
      try {
        const fault = begin("register", name, signal);
        if (runners.some((runner) => runner.name === name && sameName(runner.scope, scope))) {
          throw new Error("The scope has a runner with this name.");
        }
        ids += 1;
        const configuration = `one-job-configuration-${ids}-${name}`;
        secrets.push(configuration);
        runners.push({ runnerId: ids, name, scope, labels: [...labels], configuration, online: false, job: null });
        note("registered", name);
        end("register", fault);
        return Promise.resolve({ runnerId: ids, configuration });
      } catch (error) {
        return Promise.reject(error as Error);
      }
    },
    remove(scope: string, runnerId: number, signal: StopSignal): Promise<void> {
      try {
        const runner = runners.find((each) => each.runnerId === runnerId && sameName(each.scope, scope));
        const fault = begin("remove", runner?.name ?? String(runnerId), signal);
        if (runner !== undefined) {
          if (runner.job !== null) throw new Error("The runner has a job. The source does not remove it.");
          unregister(runner);
          note("removed", runner.name);
        }
        end("remove", fault);
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error as Error);
      }
    },
  };

  const source: JobSource = {
    view(repository: string, _runs: readonly RunKey[], signal: StopSignal): Promise<RepositoryView> {
      try {
        end("view", begin("view", repository, signal));
      } catch (error) {
        return Promise.reject(error as Error);
      }
      const scope = scopeOf(repository);
      const organization = organizationOf(repository);
      return Promise.resolve({
        runs: runs
          .filter((run) => sameName(run.run.repository, repository) && run.jobs.some((job) => job.status !== "completed"))
          .map((run) => ({
            run: { ...run.run },
            jobs: run.jobs.map(
              (job): SourceJob => ({
                repository: job.repository,
                jobId: job.jobId,
                runId: job.runId,
                runAttempt: job.runAttempt,
                labels: [...job.labels],
                status: job.status,
                runner: job.runner,
              }),
            ),
          })),
        runners: runners
          .filter((runner) => sameName(runner.scope, scope))
          .map((runner): SourceRunner => ({ runnerId: runner.runnerId, name: runner.name, online: runner.online, busy: runner.job !== null })),
        ...(organization === null ? {} : { scope: organizationScope(organization) }),
      });
    },
    register: (request: RunnerRequest, signal: StopSignal): Promise<RunnerRegistration> =>
      registry.register(scopeOf(request.repository), request.name, request.labels, signal),
    remove: (repository: string, runnerId: number, signal: StopSignal): Promise<void> => registry.remove(scopeOf(repository), runnerId, signal),
  };

  const provider: MachineProvider = {
    make(request: MachineRequest, signal: StopSignal): Promise<void> {
      try {
        const { name } = request.machine;
        const fault = begin("make", name, signal);
        if (machines.has(name)) throw new Error("The provider has a machine with this name.");
        const made: MachineState = {
          machine: { ...request.machine },
          configuration: request.configuration,
          check: request.check,
          status: "making",
          ending: false,
        };
        machines.set(name, made);
        peak = Math.max(peak, machines.size);
        note("asked", name);
        clock.after(times.boot, () => {
          if (machines.get(name) !== made || made.status !== "making") return;
          made.status = "operating";
          note("operating", name);
          clock.after(times.connect, () => {
            if (machines.get(name) !== made || made.status !== "operating") return;
            const runner = runners.find((each) => each.configuration === made.configuration);
            if (runner === undefined) return;
            runner.online = true;
            note("online", name);
            settle();
          });
        });
        end("make", fault);
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error as Error);
      }
    },
    machines(signal: StopSignal): Promise<readonly ProviderMachine[]> {
      try {
        end("machines", begin("machines", "", signal));
      } catch (error) {
        return Promise.reject(error as Error);
      }
      return Promise.resolve([...machines.values()].map((each) => ({ machine: { ...each.machine }, status: each.status })));
    },
    destroy(name: string, signal: StopSignal): Promise<void> {
      try {
        const fault = begin("destroy", name, signal);
        const machine = machines.get(name);
        if (machine !== undefined && !machine.ending) {
          machine.ending = true;
          note("destroy-asked", name);
          clock.after(times.destroy, () => {
            if (machines.get(name) === machine) gone(name);
          });
        }
        end("destroy", fault);
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error as Error);
      }
    },
  };

  return {
    source,
    provider,
    addRun(run: RunRecord, jobs: readonly WorldJobInput[]): readonly number[] {
      if (!isId(run.runId) || !isId(run.runAttempt)) throw new RangeError("A run of a fake world needs an id and the number of its try.");
      if (runs.some((each) => sameRun(each.run, run))) throw new RangeError("The fake world has this run.");
      const made = jobs.map((job): JobState => {
        if (job.labels.length === 0) throw new RangeError("A job of a fake world needs a label.");
        if (!Number.isFinite(job.duration) || job.duration < 0) throw new RangeError("The duration of a job is a number from 0.");
        ids += 1;
        return {
          repository: run.repository,
          jobId: ids,
          runId: run.runId,
          runAttempt: run.runAttempt,
          labels: [...job.labels],
          duration: job.duration,
          status: "queued",
          runner: null,
          ran: false,
          result: null,
          refusals: [],
        };
      });
      runs.push({ run: { ...run }, jobs: made });
      settle();
      return made.map((job) => job.jobId);
    },
    cancelRun(run: RunKey): void {
      for (const job of runs.find((each) => sameRun(each.run, run))?.jobs ?? []) {
        if (job.status === "completed") continue;
        const runner = runners.find((each) => each.job === job);
        job.status = "completed";
        job.result = "cancelled";
        if (runner === undefined) continue;
        runner.job = null;
        unregister(runner);
        note("job-ended", runner.name, job.jobId);
      }
    },
    lose(name: string): void {
      gone(name);
    },
    halt(name: string): void {
      const machine = machines.get(name);
      if (machine === undefined || machine.status === "stopped") return;
      machine.status = "stopped";
      note("halted", name);
      disconnect(name);
    },
    machines: (): readonly ProviderMachine[] => [...machines.values()].map((each) => ({ machine: { ...each.machine }, status: each.status })),
    runners: (): readonly WorldRunner[] =>
      runners.map((runner) => ({
        runnerId: runner.runnerId,
        name: runner.name,
        scope: runner.scope,
        labels: [...runner.labels],
        online: runner.online,
        busy: runner.job !== null,
      })),
    scopeOf,
    organizations: (): readonly string[] => [...organizations],
    registry,
    runs: (): readonly WorldRun[] => runs.map((run) => ({ run: { ...run.run }, jobs: run.jobs.map(jobOf) })),
    jobs: (): readonly WorldJob[] => runs.flatMap((run) => run.jobs.map(jobOf)),
    peak: (): number => peak,
    secrets: (): readonly string[] => [...secrets],
    events: (): readonly WorldEvent[] => [...events],
  };
}

/**
 * This function makes a suffix function for a test. Each use gives the next number, as 8 digits of base 16.
 *
 * @param first - The first number
 * @returns The suffix function
 */
export function countingSuffix(first = 0): () => string {
  let next = first;
  return (): string => {
    const text = (next % 0x1_0000_0000).toString(16).padStart(8, "0");
    next += 1;
    return text;
  };
}

/** This record has the options of a fake REST API of GitHub. */
export interface FakeGitHubOptions {
  /** This field is the largest count of the items on one page. A small count tests the pages of a list. The default is 100. */
  readonly pageSize?: number;
  /** This function gives an answer in place of the world, or `null`. A test uses it for a fault. */
  readonly answer?: (request: GitHubRequest) => GitHubAnswer | null;
}

/** This record is a fake REST API of GitHub on a fake world. */
export interface FakeGitHub {
  /** This field is the client of the API. */
  readonly api: GitHubApi;
  /** This method gives each request, in its sequence. */
  requests(): readonly GitHubRequest[];
}

/** This function gives the status of a run from the status of its jobs, as GitHub gives it. */
const runStatus = (jobs: readonly WorldJob[]): string => {
  if (jobs.every((job) => job.status === "completed")) return "completed";
  if (jobs.every((job) => job.status === "queued")) return "queued";
  return "in_progress";
};

/** This function gives a run as the REST API of GitHub gives it. */
const runJson = (run: WorldRun): Record<string, unknown> => ({
  id: run.run.runId,
  run_attempt: run.run.runAttempt,
  event: run.run.event,
  status: runStatus(run.jobs),
  repository: { full_name: run.run.repository },
  head_repository: run.run.headRepository === null ? null : { full_name: run.run.headRepository },
  actor: { login: run.run.actor },
  triggering_actor: { login: run.run.triggeringActor },
});

/** This function gives a job as the REST API of GitHub gives it. */
const jobJson = (job: WorldJob): Record<string, unknown> => ({
  id: job.jobId,
  run_id: job.runId,
  run_attempt: job.runAttempt,
  status: job.status,
  labels: [...job.labels],
  runner_name: job.runner,
});

/** This function gives a runner as the REST API of GitHub gives it. */
const runnerJson = (runner: { runnerId: number; name: string; online: boolean; busy: boolean; labels: readonly string[] }): Record<string, unknown> => ({
  id: runner.runnerId,
  name: runner.name,
  os: "linux",
  status: runner.online ? "online" : "offline",
  busy: runner.busy,
  labels: runner.labels.map((name, index) => ({ id: index + 1, name, type: "custom" })),
});

const ROUTE = /^\/repos\/([^/]+\/[^/]+)\/actions\/(.+)$/;
const ORGANIZATION_ROUTE = /^\/orgs\/([^/]+)\/actions\/(.+)$/;
const RUN_ROUTE = /^runs\/(\d+)$/;
const JOBS_ROUTE = /^runs\/(\d+)\/attempts\/(\d+)\/jobs$/;
const RUNNER_ROUTE = /^runners\/(\d+)$/;

/**
 * This function makes a fake REST API of GitHub on a fake world, for the tests of the GitHub source.
 * It gives the runs, the jobs and the runners of the world in the shape of GitHub, with pages.
 *
 * - A list of runs has the newest try of each run, with the newest run first. It has 1,000 runs at most.
 * - The status of a run comes from its jobs. Each job is completed, each job is queued, or the run is `in_progress`.
 * - The runners of a repository and of an organization of the world are separate scopes, as on GitHub. The API answers 404 for an organization that the world does not have.
 * - A request for a runner uses the registry of the world. Thus the faults of the world apply to it.
 * - The API answers 409 for a runner name that the scope has and 404 for a runner that is not there. It answers 422 for a busy runner.
 *
 * @param world - The fake world
 * @param options - The size of a page and the faults
 * @returns The fake API, with the record of each request
 * @throws RangeError when the size of a page is not a whole number from 1
 */
export function fakeGitHubApi(world: FakeWorld, options: FakeGitHubOptions = {}): FakeGitHub {
  const size = options.pageSize ?? PAGE_SIZE;
  if (!isId(size)) throw new RangeError("The page size of a fake API is not a whole number from 1.");
  const log: GitHubRequest[] = [];
  const answer = (status: number, body: unknown = null): GitHubAnswer => ({ status, body });
  const number = (value: string | undefined, fallback: number): number => {
    const given = Number(value);
    return Number.isSafeInteger(given) && given >= 1 ? given : fallback;
  };
  /** This function gives one page of a list. GitHub gives 30 items on a page when the request does not tell the count. */
  const page = (request: GitHubRequest, key: string, all: readonly unknown[], limit = Number.MAX_SAFE_INTEGER): GitHubAnswer => {
    const per = Math.min(number(request.query["per_page"], 30), PAGE_SIZE, size);
    const at = number(request.query["page"], 1);
    return answer(200, { total_count: all.length, [key]: all.slice(0, limit).slice((at - 1) * per, at * per) });
  };
  /** This function gives the newest try of each run of a repository, with the newest run first. */
  const newest = (repository: string): WorldRun[] => {
    const found = new Map<number, WorldRun>();
    for (const run of world.runs()) {
      if (!sameName(run.run.repository, repository)) continue;
      const known = found.get(run.run.runId);
      if (known === undefined || known.run.runAttempt < run.run.runAttempt) found.set(run.run.runId, run);
    }
    return [...found.values()].sort((a, b) => b.run.runId - a.run.runId);
  };
  const runnersOf = (scope: string) =>
    world
      .runners()
      .filter((runner) => sameName(runner.scope, scope))
      .sort((a, b) => a.runnerId - b.runnerId);

  /** This function answers a request for the runners of a scope, or gives `null` for a request that is not one. */
  const runnersRoute = async (scope: string, rest: string, request: GitHubRequest, signal: StopSignal): Promise<GitHubAnswer | null> => {
    const { method } = request;
    if (method === "GET" && rest === "runners") return page(request, "runners", runnersOf(scope).map(runnerJson));
    if (method === "POST" && rest === "runners/generate-jitconfig") {
      const body: Record<string, unknown> = isObject(request.body) ? request.body : {};
      const { name, labels } = body;
      if (typeof name !== "string" || !Array.isArray(labels) || !labels.every((label) => typeof label === "string")) return answer(422);
      if (runnersOf(scope).some((runner) => runner.name === name)) return answer(409);
      const made = await world.registry.register(scope, name, labels as string[], signal);
      const runner = { runnerId: made.runnerId, name, online: false, busy: false, labels: labels as string[] };
      return answer(201, { runner: runnerJson(runner), encoded_jit_config: made.configuration });
    }
    const runner = RUNNER_ROUTE.exec(rest);
    if (method === "DELETE" && runner !== null) {
      const found = runnersOf(scope).find((each) => each.runnerId === Number(runner[1]));
      if (found === undefined) return answer(404);
      if (found.busy) return answer(422);
      await world.registry.remove(scope, found.runnerId, signal);
      return answer(204);
    }
    return null;
  };

  const route = async (request: GitHubRequest, signal: StopSignal): Promise<GitHubAnswer> => {
    const owned = ORGANIZATION_ROUTE.exec(request.path);
    if (owned !== null) {
      const organization = world.organizations().find((each) => sameName(each, owned[1]));
      if (organization === undefined) return answer(404);
      return (await runnersRoute(organization, owned[2] as string, request, signal)) ?? answer(404);
    }
    const match = ROUTE.exec(request.path);
    if (match === null) return answer(404);
    const repository = match[1] as string;
    const rest = match[2] as string;
    const { method } = request;
    if (method === "GET" && rest === "runs") {
      const status = request.query["status"];
      const all = newest(repository)
        .map(runJson)
        .filter((run) => status === undefined || run["status"] === status);
      return page(request, "workflow_runs", all, RUN_LIST_LIMIT);
    }
    const run = RUN_ROUTE.exec(rest);
    if (method === "GET" && run !== null) {
      const found = newest(repository).find((each) => each.run.runId === Number(run[1]));
      return found === undefined ? answer(404) : answer(200, runJson(found));
    }
    const jobs = JOBS_ROUTE.exec(rest);
    if (method === "GET" && jobs !== null) {
      const found = world
        .runs()
        .find((each) => sameName(each.run.repository, repository) && each.run.runId === Number(jobs[1]) && each.run.runAttempt === Number(jobs[2]));
      return found === undefined ? answer(404) : page(request, "jobs", [...found.jobs].sort((a, b) => a.jobId - b.jobId).map(jobJson));
    }
    return (await runnersRoute(repository, rest, request, signal)) ?? answer(404);
  };

  return {
    api: {
      request(request: GitHubRequest, signal: StopSignal): Promise<GitHubAnswer> {
        log.push({ ...request, query: { ...request.query } });
        if (signal.aborted) return Promise.reject(new Error(`The signal stopped the request ${request.method} ${request.path}.`));
        const given = options.answer?.(request) ?? null;
        if (given !== null) return Promise.resolve(given);
        return route(request, signal);
      },
    },
    requests: (): readonly GitHubRequest[] => [...log],
  };
}
