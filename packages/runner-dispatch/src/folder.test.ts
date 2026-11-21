import { fakeClock } from "@mark1russell7/algebra/clock";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { checkSettingsDocument, parseCheckSettings, type CheckSettings } from "./check.ts";
import { createDispatcher } from "./dispatcher.ts";
import { createFolderProvider, FOLDER_FILES, folderStatus, isFolderName, type FolderStore } from "./folder.ts";
import type { MachineTimes } from "./lifecycle.ts";
import type { TrustRules } from "./policy.ts";
import type { MachineProvider, StopSignal } from "./ports.ts";
import { machineDescription, parseMachineDescription } from "./proxmox.ts";
import type { MachineRecord, RunRecord } from "./records.ts";
import type { DispatchSettings } from "./settings.ts";
import { countingSuffix, fakeFolders, fakeWorld, type FakeFolders } from "./testing.ts";

const SIGNAL: StopSignal = { aborted: false };
const RULES: TrustRules = { repositories: ["octo/app"], events: ["push"], actors: ["octo"] };
const SECRET = "jit-configuration-SECRET-7f3a";

const record = (name: string, runId = 42): MachineRecord => ({ name, size: "small", repository: "octo/app", runId, runAttempt: 1 });
const settingsOf = (machine: MachineRecord): CheckSettings => ({
  rules: RULES,
  run: { repository: machine.repository, runId: machine.runId, runAttempt: machine.runAttempt },
});

interface Setup {
  readonly folders: FakeFolders;
  readonly provider: MachineProvider;
  readonly problems: string[];
}

function setup(): Setup {
  const folders = fakeFolders();
  const problems: string[] = [];
  const provider = createFolderProvider({ store: folders.store, problem: (text) => problems.push(text) });
  return { folders, provider, problems };
}

const make = (provider: MachineProvider, machine: MachineRecord, configuration = SECRET): Promise<void> =>
  provider.make({ machine, configuration, check: settingsOf(machine) }, SIGNAL);

describe("isFolderName", () => {
  it("accepts the name of a machine and refuses a path, a dot, a capital letter and a long name", () => {
    expect(isFolderName("rd-42-1-00000000")).toBe(true);
    expect(isFolderName("a")).toBe(true);
    for (const name of ["", ".", "..", "a/b", "a\\b", "../a", "A1", "1a", "a-", `a${"b".repeat(63)}`, 5, null]) expect(isFolderName(name)).toBe(false);
  });
});

describe("folderStatus", () => {
  it("gives the status from the marks: exited, then started, then the configuration", () => {
    const marks = [FOLDER_FILES.configuration, FOLDER_FILES.started, FOLDER_FILES.exited, FOLDER_FILES.stop, FOLDER_FILES.machine, FOLDER_FILES.check];
    fc.assert(
      fc.property(fc.subarray(marks), (files) => {
        const expected = files.includes("exited") ? "stopped" : files.includes("started") ? "operating" : files.includes("configuration") ? "making" : "stopped";
        expect(folderStatus(files)).toBe(expected);
      }),
    );
  });
});

