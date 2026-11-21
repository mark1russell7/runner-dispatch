import { join } from "node:path";
import { FOLDER_FILES } from "@mark1russell7/runner-dispatch/folder";
import { fakeFolders } from "@mark1russell7/runner-dispatch/testing";
import { fakeHost, fakeProcess } from "@mark1russell7/service/testing";
import { describe, expect, it } from "vitest";
import type { CliIo } from "./cli.ts";
import { made, settle, starterStore } from "./fixtures.ts";
import {
  CONFIGURATION_VARIABLE,
  HOOK_VARIABLE,
  hookScript,
  parseStarterCommand,
  runnerEnvironment,
  starterMain,
  STARTER_USAGE,
  type HookFolder,
  type StarterCliPorts,
} from "./starter-cli.ts";
import { STARTER_TIMES } from "./starter.ts";

const ROOT = "/srv/machines";
const RUNNER = "/opt/runner";
const CHECK = "/opt/dispatch/job-started.js";
const NODE = "/usr/bin/node";
const BASE = [ROOT, "--runner", RUNNER, "--check", CHECK];

describe("parseStarterCommand", () => {
  it("reads a start with the default times and the Node.js of the command", () => {
    expect(parseStarterCommand(BASE)).toEqual({ kind: "start", settings: { root: ROOT, runner: RUNNER, check: CHECK, node: null, times: STARTER_TIMES } });
    expect(parseStarterCommand([...BASE, "--node", NODE, "--deadline", "600", "--poll", "0.5", "--grace", "0"])).toEqual({
      kind: "start",
      settings: { root: ROOT, runner: RUNNER, check: CHECK, node: NODE, times: { deadline: 600, poll: 0.5, grace: 0 } },
    });
  });

  it("gives the help before it examines the other arguments", () => {
    expect(parseStarterCommand(["--bad", "-h"])).toEqual({ kind: "help" });
    expect(parseStarterCommand(["--help"])).toEqual({ kind: "help" });
  });

  it("refuses a bad command", () => {
    const problems = [
      [],
      [ROOT, ROOT, "--runner", RUNNER, "--check", CHECK],
      ["machines", "--runner", RUNNER, "--check", CHECK],
      [ROOT, "--check", CHECK],
      [ROOT, "--runner", "runner", "--check", CHECK],
      [...BASE, "--node", "node"],
      [...BASE, "--runner", RUNNER],
      [...BASE, "--poll"],
      [...BASE, "--poll", "--grace", "1"],
      [...BASE, "--deadline", "0"],
      [...BASE, "--poll", "-1"],
      [...BASE, "--grace", "1e3"],
      [...BASE, "--grace", "soon"],
      [...BASE, "--verbose"],
    ].map((args) => parseStarterCommand(args).kind);
    expect(new Set(problems)).toEqual(new Set(["usage"]));
  });
});

describe("hookScript", () => {
  it("starts the check with fixed absolute paths", () => {
    expect(hookScript(NODE, CHECK, "/srv/machines/rd-1/check.json")).toBe(`#!/bin/sh\nexec '${NODE}' '${CHECK}' '/srv/machines/rd-1/check.json'\n`);
  });

  it("refuses a path that is not absolute, or that has a quotation mark or a line break", () => {
    for (const path of ["node", "/usr/bin/it's", "/usr/bin/a\nb", "/usr/bin/a\rb", "/usr/bin/a\0b"]) {
      expect(() => hookScript(path, CHECK, "/srv/check.json")).toThrow(RangeError);
      expect(() => hookScript(NODE, path, "/srv/check.json")).toThrow(RangeError);
      expect(() => hookScript(NODE, CHECK, path)).toThrow(RangeError);
    }
  });
});

describe("runnerEnvironment", () => {
  it("keeps only the kept variables, and adds the hook and the configuration", () => {
    const env = { PATH: "/usr/bin", HOME: "/home/runner", GITHUB_TOKEN: "ghp_x", PROXMOX_TOKEN: "pve", LANG: "C.UTF-8", USER: undefined };
    expect(runnerEnvironment(env, "/tmp/h/rd-1.sh", "jit")).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/runner",
      LANG: "C.UTF-8",
      [HOOK_VARIABLE]: "/tmp/h/rd-1.sh",
      [CONFIGURATION_VARIABLE]: "jit",
    });
  });
});

const memoryIo = (env: Record<string, string | undefined> = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { env, readText: () => Promise.reject(new Error("The starter reads no file of the command.")), out: (line) => out.push(line), err: (line) => err.push(line) };
  return { io, out, err };
};

