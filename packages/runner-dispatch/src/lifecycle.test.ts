import { algebraProblems, detection, firings, machineProblems, type KnobValues } from "@mark1russell7/algebra";
import { replay, type Transition } from "@mark1russell7/algebra/replay";
import { machineSchema } from "@mark1russell7/algebra/schema";
import { quantity } from "@mark1russell7/quantity";
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  advance,
  due,
  longestLife,
  MACHINE_ACTIONS,
  MACHINE_EVENTS,
  MACHINE_LIFECYCLE,
  MACHINE_STATES,
  MACHINE_TIME_MAX,
  MACHINE_TIMES_FORMAT,
  parseMachineTimes,
  startLife,
  waitOf,
  type MachineEvent,
  type MachineLife,
  type MachineState,
  type MachineTimes,
} from "./lifecycle.ts";

const DOC = MACHINE_LIFECYCLE;

// The second statement of the document: the state after each event, for each state. Each other event has no transition.
const NEXT: Readonly<Record<MachineState, Partial<Record<MachineEvent, MachineState>>>> = {
  asked: { "provider.made": "made", "provider.failed": "done", "job.none": "done", stop: "done", "timer.make": "done" },
  made: {
    "runner.registered": "registered",
    "provider.failed": "done",
    "job.none": "done",
    stop: "done",
    "timer.register": "done",
    "provider.destroyed": "destroyed",
  },
  registered: {
    "job.started": "busy",
    "provider.failed": "done",
    "job.none": "done",
    stop: "done",
    "timer.idle": "done",
    "provider.destroyed": "destroyed",
  },
  busy: { "job.completed": "done", "provider.failed": "done", stop: "done", "timer.job": "done", "provider.destroyed": "destroyed" },
  done: { "timer.destroy": "done", "provider.destroyed": "destroyed" },
  destroyed: {},
};

// The second statement of the timers: the timer of each state, and the field of the times that gives its wait.
const TIMER: Readonly<Record<Exclude<MachineState, "done" | "destroyed">, { timer: string; fires: MachineEvent; field: keyof MachineTimes }>> = {
  asked: { timer: "make", fires: "timer.make", field: "make" },
  made: { timer: "register", fires: "timer.register", field: "register" },
  registered: { timer: "idle", fires: "timer.idle", field: "idle" },
  busy: { timer: "job", fires: "timer.job", field: "job" },
};
const WORKING = ["asked", "made", "registered", "busy"] as const;

const TIMES: MachineTimes = { make: 300, register: 120, idle: 180, job: 21_600, retry: 5, retryMax: 300, pass: 10 };

const rank = (state: string): number => MACHINE_STATES.indexOf(state as MachineState);
const list = (value: string | readonly string[]): readonly string[] => (typeof value === "string" ? [value] : value);
const life = (state: MachineState, at = 0, fired = 0): MachineLife => ({ state, at, fired });

// Each time is a whole number of eighths of a second. Thus each time in milliseconds is exact.
const eighths = (min: number, max: number): fc.Arbitrary<number> => fc.integer({ min, max }).map((n) => n / 8);
const timesOf = (most: number, mostPass: number): fc.Arbitrary<MachineTimes> =>
  fc
    .record({
      make: eighths(1, most),
      register: eighths(1, most),
      idle: eighths(1, most),
      job: eighths(1, most * 4),
      retry: eighths(1, 80),
      more: eighths(0, most),
      pass: eighths(1, mostPass),
    })
    .map(({ more, ...times }) => ({ ...times, retryMax: times.retry + more }));
const times = timesOf(80_000, 80);
const state = fc.constantFrom(...MACHINE_STATES);

