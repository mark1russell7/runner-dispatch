import { timerBand, timerOf, transitionOn, type KnobValues, type Machine } from "@mark1russell7/algebra";
import { quantity } from "@mark1russell7/quantity";
import { isObject, show } from "./policy.ts";

/** This type is one state of the life of a machine. */
export type MachineState = "asked" | "made" | "registered" | "busy" | "done" | "destroyed";

/** This type is one event that the life of a machine takes: a report from outside, or the firing of a timer. */
export type MachineEvent =
  | "provider.made"
  | "provider.failed"
  | "runner.registered"
  | "job.started"
  | "job.completed"
  | "job.none"
  | "stop"
  | "provider.destroyed"
  | "timer.make"
  | "timer.register"
  | "timer.idle"
  | "timer.job"
  | "timer.destroy";

/** This type is one request that the dispatcher makes at a transition. */
export type MachineAction = "provider.destroy";

/** This list has the states of a machine, in the sequence of its life. No transition goes back in this sequence. */
export const MACHINE_STATES: readonly MachineState[] = Object.freeze([
  "asked",
  "made",
  "registered",
  "busy",
  "done",
  "destroyed",
]);

/** This list has each event that the life of a machine takes. */
export const MACHINE_EVENTS: readonly MachineEvent[] = Object.freeze([
  "provider.made",
  "provider.failed",
  "runner.registered",
  "job.started",
  "job.completed",
  "job.none",
  "stop",
  "provider.destroyed",
  "timer.make",
  "timer.register",
  "timer.idle",
  "timer.job",
  "timer.destroy",
]);

/** This list has each request that the dispatcher makes at a transition. */
export const MACHINE_ACTIONS: readonly MachineAction[] = Object.freeze(["provider.destroy"]);

const freeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const part of Object.values(value)) freeze(part);
  }
  return value;
};

/**
 * This document is the life of one machine, in the format `mark1russell7.machine/1` of `@mark1russell7/algebra`.
 * It is the specification: the functions of this module read it, and the dispatcher follows it.
 *
 * - Each state that is not final has one timer, which starts at the entry to the state.
 * - Before the state `done`, the firing of the timer of a state goes to `done`.
 * - In the state `done`, the firing asks the provider again, and each wait is two times the wait before it.
 * - A machine goes to `destroyed` only when the provider tells that the machine is not there.
 * - The dispatcher sees a firing at the first pass of its loop after the wait. Thus a timer can fire one pass late.
 */