const memoryHooks = () => {
  const scripts = new Map<string, string>();
  let removed = 0;
  const hooks = (): Promise<HookFolder> =>
    Promise.resolve({
      write(folder, text) {
        scripts.set(folder, text);
        return Promise.resolve(`/tmp/hooks/${folder}.sh`);
      },
      remove() {
        removed += 1;
        return Promise.resolve();
      },
    });
  return { scripts, hooks, removed: () => removed };
};

describe("starterMain", () => {
  const setup = () => {
    const host = fakeHost();
    const folders = fakeFolders();
    const process = fakeProcess({ clock: host.clock });
    const hooks = memoryHooks();
    const ports: StarterCliPorts = {
      processes: host.ports.processes,
      clock: host.clock,
      wall: () => host.clock.now(),
      store: () => starterStore(folders),
      hooks: hooks.hooks,
      node: NODE,
      process,
    };
    return { host, folders, process, hooks, ports };
  };

  it("gives the help with the exit code 0, and a bad command with the exit code 2", async () => {
    const help = memoryIo();
    expect(await starterMain(["--help"], help.io, setup().ports)).toBe(0);
    expect(help.out).toEqual([STARTER_USAGE]);
    const bad = memoryIo();
    expect(await starterMain(["machines"], bad.io, setup().ports)).toBe(2);
    expect(bad.err).toEqual(["The root is not an absolute path.", STARTER_USAGE]);
  });

  it("starts the runner with a clean environment and the hook of its folder, and keeps the configuration out of each line", async () => {
    const at = setup();
    const secret = "jit-a-secret-configuration";
    await made(at.folders, "rd-1", `${secret}\n`);
    const io = memoryIo({ PATH: "/usr/bin", GITHUB_TOKEN: "ghp_x" });
    const done = starterMain(BASE, io.io, at.ports);
    await at.host.settle();
    const child = at.host.children[0];
    expect(child?.request).toEqual({
      program: join(RUNNER, "run.sh"),
      args: [],
      cwd: RUNNER,
      env: { PATH: "/usr/bin", [HOOK_VARIABLE]: "/tmp/hooks/rd-1.sh", [CONFIGURATION_VARIABLE]: secret },
      ipc: false,
    });
    expect(at.hooks.scripts.get("rd-1")).toBe(hookScript(NODE, CHECK, join(ROOT, "rd-1", FOLDER_FILES.check)));
    child?.output("stdout", `Listening for Jobs\nThe configuration ${secret}`);
    child?.output("stdout", " ends\n");
    child?.output("stderr", "a last part");
    child?.exit(0);
    expect(await done).toBe(0);
    const lines = io.out.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.filter((line) => line["event"] === "output").map((line) => [line["stream"], line["line"]])).toEqual([
      ["stdout", "Listening for Jobs"],
      ["stdout", "The configuration [secret] ends"],
      ["stderr", "a last part"],
    ]);
    expect(lines.map((line) => line["event"])).toEqual(["started", "output", "output", "output", "exited", "starter"]);
    expect(lines.at(-1)).toEqual({ event: "starter", end: "done", runners: 1 });
    expect(io.out.join("\n")).not.toContain(secret);
    expect(io.err).toEqual([]);
    expect(at.hooks.removed()).toBe(1);
  });

  it("stops the runner at a SIGTERM, writes exited, and gives the exit code 0", async () => {
    const at = setup();
    at.host.polite = true;
    await made(at.folders, "rd-1");
    await made(at.folders, "rd-2");
    const io = memoryIo();
    const done = starterMain(BASE, io.io, at.ports);
    await at.host.settle();
    at.process.signal("SIGTERM");
    await settle();
    expect(await done).toBe(0);
    expect(at.host.children.length).toBe(1);
    expect(JSON.parse(io.out.at(-1) ?? "")).toEqual({ event: "starter", end: "signal", runners: 1 });
    expect(at.folders.tree().get("rd-1")?.has(FOLDER_FILES.exited)).toBe(true);
    expect(at.hooks.removed()).toBe(1);
  });

  it("gives the exit code 1 for a store that fails, and removes the hook folder", async () => {
    const at = setup();
    at.folders.fail("folders");
    const io = memoryIo();
    expect(await starterMain(BASE, io.io, at.ports)).toBe(1);
    expect(io.err).toEqual(["The store refuses the request folders."]);
    expect(at.hooks.removed()).toBe(1);
  });
});