describe("the document of the life of a machine", () => {
  it("has no problem of consistency, and the schema and the algebra of its home accept it", () => {
    expect(machineProblems(DOC)).toEqual([]);
    expect(algebraProblems(DOC)).toEqual([]);
    expect(machineSchema.parse(DOC)).toEqual(DOC);
  });

  it("has the states, the events and the requests of the lists, with one first state and one final state", () => {
    expect(Object.keys(DOC.states)).toEqual([...MACHINE_STATES]);
    expect(MACHINE_STATES.filter((name) => DOC.states[name]?.initial === true)).toEqual(["asked"]);
    expect(MACHINE_STATES.filter((name) => DOC.states[name]?.final === true)).toEqual(["destroyed"]);
    expect(Object.keys(DOC.events).sort()).toEqual([...MACHINE_EVENTS, ...MACHINE_ACTIONS].sort());
    const kind = (wanted: string): string[] => Object.keys(DOC.events).filter((name) => DOC.events[name]?.kind === wanted);
    expect(kind("tx")).toEqual([...MACHINE_ACTIONS]);
    expect(kind("app")).toEqual(["stop"]);
    expect(kind("rx")).toEqual(MACHINE_EVENTS.filter((name) => !name.startsWith("timer.") && name !== "stop"));
    expect(kind("timer")).toEqual(MACHINE_EVENTS.filter((name) => name.startsWith("timer.")));
    expect(kind("timer").sort()).toEqual(Object.values(DOC.timers).map((timer) => timer.fires).sort());
  });

  it("cannot change: each part is frozen", () => {
    const parts: unknown[] = [DOC, DOC.states, DOC.states["asked"], DOC.events, DOC.knobs, DOC.knobs["pass"], DOC.timers];
    parts.push(DOC.timers["destroy"], DOC.timers["destroy"]?.arms, DOC.timers["destroy"]?.backoff, DOC.transitions);
    parts.push(DOC.transitions[4], DOC.transitions[4]?.from, DOC.transitions[4]?.emits, DOC.sources[0]);
    parts.push(MACHINE_STATES, MACHINE_EVENTS, MACHINE_ACTIONS);
    for (const part of parts) expect(Object.isFrozen(part)).toBe(true);
    expect(parts.every((part) => typeof part === "object" && part !== null)).toBe(true);
  });

  it("has one transition at most from each state on each event", () => {
    for (const from of MACHINE_STATES) {
      for (const on of MACHINE_EVENTS) {
        const found = DOC.transitions.filter((each) => list(each.from).includes(from) && list(each.on).includes(on));
        expect(found.length, `${from} on ${on}`).toBeLessThanOrEqual(1);
      }
    }
    expect(DOC.transitions.every((each) => list(each.from).every((from) => from !== "*"))).toBe(true);
  });

  it("agrees with a second statement of each state and each event", () => {
    for (const from of MACHINE_STATES) {
      for (const on of MACHINE_EVENTS) {
        const step = advance(life(from), on, 1);
        expect(step?.life.state ?? null, `${from} on ${on}`).toBe(NEXT[from][on] ?? null);
      }
    }
  });

  it("goes forward: only the retry of the destroy request stays in its state", () => {
    for (const each of DOC.transitions) {
      for (const from of list(each.from)) {
        if (each.id === "destroy-again") expect([from, each.to]).toEqual(["done", "done"]);
        else expect(rank(each.to), each.id).toBeGreaterThan(rank(from));
      }
    }
  });

  it("ends each path in the state destroyed", () => {
    const paths: MachineState[][] = [];
    const walk = (path: MachineState[]): void => {
      const from = path[path.length - 1] ?? "asked";
      const next = [...new Set(MACHINE_EVENTS.map((on) => NEXT[from][on]))].filter(
        (to): to is MachineState => to !== undefined && to !== from,
      );
      if (next.length === 0) paths.push(path);
      for (const to of next) walk([...path, to]);
    };
    walk(["asked"]);
    // 4 paths go through done: from asked, from made, from registered and from busy. 3 paths lose the machine before done.
    expect(paths.length).toBe(7);
    for (const path of paths) expect(path[path.length - 1]).toBe("destroyed");
    expect(paths.filter((path) => path.includes("done")).length).toBe(4);
    expect(Object.keys(NEXT.destroyed)).toEqual([]);
  });

  it("gives each state that is not final one timer, which starts at the entry and leaves the state", () => {
    for (const name of MACHINE_STATES) {
      const armed = Object.entries(DOC.timers).filter(([, timer]) => timer.arms.includes(`enter:${name}`));
      if (name === "destroyed") {
        expect(armed).toEqual([]);
        continue;
      }
      expect(armed.length, name).toBe(1);
      const [id, timer] = armed[0] ?? ["", undefined];
      expect(timer?.arms).toEqual([`enter:${name}`]);
      const taken = DOC.transitions.filter((each) => list(each.on).includes(timer?.fires ?? ""));
      expect(taken.length, id).toBe(1);
      expect(taken[0]?.timer).toBe(id);
      expect(list(taken[0]?.from ?? [])).toEqual([name]);
      expect(taken[0]?.to).toBe("done");
      expect(timer?.backoff === undefined).toBe(name !== "done");
      if (name === "done") expect(timer?.backoff?.resets).toEqual(["enter:done"]);
      // Each other event that leaves the state cancels the timer.
      const leaves = MACHINE_EVENTS.filter((on) => NEXT[name][on] !== undefined && on !== timer?.fires);
      expect([...(timer?.cancels ?? [])].sort(), id).toEqual([...leaves].sort());
      expect(timer?.lateness).toEqual({ knob: "pass", unit: "s" });
    }
    expect(Object.keys(DOC.timers).length).toBe(MACHINE_STATES.length - 1);
  });

  it("asks the provider to destroy the machine at each entry to done, and at each retry", () => {
    for (const each of DOC.transitions) {
      expect(each.emits ?? [], each.id).toEqual(each.to === "done" ? ["provider.destroy"] : []);
    }
    for (const from of MACHINE_STATES) {
      for (const on of MACHINE_EVENTS) {
        const step = advance(life(from), on, 1);
        if (step !== null) expect(step.actions, `${from} on ${on}`).toEqual(step.life.state === "done" ? ["provider.destroy"] : []);
      }
    }
  });

  it("names each knob by a field of the times", () => {
    const keys = Object.values(DOC.knobs).map((knob) => knob.key);
    expect(keys.sort()).toEqual(Object.keys(TIMES).sort());
    expect(Object.values(DOC.knobs).every((knob) => knob.unit === "s" && knob.default === null)).toBe(true);
  });

  it("ends each working state by its timer when nothing answers, by the detection of the algebra", () => {
    const values: KnobValues = (name) => {
      const key = DOC.knobs[name]?.key as keyof MachineTimes | undefined;
      return key === undefined ? undefined : quantity(TIMES[key], "s");
    };
    const silence = { name: "silence", passes: [] };
    for (const name of WORKING) {
      const found = detection(DOC, { state: name, inFlight: false }, silence, values);
      expect(found.detectors.map((each) => each.timer)).toEqual([TIMER[name].timer]);
      expect(found.first?.fires).toBe(TIMER[name].fires);
      expect(found.first?.duration).toEqual({ value: TIMES[TIMER[name].field], unit: "s" });
      expect(found.unsettled).toEqual([]);
    }
    // The retry in done is a backoff. It gives up at no time, thus the algebra finds no timer that ends the state.
    expect(detection(DOC, { state: "done", inFlight: false }, silence, values).first).toBe(null);
    const asks = firings(DOC, "destroy", values, { count: 8 }).map((each) => each.at.value);
    expect(asks).toEqual([5, 15, 35, 75, 155, 315, 615, 915]);
  });
});

