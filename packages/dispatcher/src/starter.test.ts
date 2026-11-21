import { FOLDER_FILES } from "@mark1russell7/runner-dispatch/folder";
import { fakeFolders, type FakeFolders } from "@mark1russell7/runner-dispatch/testing";
import { fakeHost, type FakeHost } from "@mark1russell7/service/testing";
import { describe, expect, it } from "vitest";
import type { StarterStore } from "./folders.ts";
import { made, starterStore } from "./fixtures.ts";
import { EXITED_FORMAT, STARTED_FORMAT, startRunners, STARTER_TIMES, type StarterLine, type StarterPorts, type StarterTimes } from "./starter.ts";

const OPEN = new AbortController().signal;
const WALL = 1_000_000_000_000;

interface Setup {
  readonly host: FakeHost;
  readonly folders: FakeFolders;
  readonly lines: StarterLine[];
  readonly ports: StarterPorts;
  readonly times: StarterTimes;
}

function setup(times: Partial<StarterTimes> = {}, over: Partial<StarterPorts> = {}): Setup {
  const host = fakeHost();
  const folders = fakeFolders();
  const lines: StarterLine[] = [];
  const ports: StarterPorts = {
    store: starterStore(folders),
    processes: host.ports.processes,
    clock: host.clock,
    wall: () => WALL + host.clock.now(),
    request: (folder, configuration) =>
      Promise.resolve({ program: "/opt/runner/run.sh", args: [], cwd: "/opt/runner", env: { FOLDER: folder, CONFIGURATION: configuration }, ipc: false }),
    log: (line) => lines.push(line),
    ...over,
  };
  return { host, folders, lines, ports, times: { ...STARTER_TIMES, ...times } };
}

const filesOf = (at: Setup, folder: string): string[] => [...(at.folders.tree().get(folder)?.keys() ?? [])].sort();
const exitedOf = (at: Setup, folder: string): unknown => JSON.parse(at.folders.tree().get(folder)?.get(FOLDER_FILES.exited) ?? "null");

