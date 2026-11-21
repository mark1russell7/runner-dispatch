import type { DispatchLife, MachineRecord, MachineState, PassReport } from "@mark1russell7/runner-dispatch";
import { createFolderProvider } from "@mark1russell7/runner-dispatch/folder";
import { countingSuffix, fakeFolders, fakeWorld, type FakeFolders, type FakeWorld } from "@mark1russell7/runner-dispatch/testing";
import { fakeClock, type FakeClock } from "@mark1russell7/service/testing";
import { describe, expect, it } from "vitest";
import { round, settled, type RoundOptions } from "./index.ts";
import { REPO } from "./fixtures.ts";

const TIMES = { make: 60, register: 60, idle: 30, job: 600, retry: 5, retryMax: 40, pass: 10 };
const SETTINGS = { prefix: "rd", capacity: 2, sizes: ["small"], standard: "small" };
const RULES = { repositories: [REPO], events: ["push"], actors: ["octo"] };

interface Setup {
  readonly clock: FakeClock;
  readonly world: FakeWorld;
  readonly folders: FakeFolders;
  readonly reports: PassReport[];
  readonly waits: number[];
  readonly options: RoundOptions;
}

/** This function gives a round on a fake world and a store of folders in memory. Each wait moves the fake clock. */
function setup(passes = 10, stop = false): Setup {
  const clock = fakeClock(0);
  const world = fakeWorld({ clock, times: { boot: 2000, connect: 1000, destroy: 500 } });
  const folders = fakeFolders();
  const reports: PassReport[] = [];
  const waits: number[] = [];
  const options: RoundOptions = {
    rules: RULES,
    times: TIMES,
    settings: SETTINGS,
    source: world.source,
    provider: createFolderProvider({ store: folders.store }),
    stopped: () => Promise.resolve(stop),
    onReport: (report) => reports.push(report),
    clock,
    suffix: countingSuffix(),
    passes,
    sleep: 5,
    wait: (ms) => {
      waits.push(ms);
      return clock.advance(ms);
    },
  };
  return { clock, world, folders, reports, waits, options };
}

const queued = (world: FakeWorld, runId = 100): void => {
  world.addRun(
    { repository: REPO, runId, runAttempt: 1, event: "push", headRepository: REPO, actor: "octo", triggeringActor: "octo" },
    [{ labels: [`run-${runId}-1`], duration: 4000 }],
  );
};