describe("the times of a machine", () => {
  const document = { format: MACHINE_TIMES_FORMAT, ...TIMES };

  it("reads a document, and gives frozen times with only the known fields", () => {
    const result = parseMachineTimes(document);
    expect(result).toEqual({ ok: true, times: TIMES });
    expect(result.ok && Object.isFrozen(result.times)).toBe(true);
    expect(parseMachineTimes(JSON.parse(JSON.stringify(document)))).toEqual({ ok: true, times: TIMES });
    expect(parseMachineTimes({ ...document, retryMax: 5, pass: 0.125, job: MACHINE_TIME_MAX }).ok).toBe(true);
  });

  it("gives the problems of a document that is not valid", () => {
    const problems = (value: unknown): readonly string[] => {
      const result = parseMachineTimes(value);
      return result.ok ? [] : result.problems;
    };
    for (const value of [null, undefined, 5, "times", [], [document]]) {
      expect(problems(value)).toEqual(["The document is not an object."]);
    }
    expect(problems({ ...TIMES })).toEqual([`The field format is not "machine-times/1".`]);
    expect(problems({ ...document, format: "machine-times/2" })).toEqual([`The field format is not "machine-times/1".`]);
    expect(problems({ ...document, tick: 5 })).toEqual([`The document has the unknown field "tick".`]);
    expect(problems({ ...document, retryMax: 4.5 })).toEqual(["The field retryMax is less than the field retry."]);
    for (const key of Object.keys(TIMES)) {
      const { [key]: _removed, ...rest } = document as Record<string, unknown>;
      expect(problems(rest).length, `no ${key}`).toBe(1);
      expect(problems(rest)[0]).toContain(`The field ${key} is not a number of seconds above 0`);
      for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, MACHINE_TIME_MAX + 1, "5", null, [5], { value: 5 }, true]) {
        const found = problems({ ...document, [key]: bad });
        expect(found.length, `${key} = ${String(bad)}`).toBe(1);
        expect(found[0]).toContain(`The field ${key} is not a number of seconds above 0 and not above 31536000: `);
      }
    }
    expect(problems({ format: "x", make: 0, more: 1 }).length).toBe(9);
  });

  it("does not throw, for a value of each type", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        const result = parseMachineTimes(value);
        expect(result.ok ? result.times.pass > 0 : result.problems.length > 0).toBe(true);
      }),
    );
  });

  it("accepts each record of times that the tests make, and the functions refuse each other record", () => {
    fc.assert(
      fc.property(times, (valid) => {
        expect(parseMachineTimes({ format: MACHINE_TIMES_FORMAT, ...valid })).toEqual({ ok: true, times: valid });
      }),
    );
    const bad = fc.constantFrom<unknown>(0, -1, Number.NaN, Number.POSITIVE_INFINITY, MACHINE_TIME_MAX + 1, "5", null, undefined);
    const key = fc.constantFrom(...(Object.keys(TIMES) as (keyof MachineTimes)[]));
    fc.assert(
      fc.property(times, key, bad, state, (valid, field, value, at) => {
        const changed = { ...valid, [field]: value } as MachineTimes;
        expect(() => waitOf(at, changed)).toThrow(RangeError);
        expect(() => due(life(at), 5, changed)).toThrow(RangeError);
        expect(() => longestLife(changed)).toThrow(RangeError);
      }),
    );
    const less = { ...TIMES, retryMax: 4 };
    expect(() => waitOf("destroyed", less)).toThrow(RangeError);
    expect(() => waitOf("asked", null as unknown as MachineTimes)).toThrow(RangeError);
    for (const fired of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => waitOf("done", TIMES, fired)).toThrow(RangeError);
      expect(() => waitOf("done", TIMES, fired)).toThrow("The count of the firings of a timer is a whole number from 0.");
    }
  });
});