describe("createFolderProvider", () => {
  it("refuses a store with no method, and names each method that it does not have", () => {
    expect(() => createFolderProvider({ store: {} as FolderStore })).toThrow(/folders, files, read, write, remove/);
    expect(() => createFolderProvider(null as never)).toThrow(RangeError);
  });

  it("writes the record, the settings of the check and then the configuration, into the folder of the machine", async () => {
    const { folders, provider } = setup();
    const machine = record("rd-42-1-00000000");
    await make(provider, machine);
    expect(folders.changes()).toEqual([
      { kind: "write", folder: machine.name, file: "machine.json" },
      { kind: "write", folder: machine.name, file: "check.json" },
      { kind: "write", folder: machine.name, file: "configuration" },
    ]);
    const files = folders.tree().get(machine.name);
    expect(parseMachineDescription(files?.get("machine.json")?.trim())).toEqual(machine);
    expect(files?.get("machine.json")).toBe(`${machineDescription(machine)}\n`);
    const check = parseCheckSettings(JSON.parse(files?.get("check.json") ?? "null"));
    expect(check).toEqual({ ok: true, settings: settingsOf(machine) });
    expect(JSON.parse(files?.get("check.json") ?? "null")).toEqual(checkSettingsDocument(settingsOf(machine)));
    expect(files?.get("configuration")).toBe(SECRET);
  });

  it("refuses a folder that is there, a record that is not valid and an empty configuration, and writes nothing for them", async () => {
    const { folders, provider } = setup();
    folders.put("rd-42-1-00000000", "note", "x");
    await expect(make(provider, record("rd-42-1-00000000"))).rejects.toThrow(/is there/);
    await expect(make(provider, record("Bad Name"))).rejects.toThrow(RangeError);
    await expect(make(provider, record("rd-42-1-00000001"), "")).rejects.toThrow(/configuration of the machine rd-42-1-00000001 is empty/);
    expect(folders.changes()).toEqual([]);
  });

  it("lists each machine with the status of its marks, and moves with the starter", async () => {
    const { folders, provider } = setup();
    const machine = record("rd-42-1-00000000");
    await make(provider, machine);
    expect(await provider.machines(SIGNAL)).toEqual([{ machine, status: "making" }]);
    folders.put(machine.name, "started", "{}");
    folders.drop(machine.name, "configuration");
    expect(await provider.machines(SIGNAL)).toEqual([{ machine, status: "operating" }]);
    folders.put(machine.name, "exited", "{}");
    expect(await provider.machines(SIGNAL)).toEqual([{ machine, status: "stopped" }]);
  });

  it("shows a folder with a record and no configuration as stopped: it cannot operate", async () => {
    const { folders, provider } = setup();
    const machine = record("rd-42-1-00000000");
    folders.put(machine.name, "machine.json", machineDescription(machine));
    expect(await provider.machines(SIGNAL)).toEqual([{ machine, status: "stopped" }]);
  });

  it("does not list a folder with no record of its machine, and tells each such folder one time", async () => {
    const { folders, provider, problems } = setup();
    folders.put("Foreign", "x", "1");
    folders.put("rd-1-1-00000000", "notes", "1");
    folders.put("rd-2-1-00000000", "machine.json", "not json");
    folders.put("rd-3-1-00000000", "machine.json", machineDescription(record("rd-9-1-00000000")));
    folders.put("rd-4-1-00000000", "started", "{}");
    folders.drop("rd-4-1-00000000", "started");
    expect(await provider.machines(SIGNAL)).toEqual([]);
    expect(await provider.machines(SIGNAL)).toEqual([]);
    expect(problems).toHaveLength(4);
    expect(problems.join(" ")).toMatch(/"Foreign" does not have the name of a machine/);
    expect(problems.filter((text) => /has no record of a machine with its name/.test(text))).toHaveLength(3);
  });

  it("removes the folder of a machine that the starter did not start, or that exited", async () => {
    const { folders, provider } = setup();
    const waiting = record("rd-42-1-00000000");
    const ended = record("rd-42-1-00000001");
    await make(provider, waiting);
    await make(provider, ended);
    folders.put(ended.name, "started", "{}");
    folders.put(ended.name, "exited", "{}");
    await provider.destroy(waiting.name, SIGNAL);
    await provider.destroy(ended.name, SIGNAL);
    expect([...folders.tree().keys()]).toEqual([]);
    await provider.destroy(ended.name, SIGNAL);
  });

  it("asks the starter to stop a runner that operates, one time, and removes the folder after the runner exited", async () => {
    const { folders, provider } = setup();
    const machine = record("rd-42-1-00000000");
    await make(provider, machine);
    folders.put(machine.name, "started", "{}");
    await provider.destroy(machine.name, SIGNAL);
    await provider.destroy(machine.name, SIGNAL);
    expect(folders.tree().get(machine.name)?.has("stop")).toBe(true);
    expect(folders.changes().filter((change) => change.file === "stop")).toHaveLength(1);
    folders.put(machine.name, "exited", "{}");
    await provider.destroy(machine.name, SIGNAL);
    expect(folders.tree().has(machine.name)).toBe(false);
  });

  it("does not remove a folder with no record of its machine, and refuses a name that is not the name of a folder", async () => {
    const { folders, provider, problems } = setup();
    folders.put("rd-1-1-00000000", "notes", "1");
    await provider.destroy("rd-1-1-00000000", SIGNAL);
    expect(folders.tree().has("rd-1-1-00000000")).toBe(true);
    expect(problems).toEqual(["The folder rd-1-1-00000000 has no record of a machine with its name. The provider does not remove it."]);
    await expect(provider.destroy("../etc", SIGNAL)).rejects.toThrow(RangeError);
    folders.put("rd-2-1-00000000", "started", "{}");
    folders.drop("rd-2-1-00000000", "started");
    await provider.destroy("rd-2-1-00000000", SIGNAL);
    expect(folders.tree().has("rd-2-1-00000000")).toBe(false);
  });

  it("gives each error of the store to the caller, with no part of the configuration", async () => {
    const { folders, provider } = setup();
    folders.fail("write");
    const error = await make(provider, record("rd-42-1-00000000")).catch((caught: unknown) => caught);
    expect(String(error)).not.toContain(SECRET);
    folders.heal();
    folders.fail("folders");
    await expect(provider.machines(SIGNAL)).rejects.toThrow(/folders/);
  });
});

