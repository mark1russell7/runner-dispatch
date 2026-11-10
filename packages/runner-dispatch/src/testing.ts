import { checkJob, type CheckRefusal, type CheckSettings, type JobEnvironment } from "./check.ts";
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

/** This record is one runner registration of a fake world. */
export interface WorldRunner extends SourceRunner {
  /** This field is the repository of the registration. */
  readonly repository: string;
  /** This list has the labels of the runner. */
  readonly labels: readonly string[];
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
 * - A connected runner with no job takes a queued job of its repository when it has each label of the job.
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
  readonly repository: string;
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
        if (!sameName(run.run.repository, runner.repository)) continue;
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

  const source: JobSource = {
    view(repository: string, _runs: readonly RunKey[], signal: StopSignal): Promise<RepositoryView> {
      try {
        end("view", begin("view", repository, signal));
      } catch (error) {
        return Promise.reject(error as Error);
      }
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
          .filter((runner) => sameName(runner.repository, repository))
          .map((runner): SourceRunner => ({ runnerId: runner.runnerId, name: runner.name, online: runner.online, busy: runner.job !== null })),
      });
    },
    register(request: RunnerRequest, signal: StopSignal): Promise<RunnerRegistration> {
      try {
        const fault = begin("register", request.name, signal);
        if (runners.some((runner) => runner.name === request.name && sameName(runner.repository, request.repository))) {
          throw new Error("The repository has a runner with this name.");
        }
        ids += 1;
        const configuration = `one-job-configuration-${ids}-${request.name}`;
        secrets.push(configuration);
        runners.push({
          runnerId: ids,
          name: request.name,
          repository: request.repository,
          labels: [...request.labels],
          configuration,
          online: false,
          job: null,
        });
        note("registered", request.name);
        end("register", fault);
        return Promise.resolve({ runnerId: ids, configuration });
      } catch (error) {
        return Promise.reject(error as Error);
      }
    },
    remove(repository: string, runnerId: number, signal: StopSignal): Promise<void> {
      try {
        const runner = runners.find((each) => each.runnerId === runnerId && sameName(each.repository, repository));
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
        repository: runner.repository,
        labels: [...runner.labels],
        online: runner.online,
        busy: runner.job !== null,
      })),
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