describe("the life of a machine", () => {
  it("starts in the state asked, at the time of the request", () => {
    expect(startLife(1234)).toEqual({ state: "asked", at: 1234, fired: 0 });
  });

  it("goes through each state of a machine that does its job", () => {
    const events: MachineEvent[] = ["provider.made", "runner.registered", "job.started", "job.completed", "provider.destroyed"];
    let now = startLife(0);
    const seen: string[] = [];
    events.forEach((on, index) => {
      const step = advance(now, on, (index + 1) * 1000);
      if (step === null) throw new Error(`no transition on ${on}`);
      seen.push(`${step.transition}: ${step.life.state} at ${step.life.at}, ${step.actions.join(" ")}`);
      now = step.life;
    });
    expect(seen).toEqual([
      "made: made at 1000, ",
      "registered: registered at 2000, ",
      "started: busy at 3000, ",
      "completed: done at 4000, provider.destroy",
      "destroyed: destroyed at 5000, ",
    ]);
  });

  it("counts the firings of a timer that stays in its state, and starts the count again at each entry", () => {
    const first = advance(life("busy", 0, 0), "job.completed", 10);
    expect(first?.life).toEqual({ state: "done", at: 10, fired: 0 });
    const second = advance(life("done", 10, 0), "timer.destroy", 20);
    expect(second).toEqual({ life: { state: "done", at: 20, fired: 1 }, transition: "destroy-again", actions: ["provider.destroy"] });
    expect(advance(life("done", 20, 6), "timer.destroy", 30)?.life).toEqual({ state: "done", at: 30, fired: 7 });
    expect(advance(life("done", 30, 7), "provider.destroyed", 40)?.life).toEqual({ state: "destroyed", at: 40, fired: 0 });
  });

  it("gives null for an event that the state does not take, and for a text that is not an event", () => {
    expect(advance(life("destroyed"), "provider.destroyed", 1)).toBe(null);
    expect(advance(life("done"), "stop", 1)).toBe(null);
    expect(advance(life("busy"), "job.none", 1)).toBe(null);
    expect(advance(life("asked"), "provider.destroyed", 1)).toBe(null);
    expect(advance(life("asked"), "provider.destroy" as MachineEvent, 1)).toBe(null);
    expect(advance(life("asked"), "constructor" as MachineEvent, 1)).toBe(null);
    expect(advance(life("unknown" as MachineState), "stop", 1)).toBe(null);
  });

  it("gives the wait of each working state: its time, and one pass more", () => {
    fc.assert(
      fc.property(times, fc.constantFrom(...WORKING), fc.nat(50), (valid, name, fired) => {
        const low = valid[TIMER[name].field] * 1000;
        const wait = { timer: TIMER[name].timer, fires: TIMER[name].fires, low, high: low + valid.pass * 1000 };
        expect(waitOf(name, valid)).toEqual(wait);
        expect(waitOf(name, valid, fired)).toEqual(wait);
        expect(waitOf("destroyed", valid, fired)).toBe(null);
      }),
    );
  });

  it("gives the waits of the state done: each is two times the wait before it, to the longest wait", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 40, 5000].map((fired) => waitOf("done", TIMES, fired)?.low)).toEqual([
      5000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000, 300_000,
    ]);
    fc.assert(
      fc.property(times, fc.nat(60), (valid, fired) => {
        const wait = waitOf("done", valid, fired);
        const low = Math.min(valid.retry * 2 ** Math.min(fired, 32), valid.retryMax) * 1000;
        expect(wait).toEqual({ timer: "destroy", fires: "timer.destroy", low, high: low + valid.pass * 1000 });
        expect(waitOf("done", valid, fired + 1)?.low).toBeGreaterThanOrEqual(low);
      }),
    );
  });

  it("fires the timer of a state at the end of its wait, and not before", () => {
    fc.assert(
      fc.property(times, state, fc.nat(40), fc.integer({ min: 0, max: 10 ** 9 }), (valid, name, fired, at) => {
        const now = life(name, at, name === "done" ? fired : 0);
        const wait = waitOf(name, valid, now.fired);
        if (wait === null) {
          expect(due(now, at + 10 ** 12, valid)).toBe(null);
          return;
        }
        expect(due(now, at, valid)).toBe(null);
        expect(due(now, at + wait.low - 0.5, valid)).toBe(null);
        expect(due(now, at + wait.low, valid)).toBe(wait.fires);
        expect(due(now, at + wait.high + 10 ** 9, valid)).toBe(wait.fires);
        // The document has a transition for the event of the timer, from the state of the timer.
        expect(advance(now, wait.fires, at + wait.low)?.life.state).toBe("done");
      }),
    );
  });

  it("gives the longest life as the sum of the times of the working states, each one pass late", () => {
    expect(longestLife(TIMES)).toEqual({ withJob: (300 + 120 + 180 + 21_600 + 40) * 1000, withoutJob: (300 + 120 + 180 + 30) * 1000 });
    fc.assert(
      fc.property(times, (valid) => {
        const { make, register, idle, job, pass } = valid;
        expect(longestLife(valid)).toEqual({
          withJob: (make + register + idle + job + 4 * pass) * 1000,
          withoutJob: (make + register + idle + 3 * pass) * 1000,
        });
      }),
    );
  });
});

