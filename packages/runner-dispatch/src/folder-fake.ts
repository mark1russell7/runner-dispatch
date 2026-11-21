import type { FolderFile, FolderStore } from "./folder.ts";
import type { StopSignal } from "./ports.ts";

/** This type is one request to a store of folders. */
export type FolderRequest = "folders" | "files" | "read" | "write" | "remove";

/** This record is one change of a store of folders in memory: a write of a file, or a removal of a folder. */
export interface FolderChange {
  readonly kind: "write" | "remove";
  readonly folder: string;
  /** This field is the file of a write. It is `null` for a removal. */
  readonly file: FolderFile | null;
}

/** This record is a store of folders in memory, for a test. */
export interface FakeFolders {
  /** This field is the port of the store. */
  readonly store: FolderStore;
  /** This method gives a copy of each folder, with the text of each file. */
  tree(): ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** This method gives each change that the port made, in its order. A change of `put` or `drop` is not in the list. */
  changes(): readonly FolderChange[];
  /** This method writes a file as a different process writes it, for example the starter. It makes the folder when the folder is not there. */
  put(folder: string, file: string, text: string): void;
  /** This method removes a file as a different process removes it. */
  drop(folder: string, file: string): void;
  /** This method makes each next request of a kind throw, until `heal`. */
  fail(request: FolderRequest): void;
  /** This method makes each request succeed again. */
  heal(): void;
}

/**
 * This function makes a store of folders in memory. A request with a signal that is stopped throws.
 *
 * @returns The store and its controls
 */
export function fakeFolders(): FakeFolders {
  const tree = new Map<string, Map<string, string>>();
  const changes: FolderChange[] = [];
  const failing = new Set<FolderRequest>();

  const open = (request: FolderRequest, signal: StopSignal): void => {
    if (signal.aborted) throw new Error(`The request ${request} has a stopped signal.`);
    if (failing.has(request)) throw new Error(`The store refuses the request ${request}.`);
  };

  const store: FolderStore = {
    async folders(signal) {
      open("folders", signal);
      return [...tree.keys()].sort();
    },
    async files(folder, signal) {
      open("files", signal);
      const files = tree.get(folder);
      return files === undefined ? null : [...files.keys()].sort();
    },
    async read(folder, file, signal) {
      open("read", signal);
      return tree.get(folder)?.get(file) ?? null;
    },
    async write(folder, file, text, signal) {
      open("write", signal);
      const files = tree.get(folder) ?? new Map<string, string>();
      files.set(file, text);
      tree.set(folder, files);
      changes.push({ kind: "write", folder, file });
    },
    async remove(folder, signal) {
      open("remove", signal);
      tree.delete(folder);
      changes.push({ kind: "remove", folder, file: null });
    },
  };

  return {
    store,
    tree: () => new Map([...tree].map(([folder, files]) => [folder, new Map(files)])),
    changes: () => [...changes],
    put(folder, file, text) {
      const files = tree.get(folder) ?? new Map<string, string>();
      files.set(file, text);
      tree.set(folder, files);
    },
    drop(folder, file) {
      tree.get(folder)?.delete(file);
    },
    fail(request) {
      failing.add(request);
    },
    heal() {
      failing.clear();
    },
  };
}