describe("startRunners", () => {
  it("starts the runner of a folder with its configuration in the environment, and writes exited after its end", async () => {
    const at = setup();
    await made(at.folders, "rd-1");
    const done = startRunners(at.ports, at.times, OPEN);
    await at.host.settle();
    const child = at.host.children[0];
    expect(child?.request).toEqual({ program: "/opt/runner/run.sh", args: [], cwd: "/opt/runner", env: { FOLDER: "rd-1", CONFIGURATION: "jit-rd-1" }, ipc: false });
    expect(filesOf(at, "rd-1")).toEqual(["check.json", "machine.json", "started"]);
    expect(JSON.parse(at.folders.tree().get("rd-1")?.get(FOLDER_FILES.started) ?? "")).toEqual({ format: STARTED_FORMAT, at: new Date(WALL).toISOString() });
    await at.host.clock.advance(7000);
    child?.exit(0);
    expect(await done).toEqual({ end: "done", runners: [{ folder: "rd-1", reason: "end", code: 0, signal: null, time: 7000 }] });
    expect(exitedOf(at, "rd-1")).toEqual({ format: EXITED_FORMAT, at: new Date(WALL + 7000).toISOString(), reason: "end", code: 0, signal: null });
    expect(at.lines.map((line) => line.event)).toEqual(["started", "exited"]);
    expect(at.host.signals).toEqual([]);
  });

  it("writes started and removes the configuration before the start", async () => {
    const seen: string[][] = [];
    const at = setup();
    const ports: StarterPorts = {
      ...at.ports,
      request: (folder, configuration) => {
        seen.push(filesOf(at, folder));
        return at.ports.request(folder, configuration);
      },
    };
    await made(at.folders, "rd-1");
    const done = startRunners(ports, at.times, OPEN);
    await at.host.settle();
    at.host.children[0]?.exit(0);
    await done;
    expect(seen).toEqual([["check.json", "machine.json", "started"]]);
  });

  it("starts one runner at a time, in the order of the names", async () => {
    const at = setup();
    await made(at.folders, "rd-2");
    await made(at.folders, "rd-1");
    const done = startRunners(at.ports, at.times, OPEN);
    await at.host.settle();
    expect(at.host.children.map((child) => child.request.env["FOLDER"])).toEqual(["rd-1"]);
    at.host.children[0]?.exit(0);
    await at.host.settle();
    expect(at.host.children.map((child) => child.request.env["FOLDER"])).toEqual(["rd-1", "rd-2"]);
    at.host.children[1]?.exit(1);
    const result = await done;
    expect(result.runners.map((exit) => [exit.folder, exit.reason, exit.code])).toEqual([
      ["rd-1", "end", 0],
      ["rd-2", "end", 1],
    ]);
  });

  it("does not start a folder with started, with exited or with no configuration", async () => {
    const at = setup();
    await made(at.folders, "rd-1");
    at.folders.put("rd-1", FOLDER_FILES.started, "{}");
    await made(at.folders, "rd-2");
    at.folders.put("rd-2", FOLDER_FILES.exited, "{}");
    await made(at.folders, "rd-3");
    at.folders.drop("rd-3", FOLDER_FILES.configuration);
    expect(await startRunners(at.ports, at.times, OPEN)).toEqual({ end: "done", runners: [] });
    expect(at.host.children).toEqual([]);
    expect(at.folders.changes().filter((change) => change.kind === "write" && change.file === FOLDER_FILES.exited)).toEqual([]);
  });

  it("does not start a folder that a different starter took first", async () => {
    const at = setup();
    await made(at.folders, "rd-1");
    const store: StarterStore = {
      ...at.ports.store,
      async create(folder, file, text, signal) {
        // A different starter writes the file between the list and the request.
        at.folders.put(folder, file, "{}");
        return at.ports.store.create(folder, file, text, signal);
      },
    };
    expect(await startRunners({ ...at.ports, store }, at.times, OPEN)).toEqual({ end: "done", runners: [] });
    expect(at.lines).toEqual([{ event: "taken", folder: "rd-1" }]);
    expect(at.host.children).toEqual([]);
    expect(filesOf(at, "rd-1")).toContain(FOLDER_FILES.configuration);
  });

  it("stops the runner at the file stop: SIGINT to its group, then exited", async () => {
    const at = setup({ poll: 5 });
    at.host.polite = true;
    await made(at.folders, "rd-1");
    const done = startRunners(at.ports, at.times, OPEN);
    await at.host.settle();
    at.folders.put("rd-1", FOLDER_FILES.stop, "");
    await at.host.clock.advance(5000);
    const result = await done;
    const pid = at.host.children[0]?.pid;
    expect(result.runners).toEqual([{ folder: "rd-1", reason: "stop", code: 0, signal: null, time: 5000 }]);
    expect(at.host.signals).toEqual([{ pid, signal: "SIGINT", group: true }]);
    expect(exitedOf(at, "rd-1")).toMatchObject({ reason: "stop", code: 0 });
  });

  it("stops the runner at its deadline, and sends SIGKILL after the grace when SIGINT does not stop it", async () => {
    const at = setup({ deadline: 10, poll: 5, grace: 2 });
    await made(at.folders, "rd-1");
    const done = startRunners(at.ports, at.times, OPEN);
    await at.host.settle();
    await at.host.clock.advance(5000);
    await at.host.clock.advance(5000);
    await at.host.clock.advance(2000);
    const result = await done;
    const pid = at.host.children[0]?.pid;
    expect(result.runners).toEqual([{ folder: "rd-1", reason: "deadline", code: null, signal: "SIGKILL", time: 12000 }]);
    expect(at.host.signals).toEqual([
      { pid, signal: "SIGINT", group: true },
      { pid, signal: "SIGKILL", group: true },
    ]);
    expect(exitedOf(at, "rd-1")).toMatchObject({ reason: "deadline", code: null, signal: "SIGKILL" });
  });

  it("stops the runner at the signal, writes exited, and starts no other runner", async () => {
    const at = setup();
    at.host.polite = true;
    await made(at.folders, "rd-1");
    await made(at.folders, "rd-2");
    const stop = new AbortController();
    const done = startRunners(at.ports, at.times, stop.signal);
    await at.host.settle();
    stop.abort();
    const result = await done;
    expect(result).toEqual({ end: "signal", runners: [{ folder: "rd-1", reason: "signal", code: 0, signal: null, time: 0 }] });
    expect(at.host.children.length).toBe(1);
    expect(exitedOf(at, "rd-1")).toMatchObject({ reason: "signal" });
    expect(filesOf(at, "rd-2")).toContain(FOLDER_FILES.configuration);
  });

  it("does nothing for a signal that stopped before the start", async () => {
    const at = setup();
    await made(at.folders, "rd-1");
    expect(await startRunners(at.ports, at.times, AbortSignal.abort())).toEqual({ end: "signal", runners: [] });
    expect(filesOf(at, "rd-1")).toEqual(["check.json", "configuration", "machine.json"]);
  });

  it("writes exited with the reason start when the start fails, an empty configuration, or a request that fails", async () => {
    const failing = setup();
    failing.host.failSpawn = () => true;
    await made(failing.folders, "rd-1");
    expect((await startRunners(failing.ports, failing.times, OPEN)).runners).toEqual([{ folder: "rd-1", reason: "start", code: null, signal: null, time: 0 }]);
    expect(exitedOf(failing, "rd-1")).toMatchObject({ reason: "start" });

    const empty = setup();
    await made(empty.folders, "rd-1", " \n");
    expect((await startRunners(empty.ports, empty.times, OPEN)).runners.map((exit) => exit.reason)).toEqual(["start"]);
    expect(empty.host.children).toEqual([]);

    const secret = "jit-a-secret-configuration";
    const refused = setup({}, { request: () => Promise.reject(new Error(`The request failed for ${secret}.`)) });
    await made(refused.folders, "rd-1", secret);
    expect((await startRunners(refused.ports, refused.times, OPEN)).runners.map((exit) => exit.reason)).toEqual(["start"]);
    expect(filesOf(refused, "rd-1")).toEqual(["check.json", "exited", "machine.json", "started"]);
    expect(JSON.stringify(refused.lines)).not.toContain(secret);
  });

  it("logs a failed read of the folder during the watch, and keeps the watch", async () => {
    const at = setup({ poll: 5 });
    await made(at.folders, "rd-1");
    const done = startRunners(at.ports, at.times, OPEN);
    await at.host.settle();
    at.folders.fail("files");
    await at.host.clock.advance(5000);
    at.folders.heal();
    at.host.children[0]?.exit(0);
    const result = await done;
    expect(result.runners.map((exit) => exit.reason)).toEqual(["end"]);
    expect(at.lines.filter((line) => line.event === "problem")).toEqual([
      { event: "problem", folder: "rd-1", text: "The store refuses the request files." },
    ]);
  });

  it("stops the runner of a folder that is not there, and does not make the folder again", async () => {
    const at = setup({ poll: 5 });
    at.host.polite = true;
    await made(at.folders, "rd-1");
    const done = startRunners(at.ports, at.times, OPEN);
    await at.host.settle();
    await at.folders.store.remove("rd-1", OPEN);
    await at.host.clock.advance(5000);
    expect((await done).runners.map((exit) => exit.reason)).toEqual(["stop"]);
    expect(at.folders.tree().has("rd-1")).toBe(false);
  });

  it("refuses a time that is not valid", async () => {
    const at = setup();
    for (const times of [{ deadline: 0 }, { poll: Number.NaN }, { grace: -1 }, { deadline: Number.POSITIVE_INFINITY }]) {
      await expect(startRunners(at.ports, { ...STARTER_TIMES, ...times }, OPEN)).rejects.toThrow(RangeError);
    }
  });
});
