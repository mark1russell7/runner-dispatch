import type { CheckSettings } from "./check.ts";
import type { JobRecord, MachineRecord, RunKey, RunRecord } from "./records.ts";

/**
 * This type is the signal that stops a request. The dispatcher reads only the field `aborted`.
 * An `AbortSignal` of the platform has this shape. The dispatcher gives the signal of its caller to each port, with no change.
 */
export interface StopSignal {
  /** This field is `true` after the caller stopped the pass. */
  readonly aborted: boolean;
}

/**
 * This type is the status of a job, as the source shows it.
 * `queued` tells that the job waits for a runner. A job that waits for an approval is not `queued`.
 */
export type JobStatus = "queued" | "in_progress" | "completed";

/** This record is one job of a run, with its status. */
export interface SourceJob extends JobRecord {
  /** This field is the status of the job. */
  readonly status: JobStatus;
  /** This field is the name of the runner that has the job. It is `null` when no runner has it. */
  readonly runner: string | null;
}

/** This record is one run that is not completed, with its jobs. */
export interface SourceRun {
  /** This field is the record that the source keeps of the run. */
  readonly run: RunRecord;
  /** This list has each job of this try of the run. */
  readonly jobs: readonly SourceJob[];
}

/** This record is one runner registration of a repository or of an organization. */
export interface SourceRunner {
  /** This field is the id of the registration. */
  readonly runnerId: number;
  /** This field is the name of the runner. */
  readonly name: string;
  /** This field is `true` when the runner is connected to the source. */
  readonly online: boolean;
  /** This field is `true` when the runner has a job. */
  readonly busy: boolean;
}

/** This record is what the source shows of one repository at one time. */
export interface RepositoryView {
  /** This list has each run of the repository that is not completed. */
  readonly runs: readonly SourceRun[];
  /** This list has each runner registration of the scope of the repository. */
  readonly runners: readonly SourceRunner[];
  /**
   * This field names the scope of the runner registrations, for example an organization. When it is absent, the scope is the repository.
   * Two views with the same scope show the same registrations. The dispatcher compares two scopes as texts.
   */
  readonly scope?: string;
}

/** This record is the request for a runner registration that does one job. */
export interface RunnerRequest {
  /** This field is the repository of the run of the runner, as `owner/name`. The source registers the runner in the scope of this repository. */
  readonly repository: string;
  /** This field is the name of the runner. */
  readonly name: string;
  /** This list has the labels of the runner. The runner has no other label. */
  readonly labels: readonly string[];
}

/** This record is a new runner registration. */
export interface RunnerRegistration {
  /** This field is the id of the registration. */
  readonly runnerId: number;
  /**
   * This field is the one-job configuration of the runner. It is a credential for one use.
   * The dispatcher gives it only to the provider. It does not write it to a report.
   */
  readonly configuration: string;
}

/**
 * This port is the source of the jobs, for example GitHub. Each method takes a signal that stops the request.
 * A method throws when it cannot give a complete answer.
 */
export interface JobSource<Signal extends StopSignal = StopSignal> {
  /**
   * This method gives the runs of a repository that are not completed, and its runner registrations.
   * The answer is exact for each run that the dispatcher names. A named run that is not in the answer is completed, or it is not there.
   */
  view(repository: string, runs: readonly RunKey[], signal: Signal): Promise<RepositoryView>;
  /** This method makes a runner registration that does one job. */
  register(request: RunnerRequest, signal: Signal): Promise<RunnerRegistration>;
  /** This method removes a runner registration of the scope of a repository. It succeeds when the registration is not there. */
  remove(repository: string, runnerId: number, signal: Signal): Promise<void>;
}

/** This type is the status of a machine, as the provider shows it. */
export type MachineStatus = "making" | "operating" | "stopped";

/** This record is one machine of the provider, with its status. */
export interface ProviderMachine {
  /** This field is the record of the machine, as the dispatcher gave it. */
  readonly machine: MachineRecord;
  /** This field is the status of the machine. */
  readonly status: MachineStatus;
}

/** This record is the request for a machine. */
export interface MachineRequest {
  /** This field is the record of the machine: its name, its size and its run. */
  readonly machine: MachineRecord;
  /** This field is the one-job configuration of the runner of the machine. */
  readonly configuration: string;
  /** This field has the settings of the check on the machine: the trust rules and the run. */
  readonly check: CheckSettings;
}

/**
 * This port is the provider of the machines, for example a hypervisor. Each method takes a signal that stops the request.
 * A method throws when the provider does not accept the request.
 */
export interface MachineProvider<Signal extends StopSignal = StopSignal> {
  /** This method asks for a machine. It ends when the provider accepts the request, before the machine operates. */
  make(request: MachineRequest, signal: Signal): Promise<void>;
  /** This method gives each machine of this dispatcher, also a machine that the provider makes or that stopped. */
  machines(signal: Signal): Promise<readonly ProviderMachine[]>;
  /** This method asks the provider to destroy a machine. It succeeds when the machine is not there. */
  destroy(name: string, signal: Signal): Promise<void>;
}