describe("a loop that follows the document", () => {
  const OUTSIDE = MACHINE_EVENTS.filter((name) => !name.startsWith("timer."));
  // The report that takes a machine to the next state of a life with a job.
  const MAIN: Readonly<Record<MachineState, MachineEvent>> = {
    asked: "provider.made",
    made: "runner.registered",
    registered: "job.started",
    busy: "job.completed",
    done: "provider.destroyed",
    destroyed: "provider.destroyed",
  };
  // The times of a machine are some passes long. Thus the runs have reports before a timer, and timers before a report.
  const short = timesOf(160, 16);
  // One pass of the loop: the time after the pass before it, in eighths of the longest time, and a number for its report.
  const pass = fc.record({ gap: fc.integer({ min: 1, max: 8 }), report: fc.integer({ min: 0, max: 99 }) });

  /**
   * This function gives the report of a pass from its number. Half of the passes have no report. One pass in four
   * has the report of the main path. The other passes have a report that the state takes, or a report of any kind.
   */
  const reportOf = (at: MachineState, n: number): MachineEvent | null => {
    if (n < 50) return null;
    if (n < 75) return MAIN[at];
    const takes = OUTSIDE.filter((on) => NEXT[at][on] !== undefined);
    if (n < 90 && takes.length > 0) return takes[n % takes.length] ?? null;
    return OUTSIDE[n % OUTSIDE.length] ?? null;
  };

  /** This function runs a loop: at each pass it applies the report, then the timer of the state when its wait ended. */
  const run = (valid: MachineTimes, passes: readonly { gap: number; report: number }[]): { trace: Transition[]; now: number; end: MachineLife } => {
    const trace: Transition[] = [];
    let now = 0;
    let at = startLife(now);
    const apply = (on: MachineEvent): void => {
      const step = advance(at, on, now);
      if (step === null) return;
      trace.push({ machine: DOC.id, instance: "machine-1", from: at.state, on, to: step.life.state, at: now });
      at = step.life;
    };
    for (const each of passes) {
      now += (each.gap / 8) * valid.pass * 1000;
      const report = reportOf(at.state, each.report);
      if (report !== null) apply(report);
      const timer = due(at, now, valid);
      if (timer !== null) apply(timer);
    }
    return { trace, now, end: at };
  };

  it("makes only the transitions of the document, and ends the work of a machine in the longest life", () => {
    fc.assert(
      fc.property(short, fc.array(pass, { maxLength: 300 }), (valid, passes) => {
        const { trace, now, end } = run(valid, passes);
        expect(replay(DOC, trace, { machine: DOC.id })).toEqual([]);
        for (const each of trace) {
          expect(rank(each.to)).toBeGreaterThanOrEqual(rank(each.from));
          if (each.from === each.to) expect(each.on).toBe("timer.destroy");
        }
        const longest = longestLife(valid);
        const ended = trace.find((each) => rank(each.to) >= rank("done"));
        const worked = trace.some((each) => each.to === "busy");
        if (ended !== undefined) expect(ended.at).toBeLessThanOrEqual(worked ? longest.withJob : longest.withoutJob);
        // No machine stays in a working state after the longest life.
        if (now >= longest.withJob) expect(rank(end.state)).toBeGreaterThanOrEqual(rank("done"));
        if (now >= longest.withoutJob && !worked) expect(rank(end.state)).toBeGreaterThanOrEqual(rank("done"));
        // In done, the loop asks again after each wait of the document, and it sees each firing in one pass.
        const asks = trace.filter((each) => each.from === "done" && each.on === "timer.destroy");
        const entry = trace.find((each) => each.to === "done" && each.from !== "done");
        let before = entry?.at ?? 0;
        asks.forEach((ask, fired) => {
          const wait = waitOf("done", valid, fired);
          expect((ask.at ?? 0) - before).toBeGreaterThanOrEqual(wait?.low ?? 0);
          expect((ask.at ?? 0) - before).toBeLessThan(wait?.high ?? 0);
          before = ask.at ?? 0;
        });
        if (end.state === "destroyed") expect(trace[trace.length - 1]?.on).toBe("provider.destroyed");
      }),
      { numRuns: 300 },
    );
  });

  it("destroys a machine that gets no answer: the timer of the first state fires, then the loop asks again and again", () => {
    const passes = Array.from({ length: 160 }, () => ({ gap: 8, report: 0 }));
    const { trace, end } = run(TIMES, passes);
    expect(trace.map((each) => `${each.on} at ${(each.at ?? 0) / 1000}`)).toEqual([
      "timer.make at 300",
      "timer.destroy at 310",
      "timer.destroy at 320",
      "timer.destroy at 340",
      "timer.destroy at 380",
      "timer.destroy at 460",
      "timer.destroy at 620",
      "timer.destroy at 920",
      "timer.destroy at 1220",
      "timer.destroy at 1520",
    ]);
    expect(end).toEqual({ state: "done", at: 1_520_000, fired: 9 });
  });

  it("covers each state and each transition of the document in the runs of the property", () => {
    const seen = new Set<string>();
    fc.assert(
      fc.property(short, fc.array(pass, { maxLength: 300 }), (valid, passes) => {
        for (const each of run(valid, passes).trace) seen.add(`${each.from} ${each.on} ${each.to}`);
      }),
      { numRuns: 2000, seed: 20261110 },
    );
    const all = MACHINE_STATES.flatMap((from) => MACHINE_EVENTS.flatMap((on) => (NEXT[from][on] === undefined ? [] : [`${from} ${on} ${NEXT[from][on]}`])));
    expect([...seen].sort()).toEqual(all.sort());
  });
});

