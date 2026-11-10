import { advance, startLife, waitOf, type MachineTimes } from "./lifecycle.ts";
import {
  noteStep,
  plan,
  runOf,
  EMPTY_STATE,
  type DispatchLife,
  type DispatchState,
  type LifeStep,
  type PlannedMake,
  type PlannedRemoval,
  type PlannedWait,
  type RepositoryObservation,
} from "./plan.ts";
import { parseTrustRules, show, TRUST_RULES_FORMAT, type TrustRules } from "./policy.ts";
import type { JobSource, MachineProvider, ProviderMachine, StopSignal } from "./ports.ts";
import { runLabel, sameName, sameRun, type MachineRecord, type RunKey } from "./records.ts";
import { machineName, runnerLabels, settingsProblems, type DispatchSettings } from "./settings.ts";

/** This record has the parts of a dispatcher: its documents, its two ports, its clock and its stop switch. */
export interface DispatcherOptions<Signal extends StopSignal = StopSignal> {
  /** This field has the trust rules. */
  readonly rules: TrustRules;
  /** This field has the times of a machine. */
  readonly times: MachineTimes;
  /** This field has the settings of the dispatcher. */
  readonly settings: DispatchSettings;
  /** This field is the source of the jobs. */
  readonly source: JobSource<Signal>;
  /** This field is the provider of the machines. */
  readonly provider: MachineProvider<Signal>;
  /** This function gives the time, in milliseconds of a clock that does not go back. */
  readonly now: () => number;
  /** This function gives the last part of the name of a new machine: 8 digits of base 16, different at each use. */
  readonly suffix: () => string;
  /** This function reads the stop switch. It gives `true` when the switch is on. It gets the signal of the pass, as each port does. */
  readonly stopped: (signal: Signal) => boolean | Promise<boolean>;
}

/** This type names a request of a pass. */
export type PassRequest = "stop-switch" | "machines" | "view" | "destroy" | "remove" | "register" | "make";

/** This record is one request of a pass that failed. */
export interface PassFailure {
  /** This field names the request. */
  readonly request: PassRequest;
  /** This field is the repository, the machine or the run label of the request. */
  readonly target: string;
  /** This field tells the reason, for a log. It does not have the one-job configuration of a runner. */
  readonly text: string;
}

/** This record tells what one pass of the dispatcher saw and did. It has no one-job configuration. */
export interface PassReport {
  /** This field is the time of the pass, in milliseconds. */
  readonly at: number;
  /** This field is `true` when the stop switch was on. It is `null` when the pass could not read the switch. */
  readonly stopped: boolean | null;
  /** This list has each transition of the pass, in its sequence. */
  readonly steps: readonly LifeStep[];
  /** This list has the name of each machine that the provider had and the memory did not have. */
  readonly adopted: readonly string[];
  /** This list has the name of each machine that the pass asked the provider to destroy. */
  readonly destroys: readonly string[];
  /** This list has each runner registration that the pass asked the source to remove. */
  readonly removals: readonly PlannedRemoval[];
  /** This list has each machine that the pass asked the provider to make. */
  readonly made: readonly MachineRecord[];
  /** This list has the queued jobs that got no machine in the pass, with the reason. */
  readonly waits: readonly PlannedWait[];
  /** This list has each request that failed. */
  readonly failures: readonly PassFailure[];
  /** This list has each machine of the memory after the pass. */
  readonly lives: readonly DispatchLife[];
  /** This field is `true` when the signal stopped the pass, and a request of the plan did not start. */
  readonly cut: boolean;
}

/** This type is a dispatcher: its loop is a sequence of passes. */
export interface Dispatcher<Signal extends StopSignal = StopSignal> {
  /**
   * This method does one pass. It reads the stop switch, the provider and the source, and it makes the plan.
   * Then it sends the requests of the plan: it destroys machines, removes registrations and makes machines.
   * A request that fails is in the report: the method does not throw for it, and the next pass tries again.
   * The method throws when a pass before it did not end.
   */
  pass(signal: Signal): Promise<PassReport>;
  /** This method gives the memory of the dispatcher. */
  state(): DispatchState;
}

const REDACTED = "[configuration]";

/** This function tells the reason of a failed request. It removes a one-job configuration from the text. */
const reasonOf = (error: unknown, secret?: string): string => {
  const raw = error instanceof Error ? error.message : error;
  if (typeof raw !== "string") return "The request failed with a value that is not an error.";
  return show(secret === undefined || secret.length === 0 ? raw : raw.split(secret).join(REDACTED));
};

/**
 * This function makes a dispatcher. The dispatcher keeps its memory only in the process.
 * A dispatcher that starts again finds each machine in the list of the provider.
 *
 * @param options - The documents, the two ports, the clock and the stop switch
 * @returns The dispatcher
 * @throws RangeError when the trust rules, the times or the settings are not valid
 */