export const MACHINE_LIFECYCLE: Machine = freeze<Machine>({
  format: "mark1russell7.machine/1",
  id: "runner-dispatch.machine",
  title: "The life of one machine of a dispatcher of one-job CI runners",
  layer: "self",
  version: "1",
  sources: [
    {
      ref: "@mark1russell7/runner-dispatch, src/lifecycle.ts: this document is the specification, and the dispatcher follows it",
      rung: "normative",
    },
  ],
  states: {
    asked: { initial: true, note: "the dispatcher asked the provider for the machine" },
    made: { note: "the machine operates, and its runner is not connected to GitHub" },
    registered: { note: "the runner of the machine is connected to GitHub, and it has no job" },
    busy: { note: "the runner does its one job" },
    done: { note: "the machine has no more work, and the dispatcher asks the provider to destroy it" },
    destroyed: { final: true, note: "the provider tells that the machine is not there" },
  },
  events: {
    "provider.made": { kind: "rx", note: "the provider tells that the machine operates" },
    "provider.failed": { kind: "rx", note: "the provider tells that the machine does not operate: it cannot make it, or the machine stopped" },
    "runner.registered": { kind: "rx", note: "GitHub shows that the runner of the machine is connected" },
    "job.started": { kind: "rx", note: "GitHub gives a job to the runner of the machine" },
    "job.completed": { kind: "rx", note: "the job of the runner ends, with each result" },
    "job.none": { kind: "rx", note: "the run of the machine has no job for this runner: each job ended, or another runner has it" },
    stop: { kind: "app", note: "the stop switch of the dispatcher" },
    "provider.destroyed": { kind: "rx", note: "the provider tells that the machine is not there" },
    "provider.destroy": { kind: "tx", note: "the dispatcher asks the provider to destroy the machine" },
    "timer.make": { kind: "timer" },
    "timer.register": { kind: "timer" },
    "timer.idle": { kind: "timer" },
    "timer.job": { kind: "timer" },
    "timer.destroy": { kind: "timer" },
  },
  knobs: {
    make: { key: "make", scope: "dispatcher", unit: "s", default: null, note: "the longest time for the provider to make a machine" },
    register: { key: "register", scope: "dispatcher", unit: "s", default: null, note: "the longest time for the runner of a machine to connect to GitHub" },
    idle: { key: "idle", scope: "dispatcher", unit: "s", default: null, note: "the longest time that a connected runner waits for its job" },
    job: { key: "job", scope: "dispatcher", unit: "s", default: null, note: "the longest time of a job" },
    retry: { key: "retry", scope: "dispatcher", unit: "s", default: null, note: "the first wait before the dispatcher asks the provider again to destroy a machine" },
    retry_max: { key: "retryMax", scope: "dispatcher", unit: "s", default: null, note: "the longest wait before the dispatcher asks again" },
    pass: { key: "pass", scope: "dispatcher", unit: "s", default: null, note: "the longest time between two passes of the loop of the dispatcher" },
  },
  timers: {
    make: {
      duration: { knob: "make", unit: "s" },
      lateness: { knob: "pass", unit: "s" },
      arms: ["enter:asked"],
      cancels: ["provider.made", "provider.failed", "job.none", "stop"],
      fires: "timer.make",
    },
    register: {
      duration: { knob: "register", unit: "s" },
      lateness: { knob: "pass", unit: "s" },
      arms: ["enter:made"],
      cancels: ["runner.registered", "provider.failed", "job.none", "stop", "provider.destroyed"],
      fires: "timer.register",
    },
    idle: {
      duration: { knob: "idle", unit: "s" },
      lateness: { knob: "pass", unit: "s" },
      arms: ["enter:registered"],
      cancels: ["job.started", "provider.failed", "job.none", "stop", "provider.destroyed"],
      fires: "timer.idle",
    },
    job: {
      duration: { knob: "job", unit: "s" },
      lateness: { knob: "pass", unit: "s" },
      arms: ["enter:busy"],
      cancels: ["job.completed", "provider.failed", "stop", "provider.destroyed"],
      fires: "timer.job",
    },
    destroy: {
      duration: { expr: "min(retry * pow(2, min(fired, 32)), retry_max)", unit: "s" },
      lateness: { knob: "pass", unit: "s" },
      arms: ["enter:done"],
      cancels: ["provider.destroyed"],
      fires: "timer.destroy",
      backoff: { resets: ["enter:done"] },
      note: "each firing asks the provider again, and the waits have no end: only the provider ends the state done",
    },
  },
  transitions: [
    { id: "made", from: "asked", on: "provider.made", to: "made" },
    { id: "registered", from: "made", on: "runner.registered", to: "registered" },
    { id: "started", from: "registered", on: "job.started", to: "busy" },
    { id: "completed", from: "busy", on: "job.completed", to: "done", emits: ["provider.destroy"] },
    { id: "failed", from: ["asked", "made", "registered", "busy"], on: "provider.failed", to: "done", emits: ["provider.destroy"] },
    { id: "no-job", from: ["asked", "made", "registered"], on: "job.none", to: "done", emits: ["provider.destroy"] },
    { id: "stopped", from: ["asked", "made", "registered", "busy"], on: "stop", to: "done", emits: ["provider.destroy"] },
    { id: "make-late", from: "asked", on: "timer.make", to: "done", timer: "make", emits: ["provider.destroy"] },
    { id: "register-late", from: "made", on: "timer.register", to: "done", timer: "register", emits: ["provider.destroy"] },
    { id: "idle-late", from: "registered", on: "timer.idle", to: "done", timer: "idle", emits: ["provider.destroy"] },
    { id: "job-late", from: "busy", on: "timer.job", to: "done", timer: "job", emits: ["provider.destroy"] },
    { id: "destroy-again", from: "done", on: "timer.destroy", to: "done", timer: "destroy", emits: ["provider.destroy"] },
    { id: "lost", from: ["made", "registered", "busy"], on: "provider.destroyed", to: "destroyed" },
    { id: "destroyed", from: "done", on: "provider.destroyed", to: "destroyed" },
  ],
});

/** This text is the format of a document of the times of a machine. */
export const MACHINE_TIMES_FORMAT = "machine-times/1";

/** This number is the largest value of a time, in seconds: 365 days. */
export const MACHINE_TIME_MAX = 31_536_000;

/**
 * This record has the times of the life of a machine, each in seconds.
 * Each field is the key of one knob of the document `MACHINE_LIFECYCLE`.
 */
