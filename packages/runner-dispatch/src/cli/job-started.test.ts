import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHECK_SETTINGS_FORMAT } from "../check.ts";
import { TRUST_RULES_FORMAT } from "../policy.ts";

// These tests start the program as the job-started script of a runner starts it: a new process of Node.js,
// with one argument and the variables of the job. The process gets no variable of the job that runs these tests.
const PROGRAM = fileURLToPath(new URL("./job-started.ts", import.meta.url));

const settings = {
  format: CHECK_SETTINGS_FORMAT,
  rules: { format: TRUST_RULES_FORMAT, repositories: ["octo/app"], events: ["push", "pull_request"], actors: ["mark"] },
  run: { repository: "octo/app", runId: 77, runAttempt: 1 },
};

let folder = "";
let settingsPath = "";

const write = (name: string, document: unknown): string => {
  const path = join(folder, name);
  writeFileSync(path, typeof document === "string" ? document : JSON.stringify(document));
  return path;
};

const start = (args: readonly string[], variables: Record<string, string>): { code: number | null; lines: string[] } => {
  // Windows needs SystemRoot to start a process. No other variable of this process goes to the program.
  const system = process.env["SystemRoot"];
  const result = spawnSync(process.execPath, [PROGRAM, ...args], {
    env: { ...(system === undefined ? {} : { SystemRoot: system }), ...variables },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: result.status, lines: result.stdout.split("\n").filter((line) => line.length > 0) };
};

const job = (eventPath: string, changes: Record<string, string> = {}): Record<string, string> => ({
  GITHUB_REPOSITORY: "octo/app",
  GITHUB_RUN_ID: "77",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_EVENT_NAME: "push",
  GITHUB_ACTOR: "mark",
  GITHUB_TRIGGERING_ACTOR: "mark",
  GITHUB_EVENT_PATH: eventPath,
  ...changes,
});

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), "runner-dispatch-check-"));
  settingsPath = write("check.json", settings);
});

afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe("the job-started program", () => {
  it("ends with the code 0 for the job of the run of the machine", () => {
    const eventPath = write("push.json", { repository: { full_name: "octo/app" } });
    expect(start([settingsPath], job(eventPath))).toEqual({
      code: 0,
      lines: ['The check on the machine passed: the run 77, try 1, of "octo/app".'],
    });
  });

  it("ends with the code 1 for a pull request from a fork", () => {
    const eventPath = write("fork.json", {
      repository: { full_name: "octo/app" },
      pull_request: { head: { repo: { full_name: "stranger/app" } } },
    });
    expect(start([settingsPath], job(eventPath, { GITHUB_EVENT_NAME: "pull_request" }))).toEqual({
      code: 1,
      lines: [
        "The check on the machine refused this job.",
        '- head-repository: The head repository "stranger/app" is not the repository "octo/app".',
      ],
    });
  });

  it("ends with the code 1 for the job of a different run, and for a job with no event file", () => {
    const eventPath = write("other.json", { repository: { full_name: "octo/app" } });
    expect(start([settingsPath], job(eventPath, { GITHUB_RUN_ID: "78" }))).toEqual({
      code: 1,
      lines: ["The check on the machine refused this job.", "- machine: The run of the job is not the run of this machine."],
    });
    const missing = start([settingsPath], job(join(folder, "no-such-file.json")));
    expect(missing.code).toBe(1);
    expect(missing.lines).toContain("- event-file: The event file of the job is not an object.");
  });

  it("ends with the code 2 when it cannot use its settings", () => {
    const eventPath = write("settings.json", { repository: { full_name: "octo/app" } });
    const cannot = (reason: string): unknown => ({ code: 2, lines: [`The check on the machine cannot start. ${reason}`] });
    expect(start([], job(eventPath))).toEqual(cannot("It needs one argument: the path of its settings file."));
    expect(start([join(folder, "no-such-file.json")], job(eventPath))).toEqual(cannot("It cannot read its settings file as JSON."));
    expect(start([write("rules.json", settings.rules)], job(eventPath))).toEqual(
      cannot("Its settings file is not valid. The count of the problems is 6."),
    );
  });

  it("does not read its settings from a variable of the job", () => {
    // A variable cannot name the settings file: without the argument, the program does not start a job.
    const eventPath = write("variable.json", { repository: { full_name: "octo/app" } });
    const variables = job(eventPath, { RUNNER_DISPATCH_CHECK: settingsPath, CHECK_SETTINGS: settingsPath });
    expect(start([], variables).code).toBe(2);
  });

  it("imports only files of this package and modules of Node.js, thus a machine needs no installed package", () => {
    // A machine has the source files of this package and the Node.js of the runner program. It has no node_modules.
    const source = dirname(dirname(PROGRAM));
    const files = new Set<string>();
    const others: string[] = [];
    const read = (file: string): void => {
      if (files.has(file)) return;
      files.add(file);
      const text = readFileSync(file, "utf8");
      // Each import is static: the files have no import() and no require().
      expect(/\bimport\s*\(|\brequire\s*\(/.test(text), file).toBe(false);
      for (const match of text.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)";|^import\s+"([^"]+)";/gm)) {
        const name = match[1] ?? match[2] ?? "";
        if (name.startsWith("node:")) continue;
        if (name.startsWith("./") || name.startsWith("../")) read(resolve(dirname(file), name));
        else others.push(`${relative(source, file)}: ${name}`);
      }
    };
    read(PROGRAM);
    expect(others).toEqual([]);
    const names = [...files].map((file) => relative(source, file).replaceAll("\\", "/")).sort();
    expect(names).toEqual(["check.ts", "cli/job-started.ts", "job-started.ts", "policy.ts", "records.ts"]);
  });
});