describe("the README of the package", () => {
  const README = readFileSync(new URL("../README.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const LINES = README.split("\n");

  /** This function gives the rows of the table of the README that has a header line, each as its cells. */
  const table = (header: string): string[][] => {
    const start = LINES.indexOf(header);
    expect(start, header).toBeGreaterThan(-1);
    const rows: string[][] = [];
    for (const line of LINES.slice(start + 2)) {
      if (!line.startsWith("|")) break;
      rows.push(line.split("|").slice(1, -1).map((cell) => cell.trim()));
    }
    return rows;
  };
  /** This function gives the names in code font of a cell. */
  const names = (cell: string | undefined): string[] => [...(cell ?? "").matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");
  /** This function makes a sentence from a note of the document. */
  const sentence = (note: string | undefined): string => `${(note ?? "").charAt(0).toUpperCase()}${(note ?? "").slice(1)}.`;
  /** This function writes a number of milliseconds as the code examples write it. */
  const ms = (value: number): string => value.toLocaleString("en-US").replaceAll(",", "_");

  it("has the states of the document, each with its note", () => {
    expect(table("| State | Meaning |")).toEqual(MACHINE_STATES.map((name) => [`\`${name}\``, sentence(DOC.states[name]?.note)]));
  });

  it("has each transition of the document: its states, its event and its request", () => {
    const rows = table("| Transition | From | Event | To | Request |").map((row) => row.map(names));
    expect(rows).toEqual(DOC.transitions.map((each) => [[each.id], [...list(each.from)], [each.on], [each.to], [...(each.emits ?? [])]]));
  });

  it("has a diagram with each step between two states of the document", () => {
    const block = /```mermaid\nstateDiagram-v2\n([\s\S]*?)\n```/.exec(README)?.[1] ?? "";
    const drawn = block.split("\n").map((line) => line.trim());
    const steps = new Set(DOC.transitions.flatMap((each) => list(each.from).map((from) => `${from} --> ${each.to}`)));
    expect([...drawn].sort()).toEqual(["[*] --> asked", ...steps, "destroyed --> [*]"].sort());
  });

  it("has the timer of each state, with its wait and its event", () => {
    const wanted = MACHINE_STATES.filter((name) => DOC.states[name]?.final !== true).map((name) => {
      const timer = Object.keys(DOC.timers).find((each) => DOC.timers[each]?.arms.includes(`enter:${name}`)) ?? "";
      const duration = DOC.timers[timer]?.duration ?? { const: 0, unit: "s" };
      const wait = "knob" in duration ? DOC.knobs[duration.knob]?.key : "expr" in duration ? duration.expr : undefined;
      return [[name], [timer], [wait], [DOC.timers[timer]?.fires]];
    });
    expect(table("| State | Timer | Wait | Event |").map((row) => row.map(names))).toEqual(wanted);
  });

  it("has each field of the times with the note of its knob, and an example that the parser reads", () => {
    const rows = table("| Field | Meaning |");
    expect(rows.map((row) => names(row[0]))).toEqual(Object.values(DOC.knobs).map((knob) => [knob.key]));
    for (const [index, knob] of Object.values(DOC.knobs).entries()) {
      expect(rows[index]?.[1]?.startsWith(sentence(knob.note)), knob.key).toBe(true);
    }
    const example = /```json\n(\{\n {2}"format": "machine-times\/1",[\s\S]*?\n\})\n```/.exec(README)?.[1] ?? "";
    expect(parseMachineTimes(JSON.parse(example))).toEqual({ ok: true, times: TIMES });
    expect(README).toContain(`not above ${MACHINE_TIME_MAX.toLocaleString("en-US").replaceAll(",", " ")}, which is ${MACHINE_TIME_MAX / 86_400} days`);
  });

  it("has a code example with the results of the functions", () => {
    const made = advance(startLife(0), "provider.made", 40_000)?.life ?? startLife(0);
    expect(README).toContain(`// life is { state: "${made.state}", at: ${ms(made.at)}, fired: ${made.fired} }.`);
    const event = due(made, 170_000, TIMES);
    expect(README).toContain(`// event is "${event}": the machine is in "made" for 130 s, and the time register is ${TIMES.register} s.`);
    const step = advance(made, event ?? "stop", 170_000);
    expect(README).toContain(
      `// step.transition is "${step?.transition}", step.life.state is "${step?.life.state}", and step.actions is ${JSON.stringify(step?.actions)}.`,
    );
    const wait = waitOf("done", TIMES, 3);
    expect(README).toContain(
      `// { timer: "${wait?.timer}", fires: "${wait?.fires}", low: ${ms(wait?.low ?? 0)}, high: ${ms(wait?.high ?? 0)} }: the fourth wait of the state done.`,
    );
    const longest = longestLife(TIMES);
    expect(README).toContain(`// { withJob: ${ms(longest.withJob)}, withoutJob: ${ms(longest.withoutJob)} }`);
  });

  it("has the two formulas of the longest life", () => {
    const sum = (expr: string): number =>
      expr.split(" + ").reduce((total, part) => {
        const [count, name] = part.includes(" * ") ? part.split(" * ") : ["1", part];
        return total + Number(count) * TIMES[name as keyof MachineTimes] * 1000;
      }, 0);
    const rows = table("| Machine | Longest time |").map((row) => sum(names(row[1])[0] ?? ""));
    expect(rows).toEqual([longestLife(TIMES).withJob, longestLife(TIMES).withoutJob]);
  });
});
