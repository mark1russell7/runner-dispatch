/**
 * The logic of the live demo of the home page. Each function has no effect, so the tests run it in Node.js.
 * The page gets each decision, each state and each time from the functions of `@mark1russell7/runner-dispatch`.
 */
import {
  advance,
  decide,
  due,
  longestLife,
  MACHINE_EVENTS,
  MACHINE_LIFECYCLE,
  MACHINE_STATES,
  MACHINE_TIMES_FORMAT,
  parseMachineTimes,
  parseTrustRules,
  startLife,
  TRUST_RULES_FORMAT,
  waitOf,
  type Decision,
  type LongestLife,
  type MachineAction,
  type MachineEvent,
  type MachineLife,
  type MachineState,
  type MachineTimes,
  type MachineTimesResult,
  type MachineWait,
  type RefusalRule,
  type RunRecord,
  type TrustRules,
} from "@mark1russell7/runner-dispatch";

/** This document is the sample of the trust rules of the demo. */
export const SAMPLE_RULES = Object.freeze({
  format: TRUST_RULES_FORMAT,
  repositories: ["octo-org/app"],
  events: ["push", "pull_request", "workflow_dispatch"],
  actors: ["alice", "bob"],
});

/** This type has the fields of the form of a run. */
export interface RunFields {
  readonly repository: string;
  readonly event: string;
  readonly headRepository: string;
  readonly actor: string;
  readonly triggeringActor: string;
  readonly attempt: number;
}

/** This type is one sample run of the demo. */
export interface Scenario {
  readonly id: string;
  readonly title: string;
  readonly run: RunFields;
}

const sampleRun = (fields: Partial<RunFields>): RunFields => ({
  repository: "octo-org/app",
  event: "push",
  headRepository: "octo-org/app",
  actor: "alice",
  triggeringActor: "alice",
  attempt: 1,
  ...fields,
});

/** This list has the sample runs of the demo. Each one shows a different rule. */
export const SCENARIOS: readonly Scenario[] = Object.freeze([
  { id: "push", title: "A push by a trusted account", run: sampleRun({}) },
  {
    id: "fork",
    title: "A pull request from a fork",
    run: sampleRun({ event: "pull_request", headRepository: "mallory/app", actor: "mallory", triggeringActor: "mallory" }),
  },
  {
    id: "trusted-fork",
    title: "A pull request from the fork of a trusted account",
    run: sampleRun({ event: "pull_request", headRepository: "alice/app" }),
  },
  { id: "target", title: "A pull_request_target run", run: sampleRun({ event: "pull_request_target" }) },
  { id: "retry", title: "A new try by an outside account", run: sampleRun({ attempt: 2, triggeringActor: "mallory" }) },
  {
    id: "other-repository",
    title: "A repository that is not served",
    run: sampleRun({ repository: "octo-org/site", headRepository: "octo-org/site" }),
  },
]);

/**
 * This function makes the record of a run from the fields of the form.
 * An empty head repository gives `null`, as GitHub gives for a run with no head commit.
 */
export function runOf(fields: RunFields): RunRecord {
  const head = fields.headRepository.trim();
  return {
    repository: fields.repository.trim(),
    runId: 1,
    runAttempt: fields.attempt,
    event: fields.event.trim(),
    headRepository: head === "" ? null : head,
    actor: fields.actor.trim(),
    triggeringActor: fields.triggeringActor.trim(),
  };
}

/** This type is the result of a read of the text of the trust rules. */
export type RulesRead =
  | { readonly ok: true; readonly rules: TrustRules }
  | { readonly ok: false; readonly problems: readonly string[] };

/** This function reads the text of the trust rules with `parseTrustRules`. A text that is not JSON gives one problem. */
export function readRules(text: string): RulesRead {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, problems: ["The text is not valid JSON."] };
  }
  const read = parseTrustRules(value);
  return read.ok ? { ok: true, rules: read.rules } : { ok: false, problems: read.problems };
}

/** This record gives each rule of the policy a short name for the page. The type makes sure that each rule has a name. */
const RULE_LABELS: Readonly<Record<RefusalRule, string>> = Object.freeze({
  record: "The record of the run is complete",
  repository: "The repository is in the list",
  event: "The event is in the list",
  "outside-input-event": "The event brings no input from outside",
  "head-repository": "The code is not from a fork",
  actor: "The account that started the run is trusted",
  "triggering-actor": "The account of this try is trusted",
});

/** This list has the rules of the policy, in the sequence of the checks. */
export const RULES: readonly RefusalRule[] = Object.freeze(Object.keys(RULE_LABELS) as RefusalRule[]);

/** This type is the result of one rule for one run. */
export interface RuleCheck {
  readonly rule: RefusalRule;
  readonly label: string;
  readonly passed: boolean;
  /** This list has the text of each refusal of the rule. */
  readonly reasons: readonly string[];
}

/** This function gives the result of each rule of the policy from a decision. */
export function checksOf(decision: Decision): readonly RuleCheck[] {
  return RULES.map((rule) => {
    const reasons = decision.refusals.filter((refusal) => refusal.rule === rule).map((refusal) => refusal.text);
    return { rule, label: RULE_LABELS[rule], passed: reasons.length === 0, reasons };
  });
}