describe("round", () => {
  it("ends after the first pass when nothing waits", async () => {
    const at = setup();
    expect(await round(at.options, new AbortController().signal)).toEqual({ passes: 1, end: "settled", failures: 0 });
    expect(at.waits).toEqual([]);
  });

  it("makes the folder of a machine for a queued job, sleeps once, and ends on the next pass, with the machine in asked", async () => {
    const at = setup();
    queued(at.world);
    expect(await round(at.options, new AbortController().signal)).toEqual({ passes: 2, end: "settled", failures: 0 });
    expect(at.waits).toEqual([5000]);
    expect(at.reports[0]?.made.length).toBe(1);
    expect(at.reports[1]?.lives.map((each) => each.life.state)).toEqual(["asked"]);
    expect([...at.folders.tree().keys()]).toEqual([at.reports[0]?.made[0]?.name]);
  });

  it("adopts the machine of an earlier round, makes no second machine, and settles on the next pass", async () => {
    const at = setup();
    queued(at.world);
    await round(at.options, new AbortController().signal);
    const reports: PassReport[] = [];
    const options: RoundOptions = { ...at.options, onReport: (report) => reports.push(report), suffix: countingSuffix(1) };
    // An adoption changes the memory of the round, thus the pass is not settled. The next pass is quiet.
    expect(await round(options, new AbortController().signal)).toEqual({ passes: 2, end: "settled", failures: 0 });
    expect(reports[0]?.adopted.length).toBe(1);
    expect(reports.flatMap((report) => report.made)).toEqual([]);
    expect(at.folders.tree().size).toBe(1);
  });

  it("removes the folder of a runner that exited in the next round, then settles", async () => {
    const at = setup();
    queued(at.world);
    await round(at.options, new AbortController().signal);
    const name = [...at.folders.tree().keys()][0] ?? "";
    // The starter started the runner between the two rounds. The runner did its one job and exited, thus the view does not show the run.
    at.folders.put(name, "started", "{}");
    at.folders.drop(name, "configuration");
    at.folders.put(name, "exited", "{}");
    at.world.cancelRun({ repository: REPO, runId: 100, runAttempt: 1 });
    const reports: PassReport[] = [];
    const options: RoundOptions = { ...at.options, onReport: (report) => reports.push(report), suffix: countingSuffix(1) };
    // The first pass adopts the machine and destroys it. The second pass sees that the folder is not there. The third pass is quiet.
    expect(await round(options, new AbortController().signal)).toEqual({ passes: 3, end: "settled", failures: 0 });
    expect(reports.map((report) => report.steps.map((step) => `${step.from}>${step.to}`))).toEqual([["asked>done"], ["done>destroyed"], []]);
    expect(reports[0]?.destroys).toEqual([name]);
    expect(reports.flatMap((report) => report.made)).toEqual([]);
    expect(at.folders.tree().has(name)).toBe(false);
  });

  it("makes a new machine in the next round when the job of a runner that exited still waits", async () => {
    const at = setup();
    queued(at.world);
    await round(at.options, new AbortController().signal);
    const name = [...at.folders.tree().keys()][0] ?? "";
    at.folders.put(name, "started", "{}");
    at.folders.drop(name, "configuration");
    at.folders.put(name, "exited", "{}");
    const reports: PassReport[] = [];
    const options: RoundOptions = { ...at.options, onReport: (report) => reports.push(report), suffix: countingSuffix(1) };
    const result = await round(options, new AbortController().signal);
    expect(result.end).toBe("settled");
    expect(reports[0]?.destroys).toEqual([name]);
    expect(reports.flatMap((report) => report.made).length).toBe(1);
    expect(at.folders.tree().has(name)).toBe(false);
    expect(at.folders.tree().size).toBe(1);
  });

  it("ends at the count of passes when each pass fails, and counts the failed passes", async () => {
    const at = setup(4);
    at.folders.fail("folders");
    expect(await round(at.options, new AbortController().signal)).toEqual({ passes: 4, end: "bound", failures: 4 });
    expect(at.waits).toEqual([5000, 5000, 5000]);
  });

  it("does no pass for a signal that stopped, and ends during a sleep at the signal", async () => {
    const at = setup(10);
    expect(await round(at.options, AbortSignal.abort())).toEqual({ passes: 0, end: "signal", failures: 0 });
    const stop = new AbortController();
    at.folders.fail("folders");
    const options: RoundOptions = {
      ...at.options,
      wait: (_, signal) => {
        stop.abort();
        return signal.aborted ? Promise.reject(new Error("The wait stopped.")) : Promise.resolve();
      },
    };
    expect(await round(options, stop.signal)).toEqual({ passes: 1, end: "signal", failures: 1 });
  });

  it("refuses a count of passes or a sleep that is not valid", async () => {
    const at = setup();
    const signal = new AbortController().signal;
    await expect(round({ ...at.options, passes: 0 }, signal)).rejects.toThrow(RangeError);
    await expect(round({ ...at.options, passes: 1.5 }, signal)).rejects.toThrow(RangeError);
    await expect(round({ ...at.options, sleep: -1 }, signal)).rejects.toThrow(RangeError);
    await expect(round({ ...at.options, sleep: Number.NaN }, signal)).rejects.toThrow(RangeError);
  });
});

describe("settled", () => {
  const quiet = (over: Partial<PassReport> = {}): PassReport =>
    ({ stopped: false, cut: false, steps: [], adopted: [], destroys: [], removals: [], made: [], failures: [], lives: [], ...over }) as PassReport;

  it("is true for a quiet pass, also with the stop switch on", () => {
    expect(settled(quiet())).toBe(true);
    expect(settled(quiet({ stopped: true }))).toBe(true);
  });

  it("is false for a pass that did not read the stop switch, that the signal cut, or that changed something", () => {
    expect(settled(quiet({ stopped: null }))).toBe(false);
    expect(settled(quiet({ cut: true }))).toBe(false);
    for (const field of ["steps", "adopted", "destroys", "removals", "made", "failures"] as const) {
      expect(settled(quiet({ [field]: [{}] } as Partial<PassReport>))).toBe(false);
    }
  });

  it("is false while a machine is in a state other than asked", () => {
    const MACHINE: MachineRecord = { name: "rd-1", size: "small", repository: REPO, runId: 100, runAttempt: 1 };
    const life = (state: MachineState): DispatchLife => ({ machine: MACHINE, life: { state, at: 0, fired: 0 } });
    expect(settled(quiet({ lives: [life("asked")] }))).toBe(true);
    for (const state of ["made", "registered", "busy", "done"] as const) {
      expect(settled(quiet({ lives: [life("asked"), life(state)] }))).toBe(false);
    }
  });
});
