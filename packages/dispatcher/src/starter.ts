/**
 * The starter of the folder provider: the part on the host that starts the runner program from each folder.
 *
 * The starter has no token. It reads the one-job configuration of a folder, and it gives it to the runner program.
 * The rules of the starter are in the README of `@mark1russell7/runner-dispatch`.
 */
import { delay, type Clock } from "@mark1russell7/algebra/clock";
import { FOLDER_FILES } from "@mark1russell7/runner-dispatch/folder";
import type { ProcessesPort, SpawnRequest, StopSignal } from "@mark1russell7/service/host";
import { errorMessage } from "@mark1russell7/text";
import type { StarterStore } from "./folders.ts";

/** This constant is the format of the file `started` that the starter writes. */
export const STARTED_FORMAT = "starter-started/1";

/** This constant is the format of the file `exited` that the starter writes. */
export const EXITED_FORMAT = "starter-exited/1";

/**
 * This type is the reason of the end of a runner.
 *
 * - `end`: the runner program stopped by itself.
 * - `start`: the runner program did not start. The folder had no configuration, or the start failed.
 * - `stop`: the folder has the file `stop`, or the folder is not there.
 * - `deadline`: the runner program operated for the time `deadline`.
 * - `signal`: the starter got the signal to stop.
 */
export type ExitReason = "end" | "start" | "stop" | "deadline" | "signal";

/** These are the times of the starter, in seconds. */
export interface StarterTimes {
  /** This field is the longest time that one runner program operates. */
  readonly deadline: number;
  /** This field is the time between two reads of the files of the folder of a runner that operates. */
  readonly poll: number;
  /** This field is the time from `SIGINT` to `SIGKILL`. After `SIGKILL`, the starter waits this time for the end again. */
  readonly grace: number;
}

/** These are the default times of the starter. */
export const STARTER_TIMES: StarterTimes = { deadline: 3600, poll: 5, grace: 30 };

/** This type is an output stream of the runner program. */
export type OutputStream = "stdout" | "stderr";

/** These are the ports of the starter. A test gives fakes. */
export interface StarterPorts {
  /** This field is the store of the folders, with the requests of a starter. */
  readonly store: StarterStore;
  /** This field starts the runner program and sends a signal to its process group. */
  readonly processes: Pick<ProcessesPort, "spawn" | "signal" | "signalGroup">;
  /** This clock gives the monotonic time and the timers. */
  readonly clock: Pick<Clock, "now" | "after">;
  /** This function gives the wall time, in milliseconds after the epoch, for the records in the folders. */
  readonly wall: () => number;
  /**
   * This function gives the request of the start of the runner program of a folder, with its configuration.
   * The configuration goes in the environment of the request, not in its arguments.
   */
  readonly request: (folder: string, configuration: string) => Promise<SpawnRequest>;
  /** This function gets each log line. No line has a part of a configuration. */
  readonly log: (line: StarterLine) => void;
  /** This function gets each part of the output of a runner program. */
  readonly output?: ((folder: string, stream: OutputStream, chunk: string | Uint8Array) => void) | undefined;
}

/** This record is the end of one runner. */
export interface RunnerExit {
  /** This field is the name of the folder. */
  readonly folder: string;
  readonly reason: ExitReason;
  /** This field is the exit code of the runner program, or `null`. */
  readonly code: number | null;
  /** This field is the signal that stopped the runner program, or `null`. */
  readonly signal: string | null;
  /** This field is the time from the start to the end, in milliseconds. It is 0 for a runner that did not start. */
  readonly time: number;
}

/** This type is one log line of the starter. */
export type StarterLine =
  | { readonly event: "started"; readonly folder: string; readonly pid: number }
  | { readonly event: "exited"; readonly exit: RunnerExit }
  | { readonly event: "taken"; readonly folder: string }
  | { readonly event: "problem"; readonly folder: string; readonly text: string };

/** This record is the result of the starter: the end of each runner, and the end of the starter. */
export interface StarterResult {
  readonly runners: readonly RunnerExit[];
  /** This field is `done` when no folder waits for a start, and `signal` after the signal to stop. */
  readonly end: "done" | "signal";
}

interface RunnerEnd {
  readonly code: number | null;
  readonly signal: string | null;
}

const recordText = (format: string, at: number, fields: Readonly<Record<string, unknown>>): string =>
  `${JSON.stringify({ format, at: new Date(at).toISOString(), ...fields })}\n`;

const checkTimes = (times: StarterTimes): void => {
  for (const [name, value] of [["deadline", times.deadline], ["poll", times.poll]] as const) {
    if (!Number.isFinite(value) || value <= 0) throw new RangeError(`The time ${name} of the starter is not a finite number above 0.`);
  }
  if (!Number.isFinite(times.grace) || times.grace < 0) throw new RangeError("The time grace of the starter is not a finite number of 0 or more.");
};

/** This function gives the first folder that waits for a start: a configuration, and no record of a start or of an end. */
const nextFolder = async (store: StarterStore, open: AbortSignal): Promise<string | null> => {
  for (const folder of await store.folders(open)) {
    const files = await store.files(folder, open);
    if (files === null || !files.includes(FOLDER_FILES.configuration)) continue;
    if (files.includes(FOLDER_FILES.started) || files.includes(FOLDER_FILES.exited)) continue;
    return folder;
  }
  return null;
};