export interface MachineTimes {
  /** This field is the longest time for the provider to make a machine. */
  readonly make: number;
  /** This field is the longest time for the runner of a machine to connect to GitHub. */
  readonly register: number;
  /** This field is the longest time that a connected runner waits for its job. */
  readonly idle: number;
  /** This field is the longest time of a job. */
  readonly job: number;
  /** This field is the first wait before the dispatcher asks the provider again to destroy a machine. */
  readonly retry: number;
  /** This field is the longest wait before the dispatcher asks again. It is not less than `retry`. */
  readonly retryMax: number;
  /** This field is the longest time between two passes of the loop of the dispatcher. */
  readonly pass: number;
}

/** This type is the result of `parseMachineTimes`: the times, or the list of the problems. */
export type MachineTimesResult =
  | { readonly ok: true; readonly times: MachineTimes }
  | { readonly ok: false; readonly problems: readonly string[] };

const TIME_KEYS: readonly (keyof MachineTimes)[] = Object.freeze(["make", "register", "idle", "job", "retry", "retryMax", "pass"]);

const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MACHINE_TIME_MAX;

/** This function gives the problems of the fields of a record of times. */
const timeProblems = (value: Record<string, unknown>): string[] => {
  const problems: string[] = [];
  for (const key of TIME_KEYS) {
    if (!isTime(value[key])) {
      problems.push(`The field ${key} is not a number of seconds above 0 and not above ${MACHINE_TIME_MAX}: ${show(value[key])}.`);
    }
  }
  const { retry, retryMax } = value;
  if (isTime(retry) && isTime(retryMax) && retryMax < retry) {
    problems.push("The field retryMax is less than the field retry.");
  }
  return problems;
};

/**
 * This function reads a document of the times of a machine, for example from a JSON file.
 * Each time is in seconds, and it is above 0. Thus each timer of a machine has an end.
 *
 * @param value - The value of the document
 * @returns The times, or the list of the problems
 */
export function parseMachineTimes(value: unknown): MachineTimesResult {
  if (!isObject(value)) return { ok: false, problems: ["The document is not an object."] };
  const problems: string[] = [];
  if (value["format"] !== MACHINE_TIMES_FORMAT) {
    problems.push(`The field format is not "${MACHINE_TIMES_FORMAT}".`);
  }
  for (const key of Object.keys(value)) {
    if (key !== "format" && !(TIME_KEYS as readonly string[]).includes(key)) {
      problems.push(`The document has the unknown field ${show(key)}.`);
    }
  }
  problems.push(...timeProblems(value));
  if (problems.length > 0) return { ok: false, problems };
  const times = Object.fromEntries(TIME_KEYS.map((key) => [key, value[key]])) as unknown as MachineTimes;
  return { ok: true, times: Object.freeze(times) };
}

/** This function gives the values of the knobs of the document from a record of times. */
const valuesOf = (times: MachineTimes): KnobValues => {
  if (!isObject(times) || timeProblems(times).length > 0) {
    throw new RangeError("The times of a machine are not valid. The function parseMachineTimes gives the problems.");
  }
  return (name) => {
    const knob = MACHINE_LIFECYCLE.knobs[name];
    return knob === undefined ? undefined : quantity(times[knob.key as keyof MachineTimes], "s");
  };
};

/** This record is the present point of the life of one machine. */
export interface MachineLife {
  /** This field is the state of the machine. */
  readonly state: MachineState;
  /** This field is the time of the last transition, in milliseconds of a clock that does not go back. */
  readonly at: number;
  /** This field is the count of the firings of the timer of the state, after the entry to the state. */
  readonly fired: number;
}

/** This record is one transition of the life of a machine. */
export interface MachineStep {
  /** This field is the life after the transition. */
  readonly life: MachineLife;
  /** This field is the id of the transition in the document. */
  readonly transition: string;
  /** This field has the requests that the dispatcher makes at this transition. */
  readonly actions: readonly MachineAction[];
}

/** This record is the wait of the timer of a state. Each time is in milliseconds after the start of the wait. */
export interface MachineWait {
  /** This field is the name of the timer in the document. */
  readonly timer: string;
  /** This field is the event that the timer fires. */
  readonly fires: MachineEvent;
  /** This field is the time of the wait. The timer does not fire before it. */
  readonly low: number;
  /** This field is the time of the wait plus one pass of the loop. The dispatcher sees the firing not after it. */
  readonly high: number;
}

/** This record has the longest times from the request for a machine to the end of its work, in milliseconds. */
export interface LongestLife {
  /** This field is the longest time for a machine that gets a job. */
  readonly withJob: number;
  /** This field is the longest time for a machine that gets no job. */
  readonly withoutJob: number;
}

