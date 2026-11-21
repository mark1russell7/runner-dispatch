/**
 * The store of the folder provider on Node.js: one folder for each machine, in one root folder.
 *
 * Each write goes through `writeFileAtomic` of `@procedures/fs/files`. Thus a starter sees the old file or the complete new file.
 */
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isFolderName, type FolderFile, type FolderStore } from "@mark1russell7/runner-dispatch/folder";
import { writeFileAtomic } from "@procedures/fs/files";

/** This constant is the default mode of a file of a folder: only its owner can read and write it. */
export const FILE_MODE = 0o600;

/** This constant is the default mode of a folder: only its owner can read it, write in it and open it. */
export const FOLDER_MODE = 0o700;

/** These are the options of the store of the folders on Node.js. */
export interface NodeFolderOptions {
  /** This field is the mode of each file that the store writes. The default is `FILE_MODE`. */
  readonly fileMode?: number | undefined;
  /** This field is the mode of each folder that the store makes. The default is `FOLDER_MODE`. */
  readonly folderMode?: number | undefined;
}

/** This function gives the code of an error of Node.js, or `undefined`. */
const codeOf = (error: unknown): string | undefined => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : undefined;
};

/** This function throws when the signal stopped. */
const open = (signal: AbortSignal): void => {
  if (signal.aborted) throw new Error("The signal stopped the request of the store of the folders.");
};

/**
 * This function makes the store of the folder provider on Node.js. The root folder holds one folder for each machine.
 *
 * - A list of a root that is not there is empty. The first write makes the root.
 * - The store refuses each name that is not the name of a folder of a machine, also when the provider examined it.
 * - The store does not follow a symlink in a list. A write of a file follows a symlink, as `writeFileAtomic` does.
 *   Thus only the accounts of the dispatcher and of the starter can write in the root.
 *
 * @param root - The absolute path of the root folder
 * @param options - The modes of the files and of the folders
 * @returns The store
 * @throws RangeError when the root is not an absolute path, or a mode is not a whole number from 0 to 0o777
 */
export function nodeFolderStore(root: string, options: NodeFolderOptions = {}): FolderStore<AbortSignal> {
  if (typeof root !== "string" || !isAbsolute(root)) throw new RangeError("The root of the folders is not an absolute path.");
  const fileMode = options.fileMode ?? FILE_MODE;
  const folderMode = options.folderMode ?? FOLDER_MODE;
  for (const mode of [fileMode, folderMode]) {
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new RangeError("A mode of the store of the folders is not a whole number from 0 to 0o777.");
  }

  const pathOf = (folder: string): string => {
    if (!isFolderName(folder)) throw new RangeError("The store of the folders refuses a name that is not the name of a folder of a machine.");
    return join(root, folder);
  };

  return {
    async folders(signal) {
      open(signal);
      try {
        const entries = await readdir(root, { withFileTypes: true });
        return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
      } catch (error) {
        if (codeOf(error) === "ENOENT") return [];
        throw error;
      }
    },
    async files(folder, signal) {
      open(signal);
      try {
        const entries = await readdir(pathOf(folder), { withFileTypes: true });
        return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
      } catch (error) {
        const code = codeOf(error);
        if (code === "ENOENT" || code === "ENOTDIR") return null;
        throw error;
      }
    },
    async read(folder: string, file: FolderFile, signal) {
      open(signal);
      try {
        return await readFile(join(pathOf(folder), file), { encoding: "utf8", signal });
      } catch (error) {
        const code = codeOf(error);
        if (code === "ENOENT" || code === "ENOTDIR") return null;
        throw error;
      }
    },
    async write(folder: string, file: FolderFile, text: string, signal) {
      open(signal);
      const path = pathOf(folder);
      await mkdir(path, { recursive: true, mode: folderMode });
      open(signal);
      await writeFileAtomic(join(path, file), text, { mode: fileMode });
    },
    async remove(folder, signal) {
      open(signal);
      await rm(pathOf(folder), { recursive: true, force: true });
    },
  };
}