/**
 * This function starts the runner program of each folder that waits for a start, one at a time, and waits for the end of each.
 *
 * - The starter writes `started` only when the file is not there. Then it reads and removes `configuration`.
 * - It stops a runner program at the file `stop`, at the time `deadline` or at the signal: `SIGINT` to its group, then `SIGKILL`.
 * - It writes `exited` after each end, also after a start that failed. It does not make a folder that is not there.
 * - It starts one runner program at a time, because one folder of the runner program holds one runner.
 *
 * @param ports - The store, the processes, the clocks, the request of a start and the log
 * @param times - The deadline of a runner, the time between two reads of a folder, and the grace of a stop
 * @param signal - The signal that stops the starter. The starter stops the runner program that operates, and writes `exited`.
 * @returns The end of each runner, and the end of the starter
 * @throws RangeError for a time that is not valid. An error of the store goes to the caller, except during the watch of a runner.
 */
export async function startRunners(ports: StarterPorts, times: StarterTimes, signal: AbortSignal): Promise<StarterResult> {
  checkTimes(times);
  // The records in the folders go to the store also after the signal to stop.
  const open = new AbortController().signal;
  const runners: RunnerExit[] = [];
  for (;;) {
    if (signal.aborted) return { runners, end: "signal" };
    const folder = await nextFolder(ports.store, open);
    if (folder === null) return { runners, end: "done" };
    const exit = await startOne(ports, times, folder, signal, open);
    if (exit !== null) runners.push(exit);
  }
}

const startOne = async (ports: StarterPorts, times: StarterTimes, folder: string, signal: AbortSignal, open: AbortSignal): Promise<RunnerExit | null> => {
  const { store, clock, processes } = ports;
  const finish = async (exit: RunnerExit): Promise<RunnerExit> => {
    // A write of a folder that is not there makes the folder. A folder with no record of a machine stays, thus the starter writes nothing.
    if ((await store.files(folder, open)) !== null) {
      await store.write(folder, FOLDER_FILES.exited, recordText(EXITED_FORMAT, ports.wall(), { reason: exit.reason, code: exit.code, signal: exit.signal }), open);
    }
    ports.log({ event: "exited", exit });
    return exit;
  };
  const failed = (reason: ExitReason): Promise<RunnerExit> => finish({ folder, reason, code: null, signal: null, time: 0 });

  if (!(await store.create(folder, FOLDER_FILES.started, recordText(STARTED_FORMAT, ports.wall(), {}), open))) {
    ports.log({ event: "taken", folder });
    return null;
  }
  const configuration = await store.read(folder, FOLDER_FILES.configuration, open);
  await store.removeFile(folder, FOLDER_FILES.configuration, open);
  if (configuration === null || configuration.trim() === "") return failed("start");
  let request: SpawnRequest;
  try {
    request = await ports.request(folder, configuration);
  } catch {
    // The text of the error stays out of the log. Thus no part of the configuration goes to the log.
    return failed("start");
  }
  if (signal.aborted) return failed("signal");

  const child = processes.spawn(request);
  const startedAt = clock.now();
  const state: { end: RunnerEnd | null } = { end: null };
  const ended = new Promise<RunnerEnd>((resolve) => {
    child.onExit((code, stopped) => {
      const end = { code, signal: stopped };
      state.end = end;
      resolve(end);
    });
  });
  const output = ports.output;
  if (output !== undefined) child.onOutput((stream, chunk) => output(folder, stream, chunk));
  const pid = child.pid;
  if (pid === null) return failed("start");
  ports.log({ event: "started", folder, pid });

  // This function waits for the end of the runner program or for the time, and the signal stops the wait when it is given.
  const pause = async (ms: number, stop: AbortSignal | null): Promise<void> => {
    const local = new AbortController();
    const signals = stop === null ? local.signal : AbortSignal.any([local.signal, stop]);
    try {
      await Promise.race([ended, delay(clock, ms, signals).catch(() => undefined)]);
    } finally {
      local.abort();
    }
  };
  const send = (sent: StopSignal): void => {
    if (!processes.signalGroup(pid, sent)) processes.signal(pid, sent);
  };

  const deadlineAt = startedAt + times.deadline * 1000;
  let reason: ExitReason = "end";
  for (;;) {
    if (state.end !== null) break;
    if (signal.aborted) {
      reason = "signal";
      break;
    }
    const left = deadlineAt - clock.now();
    if (left <= 0) {
      reason = "deadline";
      break;
    }
    let files: readonly string[] | null | undefined;
    try {
      files = await store.files(folder, open);
    } catch (error) {
      ports.log({ event: "problem", folder, text: errorMessage(error) });
    }
    if (state.end !== null) break;
    if (files === null || files?.includes(FOLDER_FILES.stop) === true) {
      reason = "stop";
      break;
    }
    await pause(Math.min(left, times.poll * 1000), signal);
  }
  if (reason !== "end") {
    send("SIGINT");
    await pause(times.grace * 1000, null);
    if (state.end === null) {
      send("SIGKILL");
      await pause(times.grace * 1000, null);
    }
  }
  const end = state.end ?? { code: null, signal: null };
  return finish({ folder, reason, code: end.code, signal: end.signal, time: clock.now() - startedAt });
};