export function createDispatcher<Signal extends StopSignal = StopSignal>(options: DispatcherOptions<Signal>): Dispatcher<Signal> {
  const { rules, times, settings, source, provider } = options;
  const parsed = parseTrustRules({
    format: TRUST_RULES_FORMAT,
    repositories: rules.repositories,
    events: rules.events,
    actors: rules.actors,
  });
  if (!parsed.ok) throw new RangeError(`The trust rules of the dispatcher are not valid. ${parsed.problems.join(" ")}`);
  const problems = settingsProblems(settings);
  if (problems.length > 0) throw new RangeError(`The settings of the dispatcher are not valid. ${problems.join(" ")}`);
  waitOf("asked", times);

  let state: DispatchState = EMPTY_STATE;
  let running = false;

  const once = async (signal: Signal): Promise<PassReport> => {
    const at = options.now();
    const failures: PassFailure[] = [];
    const fail = (request: PassRequest, target: string, error: unknown, secret?: string): void => {
      failures.push({ request, target, text: reasonOf(error, secret) });
    };

    let stopped: boolean | null = null;
    try {
      const value: unknown = await options.stopped(signal);
      if (typeof value !== "boolean") throw new TypeError("The stop switch gave a value that is not true or false.");
      stopped = value;
    } catch (error) {
      fail("stop-switch", "", error);
    }

    let machines: readonly ProviderMachine[] | null = null;
    try {
      machines = await provider.machines(signal);
    } catch (error) {
      fail("machines", "", error);
    }

    // The source gets the run of each machine, also of a machine that the memory does not have.
    const known: readonly MachineRecord[] = [...state.lives.map((each) => each.machine), ...(machines ?? []).map((each) => each.machine)];
    const views = await Promise.all(
      rules.repositories.map(async (repository): Promise<RepositoryObservation> => {
        const runs: RunKey[] = [];
        for (const machine of known) {
          if (sameName(machine.repository, repository) && !runs.some((run) => sameRun(machine, run))) runs.push(runOf(machine));
        }
        try {
          return { repository, view: await source.view(repository, runs, signal) };
        } catch (error) {
          fail("view", repository, error);
          return { repository, view: null };
        }
      }),
    );

    const planned = plan(state, { now: at, stopped, views, machines }, { rules, times, settings });
    state = planned.state;
    const steps: LifeStep[] = [...planned.steps];
    const destroys: string[] = [];
    const removals: PlannedRemoval[] = [];
    const made: MachineRecord[] = [];
    let cut = false;
    const open = (): boolean => {
      if (signal.aborted) cut = true;
      return !signal.aborted;
    };

    const destroy = async (name: string): Promise<void> => {
      if (!open()) return;
      destroys.push(name);
      try {
        await provider.destroy(name, signal);
      } catch (error) {
        fail("destroy", name, error);
      }
    };
    const remove = async (removal: PlannedRemoval): Promise<void> => {
      if (!open()) return;
      removals.push(removal);
      try {
        await source.remove(removal.repository, removal.runnerId, signal);
      } catch (error) {
        fail("remove", removal.name, error);
      }
    };
    const taken = new Set(state.lives.map((each) => each.machine.name));
    const make = async (asked: PlannedMake): Promise<void> => {
      if (!open()) return;
      const { run, size } = asked;
      const label = runLabel(run);
      let name: string;
      try {
        name = machineName(settings.prefix, run, options.suffix());
        if (taken.has(name)) throw new RangeError("The suffix function gave the name of a machine that is there.");
      } catch (error) {
        fail("register", label, error);
        return;
      }
      taken.add(name);
      let configuration: string;
      try {
        ({ configuration } = await source.register({ repository: run.repository, name, labels: runnerLabels(label, size) }, signal));
      } catch (error) {
        fail("register", name, error);
        return;
      }
      // A registration with no machine stays when the signal stops the pass here. The next pass removes it.
      if (!open()) return;
      const machine: MachineRecord = { name, size, repository: run.repository, runId: run.runId, runAttempt: run.runAttempt };
      const life = startLife(options.now());
      state = { lives: [...state.lives, { machine, life }], failures: state.failures };
      made.push(machine);
      try {
        await provider.make({ machine, configuration, check: { rules, run } }, signal);
      } catch (error) {
        fail("make", name, error, configuration);
        const now = options.now();
        const step = advance(life, "provider.failed", now);
        if (step === null) return;
        const record: LifeStep = { machine: name, run, from: life.state, on: "provider.failed", to: step.life.state, transition: step.transition, at: now };
        steps.push(record);
        state = {
          lives: state.lives.map((each) => (each.machine.name === name ? { machine, life: step.life } : each)),
          failures: noteStep(state.failures, record),
        };
        // The provider can have a part of the machine. Thus the dispatcher asks it to destroy the machine.
        if (step.actions.includes("provider.destroy")) await destroy(name);
      }
    };

    // The removals and the destroys start together. Thus a source that does not answer cannot hold a destroy.
    // A removal starts first: a runner with no registration takes no job while the provider destroys its machine.
    await Promise.all([...planned.removals.map(remove), ...planned.destroys.map(destroy)]);
    await Promise.all(planned.makes.map(make));

    return {
      at,
      stopped,
      steps,
      adopted: planned.adopted,
      destroys,
      removals,
      made,
      waits: planned.waits,
      failures,
      lives: state.lives,
      cut,
    };
  };

  return {
    async pass(signal: Signal): Promise<PassReport> {
      if (running) throw new Error("The pass before this pass did not end.");
      running = true;
      try {
        return await once(signal);
      } finally {
        running = false;
      }
    },
    state: (): DispatchState => state,
  };
}