const INITIAL = MACHINE_STATES.find((state) => MACHINE_LIFECYCLE.states[state]?.initial === true) ?? "asked";

/**
 * This function starts the life of a machine, in the first state of the document.
 * The dispatcher uses it when it asks the provider for the machine.
 *
 * @param at - The time of the request, in milliseconds
 * @returns The life, in the state `asked`
 */
export function startLife(at: number): MachineLife {
  return { state: INITIAL, at, fired: 0 };
}

/**
 * This function applies one event to the life of a machine, as the document tells.
 * A firing that stays in its state adds one to the count `fired`. An entry to a different state sets the count to 0.
 *
 * @param life - The present point of the life
 * @param event - The event
 * @param at - The time of the event, in milliseconds
 * @returns The transition, or `null` when the document has no transition from the state on the event
 */
export function advance(life: MachineLife, event: MachineEvent, at: number): MachineStep | null {
  const taken = transitionOn(MACHINE_LIFECYCLE, life.state, event);
  if (taken === undefined) return null;
  const state = taken.to as MachineState;
  return {
    life: { state, at, fired: state === life.state ? life.fired + 1 : 0 },
    transition: taken.id,
    actions: (taken.emits ?? []) as readonly MachineAction[],
  };
}

/**
 * This function gives the wait of the timer of a state, from the document and the times.
 * The algebra of `@mark1russell7/algebra` calculates each time exactly.
 *
 * @param state - The state
 * @param times - The times of the machine
 * @param fired - The count of the firings of the timer after the entry to the state. Only the state `done` reads it.
 * @returns The wait, or `null` for the state `destroyed`, which has no timer
 * @throws RangeError when `parseMachineTimes` does not accept the times, or `fired` is not a whole number from 0
 */
export function waitOf(state: MachineState, times: MachineTimes, fired = 0): MachineWait | null {
  const values = valuesOf(times);
  if (!Number.isSafeInteger(fired) || fired < 0) {
    throw new RangeError("The count of the firings of a timer is a whole number from 0.");
  }
  const timer = Object.keys(MACHINE_LIFECYCLE.timers).find((name) =>
    MACHINE_LIFECYCLE.timers[name]?.arms.includes(`enter:${state}`),
  );
  const def = timer === undefined ? undefined : MACHINE_LIFECYCLE.timers[timer];
  if (timer === undefined || def === undefined) return null;
  const band = timerBand(timerOf(MACHINE_LIFECYCLE, timer, values, fired), "ms");
  if ("unknown" in band || typeof band.low.value !== "number" || typeof band.high.value !== "number") {
    throw new RangeError(`The algebra gives no time for the timer ${timer}.`);
  }
  return { timer, fires: def.fires as MachineEvent, low: band.low.value, high: band.high.value };
}

/**
 * This function tells if the timer of the state of a machine fires at a time.
 * The dispatcher uses it at each pass of its loop, and it applies the event with `advance`.
 *
 * @param life - The present point of the life
 * @param now - The present time, in milliseconds of the same clock
 * @param times - The times of the machine
 * @returns The event of the timer when its wait ended, or `null`
 * @throws RangeError when `parseMachineTimes` does not accept the times
 */
export function due(life: MachineLife, now: number, times: MachineTimes): MachineEvent | null {
  const wait = waitOf(life.state, times, life.fired);
  if (wait === null) return null;
  return now - life.at >= wait.low ? wait.fires : null;
}

/**
 * This function gives the longest times from the request for a machine to the end of its work.
 * The work ends at the entry to the state `done`, or to the state `destroyed`.
 * Each time is the longest path in the document, with each timer one pass late.
 *
 * @param times - The times of the machine
 * @returns The longest time with a job, and the longest time with no job, in milliseconds
 * @throws RangeError when `parseMachineTimes` does not accept the times
 */
export function longestLife(times: MachineTimes): LongestLife {
  const END: MachineState = "done";
  const from = (state: MachineState, avoid: MachineState | null): number => {
    if (state === END) return 0;
    const wait = waitOf(state, times);
    if (wait === null) return Number.NEGATIVE_INFINITY;
    let rest = Number.NEGATIVE_INFINITY;
    for (const next of MACHINE_STATES) {
      if (next === state || next === avoid) continue;
      const reaches = MACHINE_EVENTS.some((event) => transitionOn(MACHINE_LIFECYCLE, state, event)?.to === next);
      if (reaches) rest = Math.max(rest, from(next, avoid));
    }
    return wait.high + rest;
  };
  return { withJob: from(INITIAL, null), withoutJob: from(INITIAL, "busy") };
}