/** This type is what the page shows for a run: the rules, the decision and each check. */
export interface Verdict {
  readonly rules: RulesRead;
  /** This field is `null` when the rules have a problem: then the dispatcher does not start. */
  readonly decision: Decision | null;
  readonly checks: readonly RuleCheck[];
}

/** This function decides a run with `decide`, from the text of the rules and the fields of the form. */
export function judge(rulesText: string, fields: RunFields): Verdict {
  const rules = readRules(rulesText);
  if (!rules.ok) return { rules, decision: null, checks: [] };
  const decision = decide(rules.rules, runOf(fields));
  return { rules, decision, checks: checksOf(decision) };
}

/** This record has the sample times of a machine, in seconds. */
export const SAMPLE_TIMES: MachineTimes = Object.freeze({
  make: 300,
  register: 120,
  idle: 600,
  job: 3600,
  retry: 30,
  retryMax: 480,
  pass: 30,
});

/** This type is one field of the times of a machine, with its note from the document `MACHINE_LIFECYCLE`. */
export interface TimeField {
  readonly key: keyof MachineTimes;
  readonly note: string;
}

/** This list has the fields of the times, in the sequence of the knobs of the document. */
export const TIME_FIELDS: readonly TimeField[] = Object.freeze(
  Object.values(MACHINE_LIFECYCLE.knobs).map((knob) => ({ key: knob.key as keyof MachineTimes, note: knob.note ?? knob.key })),
);

/** This function reads the times of the form with `parseMachineTimes`. */
export function readTimes(values: Readonly<Record<string, number>>): MachineTimesResult {
  return parseMachineTimes({ format: MACHINE_TIMES_FORMAT, ...values });
}

/** This type is one step of the life in the log of the demo. Each time is in milliseconds after the request. */
export interface LogLine {
  readonly at: number;
  readonly event: MachineEvent;
  readonly from: MachineState;
  readonly to: MachineState;
  readonly transition: string;
  readonly actions: readonly MachineAction[];
}

/** This type is the state of the demo of one machine. */
export interface Sim {
  readonly times: MachineTimes;
  readonly life: MachineLife;
  readonly log: readonly LogLine[];
}

/** This function starts the life of one machine at the time 0. */
export function startSim(times: MachineTimes): Sim {
  return { times, life: startLife(0), log: [] };
}

const step = (sim: Sim, event: MachineEvent, at: number): Sim | null => {
  const next = advance(sim.life, event, at);
  if (next === null) return null;
  const line: LogLine = { at, event, from: sim.life.state, to: next.life.state, transition: next.transition, actions: next.actions };
  return { times: sim.times, life: next.life, log: [...sim.log, line] };
};

/** This function gives the states that the life went through, with the present state. */
export function visited(sim: Sim): ReadonlySet<MachineState> {
  return new Set<MachineState>([MACHINE_STATES[0] ?? "asked", ...sim.log.map((line) => line.to)]);
}

/** This function gives the events from outside that the document takes in the present state. A timer is not one of them. */
export function choices(sim: Sim): readonly MachineEvent[] {
  return MACHINE_EVENTS.filter((event) => MACHINE_LIFECYCLE.events[event]?.kind !== "timer" && advance(sim.life, event, sim.life.at) !== null);
}

/** This function gives the wait of the timer of the present state, or `null` in the final state. */
export function timerOf(sim: Sim): MachineWait | null {
  return waitOf(sim.life.state, sim.times, sim.life.fired);
}

/** This type is the result of an event of the visitor. */
export interface Sent {
  readonly sim: Sim;
  /** This field is `true` when the timer of the state fired before the event. Then the event did not occur. */
  readonly timerFirst: boolean;
}

/**
 * This function applies an event of the visitor a delay after the last step.
 * When the wait of the timer ends before the event, the timer fires first, at the end of its wait, as `due` tells.
 *
 * @param sim - The state of the demo
 * @param event - The event from outside
 * @param delay - The time from the last step to the event, in milliseconds
 */
export function send(sim: Sim, event: MachineEvent, delay: number): Sent {
  const at = sim.life.at + Math.max(0, delay);
  const fired = due(sim.life, at, sim.times);
  const wait = timerOf(sim);
  if (fired !== null && wait !== null) {
    const next = step(sim, fired, sim.life.at + wait.low);
    if (next !== null) return { sim: next, timerFirst: true };
  }
  return { sim: step(sim, event, at) ?? sim, timerFirst: false };
}

/** This function lets the time pass until the timer of the present state fires. */
export function waitForTimer(sim: Sim): Sim {
  const wait = timerOf(sim);
  if (wait === null) return sim;
  return step(sim, wait.fires, sim.life.at + wait.low) ?? sim;
}

/** This function gives the longest times of the work of a machine, with `longestLife`. */
export function longest(sim: Sim): LongestLife {
  return longestLife(sim.times);
}

/** This function gives the note of a state, an event or a request from the document `MACHINE_LIFECYCLE`. */
export function noteOf(name: string): string {
  return MACHINE_LIFECYCLE.states[name]?.note ?? MACHINE_LIFECYCLE.events[name]?.note ?? "";
}

/** This function writes a time in milliseconds as hours, minutes and seconds, for example `1 h 5 min`. */
export function duration(ms: number): string {
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} h`);
  if (minutes > 0) parts.push(`${minutes} min`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds} s`);
  return parts.join(" ");
}
