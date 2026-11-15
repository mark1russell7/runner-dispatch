/**
 * This program is a child process of the test of `holdWhile`. It runs the probe of an organization on the fake GitHub,
 * with the real clock. The REST client waits one second between two requests that change data.
 *
 * Run: node src/probe-exit.fixture.ts hold|bare
 *
 * With `hold`, the program starts the probe through `holdWhile`, as the command does. With `bare`, it starts the probe
 * with no hold. The program prints the field `clean` of the record and sets the exit code of the probe.
 */
import { holdWhile } from "./hold.ts";
import { fakeGitHub, TOKEN } from "./probe-fake.ts";
import { probeMain } from "./probe-cli.ts";
import { SECRET_VARIABLES } from "./program.ts";

const mode = process.argv[2];
if (mode !== "hold" && mode !== "bare") throw new RangeError(`The mode ${String(mode)} is not hold or bare.`);
const github = fakeGitHub();
const lines: string[] = [];
const run = (): Promise<number> =>
  probeMain(
    ["--repository", "octo/app", "--organization", "octo", "--group"],
    {
      env: { [SECRET_VARIABLES.github]: TOKEN },
      out: (line) => lines.push(line),
      err: (line) => process.stderr.write(`${line}\n`),
      readStdin: () => Promise.reject(new Error("The fixture has no stdin.")),
      writeText: () => Promise.reject(new Error("The fixture writes no file.")),
    },
    { transport: github.transport },
  );
const code = mode === "hold" ? await holdWhile(run) : await run();
const record: unknown = lines.length === 1 ? JSON.parse(lines[0] as string) : null;
const clean = typeof record === "object" && record !== null && "clean" in record ? record.clean : null;
process.stdout.write(`clean=${String(clean)} groups=${github.groups.size} runners=${github.runners.size}\n`);
process.exitCode = code;
