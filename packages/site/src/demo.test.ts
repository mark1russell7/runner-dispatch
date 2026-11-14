import { decide, MACHINE_STATES, waitOf } from "@mark1russell7/runner-dispatch";
import { describe, expect, it } from "vitest";
import {
  checksOf,
  choices,
  duration,
  judge,
  longest,
  noteOf,
  readRules,
  readTimes,
  RULES,
  runOf,
  SAMPLE_RULES,
  SAMPLE_TIMES,
  SCENARIOS,
  send,
  startSim,
  TIME_FIELDS,
  timerOf,
  visited,
  waitForTimer,
} from "./demo.ts";

const RULES_TEXT = JSON.stringify(SAMPLE_RULES, null, 2);
const scenario = (id: string) => {
  const found = SCENARIOS.find((item) => item.id === id);
  if (found === undefined) throw new Error(`no scenario ${id}`);
  return found.run;
};
const refused = (id: string): string[] =>
  judge(RULES_TEXT, scenario(id))
    .checks.filter((check) => !check.passed)
    .map((check) => check.rule);

describe("the trust demo", () => {
  it("reads the sample rules", () => {
    expect(readRules(RULES_TEXT).ok).toBe(true);
  });

  it("gives the decision of decide for each sample run", () => {
    const read = readRules(RULES_TEXT);
    if (!read.ok) throw new Error("the sample rules have a problem");
    for (const { run } of SCENARIOS) {
      expect(judge(RULES_TEXT, run).decision).toEqual(decide(read.rules, runOf(run)));
    }
  });

  it("shows a different rule with each sample run", () => {
    expect(refused("push")).toEqual([]);
    expect(refused("fork")).toEqual(["head-repository", "actor", "triggering-actor"]);
    expect(refused("trusted-fork")).toEqual(["head-repository"]);
    expect(refused("target")).toEqual(["event", "outside-input-event"]);
    expect(refused("retry")).toEqual(["triggering-actor"]);
    expect(refused("other-repository")).toEqual(["repository"]);
  });

  it("gives each sample run a different id", () => {
    expect(new Set(SCENARIOS.map((item) => item.id)).size).toBe(SCENARIOS.length);
  });

  it("gives no decision when the rules have a problem", () => {
    const notJson = judge("{", scenario("push"));
    expect(notJson.decision).toBeNull();
    expect(notJson.rules).toEqual({ ok: false, problems: ["The text is not valid JSON."] });

    const target = JSON.stringify({ ...SAMPLE_RULES, events: ["push", "pull_request_target"] });
    const verdict = judge(target, scenario("push"));
    expect(verdict.decision).toBeNull();
    expect(verdict.checks).toEqual([]);
    expect(verdict.rules.ok).toBe(false);
  });

  it("writes an empty head repository as null", () => {
    expect(runOf({ ...scenario("push"), headRepository: "  " }).headRepository).toBeNull();
    expect(refused("push")).toEqual([]);
    const verdict = judge(RULES_TEXT, { ...scenario("push"), headRepository: "" });
    expect(verdict.checks.filter((check) => !check.passed).map((check) => check.rule)).toEqual(["head-repository"]);
  });

  it("refuses a try that is not a whole number with the rule record", () => {
    const verdict = judge(RULES_TEXT, { ...scenario("push"), attempt: 0 });
    expect(verdict.checks.find((check) => check.rule === "record")?.passed).toBe(false);
  });

  it("has one check for each rule, and each refusal is under its rule", () => {
    const decision = decide({ repositories: [], events: [], actors: [] }, runOf(scenario("fork")));
    const checks = checksOf(decision);
    expect(checks.map((check) => check.rule)).toEqual([...RULES]);
    expect(checks.flatMap((check) => check.reasons)).toEqual(
      RULES.flatMap((rule) => decision.refusals.filter((refusal) => refusal.rule === rule).map((refusal) => refusal.text)),
    );
    expect(checks.flatMap((check) => check.reasons)).toHaveLength(decision.refusals.length);
  });
});

describe("the life demo", () => {
  it("reads the sample times, and refuses a time of 0", () => {
    expect(readTimes({ ...SAMPLE_TIMES })).toEqual({ ok: true, times: SAMPLE_TIMES });
    expect(readTimes({ ...SAMPLE_TIMES, idle: 0 }).ok).toBe(false);
    expect(TIME_FIELDS.map((field) => field.key).sort()).toEqual(Object.keys(SAMPLE_TIMES).sort());
  });

  it("goes through each state of a life with a job", () => {
    let sim = startSim(SAMPLE_TIMES);
    for (const event of ["provider.made", "runner.registered", "job.started", "job.completed", "provider.destroyed"] as const) {
      expect(choices(sim)).toContain(event);
      sim = send(sim, event, 10_000).sim;
    }
    expect(sim.life.state).toBe("destroyed");
    expect([...visited(sim)]).toEqual([...MACHINE_STATES]);
    expect(sim.log.map((line) => line.at)).toEqual([10_000, 20_000, 30_000, 40_000, 50_000]);
    expect(sim.log.find((line) => line.transition === "completed")?.actions).toEqual(["provider.destroy"]);
    expect(timerOf(sim)).toBeNull();
    expect(choices(sim)).toEqual([]);
  });

  it("fires the timer first when the event comes after the end of its wait", () => {
    const sim = startSim(SAMPLE_TIMES);
    const sent = send(sim, "provider.made", 301_000);
    expect(sent.timerFirst).toBe(true);
    expect(sent.sim.life.state).toBe("done");
    expect(sent.sim.log).toEqual([
      { at: 300_000, event: "timer.make", from: "asked", to: "done", transition: "make-late", actions: ["provider.destroy"] },
    ]);
  });

  it("doubles the wait of the destroy timer at each firing, up to retryMax", () => {
    let sim = send(startSim(SAMPLE_TIMES), "stop", 0).sim;
    expect(sim.life.state).toBe("done");
    const waits: number[] = [];
    for (let index = 0; index < 6; index += 1) {
      waits.push(timerOf(sim)?.low ?? -1);
      sim = waitForTimer(sim);
    }
    expect(waits).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 480_000]);
    expect(sim.life.state).toBe("done");
    expect(waitOf("done", SAMPLE_TIMES, sim.life.fired)?.low).toBe(480_000);
  });

  it("does not change the life for an event that the state does not take", () => {
    const sim = startSim(SAMPLE_TIMES);
    expect(choices(sim)).not.toContain("job.started");
    expect(send(sim, "job.started", 0)).toEqual({ sim, timerFirst: false });
  });

  it("gives the longest times of the document", () => {
    const sim = startSim(SAMPLE_TIMES);
    const pass = SAMPLE_TIMES.pass * 1000;
    const bound = (seconds: number) => seconds * 1000 + pass;
    expect(longest(sim)).toEqual({
      withJob: bound(300) + bound(120) + bound(600) + bound(3600),
      withoutJob: bound(300) + bound(120) + bound(600),
    });
  });

  it("gives the notes of the document", () => {
    expect(noteOf("busy")).toBe("the runner does its one job");
    expect(noteOf("provider.destroy")).toBe("the dispatcher asks the provider to destroy the machine");
    expect(noteOf("no-such-name")).toBe("");
  });

  it("writes a time as hours, minutes and seconds", () => {
    expect(duration(0)).toBe("0 s");
    expect(duration(30_000)).toBe("30 s");
    expect(duration(330_000)).toBe("5 min 30 s");
    expect(duration(3_900_000)).toBe("1 h 5 min");
  });
});
