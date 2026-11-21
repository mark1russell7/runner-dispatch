/**
 * The store of the folder provider on Node.js: one folder for each machine, in one root folder.
 *
 * Each write goes through `writeFileAtomic` of `@procedures/fs/files`. Thus a starter sees the old file or the complete new file.
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { FOLDER_FILES, isFolderName, type FolderFile, type FolderStore } from "@mark1russell7/runner-dispatch/folder";
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

/** This store is a store of the folders with the two requests of a starter. */
export interface StarterStore extends FolderStore<AbortSignal> {
  /**
   * This method writes a file only when the file is not there. It tells if it wrote the file.
   * Thus two starters do not start the runner of one folder.
   */
  create(folder: string, file: FolderFile, text: string, signal: AbortSignal): Promise<boolean>;
  /** This method removes one file of a folder. A file that is not there is not an error. */
  removeFile(folder: string, file: FolderFile, signal: AbortSignal): Promise<void>;
}

const FILES: ReadonlySet<string> = new Set(Object.values(FOLDER_FILES));

/**
 * This function gives the path of a file of a folder in the root. The starter gives the path of `check.json` to the check.
 *
 * @param root - The absolute path of the root folder
 * @param folder - The name of the folder of a machine
 * @param file - The name of a file of a folder
 * @returns The path of the file
 * @throws RangeError when the name of the folder or of the file is not valid
 */
export function folderFilePath(root: string, folder: string, file: FolderFile): string {
  if (!isFolderName(folder)) throw new RangeError("The store of the folders refuses a name that is not the name of a folder of a machine.");
  if (!FILES.has(file)) throw new RangeError("The store of the folders refuses a name that is not the name of a file of a folder.");
  return join(root, folder, file);
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
 * - The store refuses each name that is not the name of a folder of a machine or of a file of a folder.
 * - The store does not follow a symlink in a list. A write of a file follows a symlink, as `writeFileAtomic` does.
 *   Thus only the accounts of the dispatcher and of the starter can write in the root.
 *
 * @param root - The absolute path of the root folder
 * @param options - The modes of the files and of the folders
 * @returns The store, with the requests of a starter
 * @throws RangeError when the root is not an absolute path, or a mode is not a whole number from 0 to 0o777
 */
export function nodeFolderStore(root: string, options: NodeFolderOptions = {}): StarterStore {
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
        return await readFile(folderFilePath(root, folder, file), { encoding: "utf8", signal });
      } catch (error) {
        const code = codeOf(error);
        if (code === "ENOENT" || code === "ENOTDIR") return null;
        throw error;
      }
    },
    async write(folder: string, file: FolderFile, text: string, signal) {
      open(signal);
      const path = folderFilePath(root, folder, file);
      await mkdir(pathOf(folder), { recursive: true, mode: folderMode });
      open(signal);
      await writeFileAtomic(path, text, { mode: fileMode });
    },
    async create(folder: string, file: FolderFile, text: string, signal: AbortSignal) {
      open(signal);
      try {
        await writeFile(folderFilePath(root, folder, file), text, { flag: "wx", mode: fileMode, signal });
        return true;
      } catch (error) {
        if (codeOf(error) === "EEXIST") return false;
        throw error;
      }
    },
    async removeFile(folder: string, file: FolderFile, signal: AbortSignal) {
      open(signal);
      await rm(folderFilePath(root, folder, file), { force: true });
    },
    async remove(folder, signal) {
      open(signal);
      await rm(pathOf(folder), { recursive: true, force: true });
    },
  };
}