describe("a dispatcher with the folder provider", () => {
  const TIMES: MachineTimes = { make: 60, register: 60, idle: 30, job: 600, retry: 5, retryMax: 40, pass: 10 };
  const SETTINGS: DispatchSettings = { prefix: "rd", capacity: 3, sizes: ["small"], standard: "small" };
  const run: RunRecord = { repository: "octo/app", runId: 100, runAttempt: 1, event: "push", headRepository: "octo/app", actor: "octo", triggeringActor: "octo" };

  it("writes a folder for a queued job, keeps it while the starter waits, and removes it and its runner after the runner exited", async () => {
    const clock = fakeClock(0);
    const world = fakeWorld({ clock, times: { boot: 2000, connect: 1000, destroy: 500 } });
    const folders = fakeFolders();
    const dispatcher = createDispatcher({
      rules: { repositories: ["octo/app"], events: ["push"], actors: ["octo"] },
      times: TIMES,
      settings: SETTINGS,
      source: world.source,
      provider: createFolderProvider({ store: folders.store }),
      now: () => clock.now(),
      suffix: countingSuffix(),
      stopped: () => false,
    });
    world.addRun(run, [{ labels: ["run-100-1"], duration: 1000 }]);

    const first = await dispatcher.pass(SIGNAL);
    expect(first.made.map((machine) => machine.name)).toEqual(["rd-100-1-00000000"]);
    expect(folders.tree().get("rd-100-1-00000000")?.has("configuration")).toBe(true);
    expect(JSON.stringify(first)).not.toContain(world.secrets()[0]);

    // The starter does not operate during the passes of the dispatcher: the machine waits, and the pass asks for nothing.
    clock.advance(1000);
    const second = await dispatcher.pass(SIGNAL);
    expect([...second.made, ...second.destroys, ...second.removals]).toEqual([]);

    // The starter started the runner, and the runner exited after its one job.
    folders.put("rd-100-1-00000000", "started", "{}");
    folders.drop("rd-100-1-00000000", "configuration");
    folders.put("rd-100-1-00000000", "exited", "{}");
    clock.advance(1000);
    const third = await dispatcher.pass(SIGNAL);
    expect(third.destroys).toEqual(["rd-100-1-00000000"]);
    expect(third.removals.map((removal) => removal.name)).toEqual(["rd-100-1-00000000"]);
    expect(folders.tree().has("rd-100-1-00000000")).toBe(false);
  });

  it("adopts the folders of a dispatcher before it, after a new start", async () => {
    const clock = fakeClock(0);
    const world = fakeWorld({ clock, times: { boot: 2000, connect: 1000, destroy: 500 } });
    const folders = fakeFolders();
    const options = {
      rules: { repositories: ["octo/app"], events: ["push"], actors: ["octo"] },
      times: TIMES,
      settings: SETTINGS,
      source: world.source,
      provider: createFolderProvider({ store: folders.store }),
      now: () => clock.now(),
      suffix: countingSuffix(),
      stopped: () => false,
    };
    world.addRun(run, [{ labels: ["run-100-1"], duration: 1000 }]);
    await createDispatcher(options).pass(SIGNAL);
    folders.put("rd-100-1-00000000", "started", "{}");
    folders.put("rd-100-1-00000000", "exited", "{}");
    clock.advance(1000);
    const report = await createDispatcher({ ...options, suffix: countingSuffix(1) }).pass(SIGNAL);
    expect(report.adopted).toEqual(["rd-100-1-00000000"]);
    expect(report.destroys).toEqual(["rd-100-1-00000000"]);
  });
});
