import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { holdWhile } from "./hold.ts";

const FIXTURE = fileURLToPath(new URL("./probe-exit.fixture.ts", import.meta.url));

/** This function runs the fixture in a child process of Node.js, and gives its exit code and its output. */
const runFixture = (mode: "hold" | "bare"): { status: number | null; stdout: string; stderr: string } => {
  const child = spawnSync(process.execPath, [FIXTURE, mode], { encoding: "utf8", timeout: 30_000 });
  return { status: child.status, stdout: child.stdout, stderr: child.stderr };
};

describe("holdWhile", () => {
  it("gives the result of the work", async () => {
    await expect(holdWhile(() => Promise.resolve(7))).resolves.toBe(7);
  });

  it("gives the error of the work", async () => {
    await expect(holdWhile(() => Promise.reject(new Error("The work failed.")))).rejects.toThrow("The work failed.");
  });

  // The cause of a real defect: a probe of an organization stopped with the exit code 13 after its first new group.
  it("without a hold, the process stops in the wait between two writes, and the group of the probe stays", () => {
    const child = runFixture("bare");
    expect(child.status).toBe(13);
    expect(child.stdout).toBe("");
    expect(child.stderr).toContain("unsettled top-level await");
  });

  it("with a hold, the probe ends on the real clock, and it removes its runner and its group", () => {
    const child = runFixture("hold");
    expect(child.stderr).toBe("");
    expect(child.stdout).toBe("clean=true groups=1 runners=0\n");
    expect(child.status).toBe(0);
  });
});
