import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MachineRequest } from "@mark1russell7/runner-dispatch";
import { createFolderProvider, type FolderStore } from "@mark1russell7/runner-dispatch/folder";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FILE_MODE, FOLDER_MODE, nodeFolderStore } from "./folders.ts";

const OPEN = new AbortController().signal;

let base = "";
let root = "";
let store: FolderStore<AbortSignal>;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "runner-dispatch-folders-"));
  root = join(base, "folders");
  store = nodeFolderStore(root);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("nodeFolderStore", () => {
  it("gives an empty list for a root that is not there, and makes the root at the first write", async () => {
    expect(await store.folders(OPEN)).toEqual([]);
    await store.write("rd-1", "machine.json", "{}", OPEN);
    expect(await store.folders(OPEN)).toEqual(["rd-1"]);
    expect(await readFile(join(root, "rd-1", "machine.json"), "utf8")).toBe("{}");
  });

  it("reads and lists the files of a folder in order, and lists only folders in the root and only files in a folder", async () => {
    await store.write("rd-2", "configuration", "jit", OPEN);
    await store.write("rd-2", "check.json", "{}", OPEN);
    await store.write("rd-1", "machine.json", "{}", OPEN);
    await writeFile(join(root, "notes.txt"), "a file in the root");
    await mkdir(join(root, "rd-2", "logs"));
    expect(await store.folders(OPEN)).toEqual(["rd-1", "rd-2"]);
    expect(await store.files("rd-2", OPEN)).toEqual(["check.json", "configuration"]);
    expect(await store.read("rd-2", "configuration", OPEN)).toBe("jit");
  });

  it("gives null for a folder or a file that is not there", async () => {
    expect(await store.files("rd-1", OPEN)).toBeNull();
    expect(await store.read("rd-1", "machine.json", OPEN)).toBeNull();
    await store.write("rd-1", "machine.json", "{}", OPEN);
    expect(await store.read("rd-1", "started", OPEN)).toBeNull();
  });

  it("replaces a file and leaves no temporary file", async () => {
    await store.write("rd-1", "check.json", "old", OPEN);
    await store.write("rd-1", "check.json", "new", OPEN);
    expect(await store.read("rd-1", "check.json", OPEN)).toBe("new");
    expect(await readdir(join(root, "rd-1"))).toEqual(["check.json"]);
  });

  it("removes a folder with its files, and a removal of a folder that is not there does nothing", async () => {
    await store.write("rd-1", "machine.json", "{}", OPEN);
    await store.write("rd-1", "stop", "", OPEN);
    await store.remove("rd-1", OPEN);
    expect(await store.folders(OPEN)).toEqual([]);
    await store.remove("rd-1", OPEN);
  });

  it("refuses each name that is not the name of a folder of a machine, and writes nothing", async () => {
    for (const name of ["..", "../x", "a/b", "A", "", "rd-1/"]) {
      await expect(store.write(name, "machine.json", "{}", OPEN)).rejects.toThrow(RangeError);
      await expect(store.read(name, "machine.json", OPEN)).rejects.toThrow(RangeError);
      await expect(store.files(name, OPEN)).rejects.toThrow(RangeError);
      await expect(store.remove(name, OPEN)).rejects.toThrow(RangeError);
    }
    await expect(readdir(base)).resolves.toEqual([]);
  });

  it("throws for a stopped signal, and writes nothing", async () => {
    const stopped = AbortSignal.abort();
    await expect(store.write("rd-1", "machine.json", "{}", stopped)).rejects.toThrow("The signal stopped");
    await expect(store.folders(stopped)).rejects.toThrow("The signal stopped");
    await expect(readdir(base)).resolves.toEqual([]);
  });

  it.skipIf(process.platform === "win32")("gives each file the mode 0o600 and each folder the mode 0o700", async () => {
    await store.write("rd-1", "configuration", "jit", OPEN);
    expect((await stat(join(root, "rd-1"))).mode & 0o777).toBe(FOLDER_MODE);
    expect((await stat(join(root, "rd-1", "configuration"))).mode & 0o777).toBe(FILE_MODE);
  });

  it("refuses a root that is not absolute and a mode out of range", () => {
    expect(() => nodeFolderStore("folders")).toThrow(RangeError);
    expect(() => nodeFolderStore(root, { fileMode: 0o1000 })).toThrow(RangeError);
    expect(() => nodeFolderStore(root, { folderMode: 1.5 })).toThrow(RangeError);
  });

  it("is a store of the folder provider: a machine that the provider makes is a folder on the disk", async () => {
    const provider = createFolderProvider({ store });
    const run = { repository: "octo/app", runId: 42, runAttempt: 1 };
    const request: MachineRequest = {
      machine: { name: "rd-1", size: "small", ...run },
      configuration: "jit",
      check: { rules: { repositories: ["octo/app"], events: ["push"], actors: ["octo"] }, run },
    };
    await provider.make(request, OPEN);
    expect((await readdir(join(root, "rd-1"))).sort()).toEqual(["check.json", "configuration", "machine.json"]);
    expect(await readFile(join(root, "rd-1", "configuration"), "utf8")).toBe("jit");
    expect(await provider.machines(OPEN)).toEqual([{ machine: request.machine, status: "making" }]);
  });
});
