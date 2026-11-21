import { checkSettingsDocument, parseCheckSettings } from "./check.ts";
import { isObject, show } from "./policy.ts";
import type { MachineProvider, MachineStatus, ProviderMachine, StopSignal } from "./ports.ts";
import { machineDescription, parseMachineDescription } from "./proxmox.ts";

/**
 * These constants are the names of the files in the folder of one machine.
 *
 * - The provider writes `machine.json` and `check.json`, and then `configuration`. For a destroy of a started machine, it writes `stop`.
 * - The starter of the host writes `started` before it starts the runner, and `exited` after the runner ends.
 * - The starter removes `configuration` when it reads it. Thus the one-job credential stays on the disk only until the start.
 */
export const FOLDER_FILES: {
  readonly machine: "machine.json";
  readonly check: "check.json";
  readonly configuration: "configuration";
  readonly started: "started";
  readonly exited: "exited";
  readonly stop: "stop";
} = Object.freeze({
  machine: "machine.json",
  check: "check.json",
  configuration: "configuration",
  started: "started",
  exited: "exited",
  stop: "stop",
});

/** This type is the name of one file in the folder of a machine. */
export type FolderFile = (typeof FOLDER_FILES)[keyof typeof FOLDER_FILES];

/**
 * This port is the store of the folders of the machines, for example a directory on a disk. Each method takes a signal that stops the request.
 * The store keeps each folder in its root. Only the account of the dispatcher and of the starter can read a file.
 * A method throws when it cannot give a complete answer.
 */
export interface FolderStore<Signal extends StopSignal = StopSignal> {
  /** This method gives the name of each folder in the root. */
  folders(signal: Signal): Promise<readonly string[]>;
  /** This method gives the name of each file in a folder, or `null` when the folder is not there. */
  files(folder: string, signal: Signal): Promise<readonly string[] | null>;
  /** This method gives the text of a file, or `null` when the file is not there. */
  read(folder: string, file: FolderFile, signal: Signal): Promise<string | null>;
  /**
   * This method writes a file, and it makes the folder when the folder is not there.
   * A reader sees the old file or the complete new file. A reader does not see a part of a file.
   */
  write(folder: string, file: FolderFile, text: string, signal: Signal): Promise<void>;
  /** This method removes a folder and each file in it. It succeeds when the folder is not there. */
  remove(folder: string, signal: Signal): Promise<void>;
}

/** This record has the options of a folder provider. */
export interface FolderProviderOptions<Signal extends StopSignal = StopSignal> {
  /** This field is the store of the folders. The root has only the folders of this dispatcher. */
  readonly store: FolderStore<Signal>;
  /** This function gets each problem of one folder that does not stop the list. A text has no credential. */
  readonly problem?: (text: string) => void;
}

const FOLDER_NAME = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const STORE_METHODS: readonly (keyof FolderStore)[] = ["folders", "files", "read", "write", "remove"];

/**
 * This function tells if a value is the name of the folder of a machine. The name is a small letter, then 62 small letters, digits or hyphens at most.
 * The last character is not a hyphen. The name has no separator of a path, and it is not `.` or `..`.
 *
 * @param value - The value
 * @returns `true` when the value is the name of the folder of a machine
 */
export function isFolderName(value: unknown): value is string {
  return typeof value === "string" && FOLDER_NAME.test(value);
}

/**
 * This function gives the status of a machine from the names of the files in its folder.
 *
 * | Files | Status |
 * | --- | --- |
 * | `exited` | `stopped` |
 * | `started`, with no `exited` | `operating` |
 * | `configuration`, with no `started` | `making`: the starter did not start the runner yet |
 * | None of the three | `stopped`: the machine has no configuration, thus it cannot operate |
 *
 * @param files - The names of the files in the folder
 * @returns The status of the machine
 */
export function folderStatus(files: readonly string[]): MachineStatus {
  if (files.includes(FOLDER_FILES.exited)) return "stopped";
  if (files.includes(FOLDER_FILES.started)) return "operating";
  if (files.includes(FOLDER_FILES.configuration)) return "making";
  return "stopped";
}

/**
 * This function makes a provider of the machines in the folders of a store. Each machine is one folder, with the name of the machine.
 * A starter on the host reads each folder, starts the runner program with the configuration, and records its start and its end.
 * The dispatcher and the starter share no process. Thus the starter needs no token of the source.
 *
 * - `make` writes the record of the machine, the settings of the check and then the configuration. It refuses a folder that is there.
 * - `machines` reads the record and the status of each folder. A folder with no record of its machine is not in the list, and the provider tells it one time.
 * - `destroy` of a machine that the starter started and that did not end writes the file `stop`, and the starter stops the runner.
 *   `destroy` of each other machine removes its folder. A destroy of a folder that is not there succeeds.
 * - The configuration goes only into the file `configuration`. No problem text and no error text has a part of it.
 *
 * @param options - The store of the folders and the receiver of the problems
 * @returns The provider
 * @throws RangeError when the options are not valid
 */
export function createFolderProvider<Signal extends StopSignal = StopSignal>(options: FolderProviderOptions<Signal>): MachineProvider<Signal> {
  const store: unknown = isObject(options) ? options.store : undefined;
  const missing = STORE_METHODS.filter((method) => !isObject(store) || typeof store[method] !== "function");
  if (missing.length > 0) throw new RangeError(`The options of the folder provider are not valid. The field store has no method ${missing.join(", ")}.`);
  const folders = store as FolderStore<Signal>;
  const told = new Set<string>();
  const tell = (folder: string, text: string): void => {
    if (told.has(folder)) return;
    told.add(folder);
    options.problem?.(text);
  };

  /** This function gives the record of the machine of a folder. It gives `null` when the folder has no record of a machine with its name. */
  const recordOf = async (folder: string, files: readonly string[], signal: Signal) => {
    if (!files.includes(FOLDER_FILES.machine)) return null;
    const text = await folders.read(folder, FOLDER_FILES.machine, signal);
    const record = parseMachineDescription(typeof text === "string" ? text.trim() : text);
    return record !== null && record.name === folder ? record : null;
  };

  return {
    async make(request, signal) {
      const { machine, configuration, check } = request;
      const description = machineDescription(machine);
      const document = checkSettingsDocument(check);
      const parsed = parseCheckSettings(document);
      if (!parsed.ok) throw new RangeError(`The settings of the check of the machine ${machine.name} are not valid. ${parsed.problems.join(" ")}`);
      if (typeof configuration !== "string" || configuration.length === 0) throw new RangeError(`The configuration of the machine ${machine.name} is empty.`);
      if ((await folders.files(machine.name, signal)) !== null) {
        throw new Error(`The folder ${machine.name} is there. The provider does not write into the folder of a different machine.`);
      }
      await folders.write(machine.name, FOLDER_FILES.machine, `${description}\n`, signal);
      await folders.write(machine.name, FOLDER_FILES.check, `${JSON.stringify(document)}\n`, signal);
      // The configuration comes last: the starter starts only a folder that has it.
      await folders.write(machine.name, FOLDER_FILES.configuration, configuration, signal);
    },

    async machines(signal) {
      const names = await folders.folders(signal);
      if (!Array.isArray(names)) throw new TypeError("The store gave a list of the folders that is not a list.");
      const list: ProviderMachine[] = [];
      for (const name of names) {
        if (!isFolderName(name)) {
          tell(String(name), `The folder ${show(name)} does not have the name of a machine. The provider does not change it.`);
          continue;
        }
        const files = await folders.files(name, signal);
        if (files === null) continue;
        const machine = await recordOf(name, files, signal);
        if (machine === null) {
          // A folder with no file can be the start of a make in a different process. It gets no problem.
          if (files.length > 0) tell(name, `The folder ${name} has no record of a machine with its name. The provider does not change it.`);
          continue;
        }
        list.push({ machine, status: folderStatus(files) });
      }
      return list;
    },

    async destroy(name, signal) {
      if (!isFolderName(name)) throw new RangeError(`The name ${show(name)} is not the name of the folder of a machine.`);
      const files = await folders.files(name, signal);
      if (files === null) return;
      if (files.length > 0 && (await recordOf(name, files, signal)) === null) {
        tell(name, `The folder ${name} has no record of a machine with its name. The provider does not remove it.`);
        return;
      }
      if (files.includes(FOLDER_FILES.started) && !files.includes(FOLDER_FILES.exited)) {
        // The runner operates: the starter stops it and writes `exited`. A destroy after that removes the folder.
        if (!files.includes(FOLDER_FILES.stop)) await folders.write(name, FOLDER_FILES.stop, "", signal);
        return;
      }
      await folders.remove(name, signal);
    },
  };
}
