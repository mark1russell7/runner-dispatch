import { checkSettingsDocument } from "./check.ts";
import { isObject, isRepositoryName, show } from "./policy.ts";
import type { MachineProvider, MachineStatus, ProviderMachine, StopSignal } from "./ports.ts";
import { isId, type MachineRecord } from "./records.ts";

/** This type is the method of a request to the API of Proxmox VE. */
export type ProxmoxMethod = "GET" | "POST" | "PUT" | "DELETE";

/** This record is one request to the API of Proxmox VE. */
export interface ProxmoxRequest {
  /** This field is the method of the request. */
  readonly method: ProxmoxMethod;
  /** This field is the path of the request under `/api2/json`, for example `/cluster/nextid`. */
  readonly path: string;
  /**
   * This field has the parameters of the request.
   * The client sends the parameters of a `POST` or a `PUT` in the body. Thus the access log of the host has no value of them.
   */
  readonly parameters: Readonly<Record<string, string | number>>;
}

/** This record is the answer of Proxmox VE to one request. */
export interface ProxmoxAnswer {
  /** This field is the HTTP status of the answer. */
  readonly status: number;
  /** This field is the text of the status. Proxmox VE puts the text of an error there. */
  readonly message: string;
  /** This field is the field `data` of the JSON body. It is `null` when the body has no data. */
  readonly data: unknown;
}

/**
 * This port is a client of the API of Proxmox VE. The client adds the API token to each request.
 * Each status is an answer. The method throws only when it gets no answer, or when the signal stops the request.
 */
export interface ProxmoxApi<Signal extends StopSignal = StopSignal> {
  /** This method sends one request and gives the answer of Proxmox VE. */
  request(request: ProxmoxRequest, signal: Signal): Promise<ProxmoxAnswer>;
}

/** This record tells how the provider makes a machine of one size. */
export interface ProxmoxSize {
  /** This field is the node of the template. Each machine of the size is on this node. */
  readonly node: string;
  /** This field is the VMID of the template. The provider makes a linked clone of it. */
  readonly template: number;
  /** This field is the count of the processor cores of the machine. When it is absent, the machine has the cores of the template. */
  readonly cores?: number;
  /** This field is the memory of the machine in MiB. When it is absent, the machine has the memory of the template. */
  readonly memory?: number;
}

/** This record has the paths of the two files that the provider writes in the machine. Each path is on a file system in memory. */
export interface MachineFiles {
  /** This field is the path of the document of the check settings. */
  readonly check: string;
  /** This field is the path of the one-job configuration of the runner. The provider writes it last. */
  readonly configuration: string;
}

/** This record has the options of a Proxmox provider. */
export interface ProxmoxProviderOptions<Signal extends StopSignal = StopSignal> {
  /** This field is the client of the API. */
  readonly api: ProxmoxApi<Signal>;
  /** This field is the pool of the machines. The pool has only the machines of this dispatcher, and not the templates. */
  readonly pool: string;
  /** This field has the template of each size of a machine. */
  readonly sizes: Readonly<Record<string, ProxmoxSize>>;
  /** This field has the paths of the files in the machine. The default is `MACHINE_FILES`. */
  readonly files?: MachineFiles;
  /** This function gets each problem of one machine that does not stop the list. A text has no credential. */
  readonly problem?: (text: string) => void;
}

/** This constant has the default paths of the files in a machine. The directory `/run` is a file system in memory. */
export const MACHINE_FILES: MachineFiles = Object.freeze({
  check: "/run/runner-dispatch/check.json",
  configuration: "/run/runner-dispatch/configuration",
});

/** This constant is the format id of the record of a machine in the description of its VM. */
export const MACHINE_DESCRIPTION_FORMAT = "runner-machine/1";

/** This constant is the tag of a VM that has its configuration. */
export const DELIVERED_TAG = "delivered";

/** This constant is the largest content of one file write of the guest agent, in characters. */
export const FILE_WRITE_LIMIT = 61_440;

/** This constant is the count of the tries of the provider to find a free VMID for one machine. */
export const VMID_TRIES = 8;

const NODE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const POOL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const MACHINE_NAME = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SIZE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const TASK = /^UPID:[A-Za-z0-9-]+:[^\s/?#%]+:$/;
const TAKEN = /already exists/i;
const GONE = /does not exist/i;
const NO_AGENT = /no qemu guest agent configured/i;
const RECORD_KEYS: readonly string[] = ["format", "name", "size", "repository", "runId", "runAttempt"];

/** This function tells if a value is a VMID of Proxmox VE: a whole number from 100 to 999999999. */
export function isVmid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 100 && value <= 999_999_999;
}

/** This function tells if a value is the id of a task (a UPID) with no character that changes a path. */
const isTask = (value: unknown): value is string => typeof value === "string" && TASK.test(value);

/** This function gives the node of a task. The node is the second field of the UPID. */
const nodeOfTask = (task: string): string => task.split(":")[1] ?? "";

/** This function gives the problems of the record of a machine. */
function recordProblems(machine: MachineRecord): string[] {
  const problems: string[] = [];
  if (typeof machine.name !== "string" || !MACHINE_NAME.test(machine.name)) {
    problems.push(`The name ${show(machine.name)} is not a name of a VM: a small letter, then 62 small letters, digits or hyphens at most.`);
  }
  if (typeof machine.size !== "string" || !SIZE_NAME.test(machine.size)) problems.push(`The size ${show(machine.size)} is not a size name.`);
  if (!isRepositoryName(machine.repository)) problems.push(`The repository ${show(machine.repository)} is not a name as owner/name.`);
  if (!isId(machine.runId)) problems.push("The id of the run is not a whole number from 1.");
  if (!isId(machine.runAttempt)) problems.push("The number of the try is not a whole number from 1.");
  return problems;
}

/**
 * This function gives the description of the VM of a machine: its record as JSON, with no credential.
 * Each account that can read the VM can read the description.
 *
 * @param machine - The record of the machine
 * @returns The JSON text of the record, with the format id
 * @throws RangeError when the record is not valid
 */
export function machineDescription(machine: MachineRecord): string {
  const problems = recordProblems(machine);
  if (problems.length > 0) throw new RangeError(`The record of the machine is not valid. ${problems.join(" ")}`);
  const { name, size, repository, runId, runAttempt } = machine;
  return JSON.stringify({ format: MACHINE_DESCRIPTION_FORMAT, name, size, repository, runId, runAttempt });
}

/**
 * This function reads the record of a machine from the description of its VM. It does not throw.
 *
 * @param description - The description of the VM
 * @returns The record, or `null` when the description is not the record of a machine
 */
export function parseMachineDescription(description: unknown): MachineRecord | null {
  if (typeof description !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(description);
  } catch {
    return null;
  }
  if (!isObject(value) || value["format"] !== MACHINE_DESCRIPTION_FORMAT) return null;
  if (Object.keys(value).some((key) => !RECORD_KEYS.includes(key))) return null;
  const machine = {
    name: value["name"],
    size: value["size"],
    repository: value["repository"],
    runId: value["runId"],
    runAttempt: value["runAttempt"],
  } as MachineRecord;
  return recordProblems(machine).length === 0 ? Object.freeze(machine) : null;
}

/** This function gives the problems of the options of a provider. */
function optionsProblems(options: ProxmoxProviderOptions<StopSignal>): string[] {
  const problems: string[] = [];
  if (!isObject(options.api) || typeof options.api.request !== "function") problems.push("The field api has no method request.");
  if (typeof options.pool !== "string" || !POOL.test(options.pool)) problems.push(`The pool ${show(options.pool)} is not the name of a pool.`);
  const sizes = isObject(options.sizes) ? Object.entries(options.sizes) : [];
  if (sizes.length === 0) problems.push("The field sizes has no size.");
  for (const [name, size] of sizes) {
    const where = `The size ${show(name)}`;
    if (!SIZE_NAME.test(name)) problems.push(`${where} is not a size name.`);
    if (!isObject(size)) {
      problems.push(`${where} is not an object.`);
      continue;
    }
    if (typeof size["node"] !== "string" || !NODE.test(size["node"])) problems.push(`${where} has a node that is not the name of a node.`);
    if (!isVmid(size["template"])) problems.push(`${where} has a template that is not a VMID.`);
    const cores = size["cores"];
    if (cores !== undefined && !(Number.isSafeInteger(cores) && (cores as number) >= 1 && (cores as number) <= 1024)) {
      problems.push(`${where} has a count of cores that is not a whole number from 1 to 1024.`);
    }
    const memory = size["memory"];
    if (memory !== undefined && !(Number.isSafeInteger(memory) && (memory as number) >= 16)) {
      problems.push(`${where} has a memory that is not a whole number of MiB from 16.`);
    }
  }
  const files = options.files ?? MACHINE_FILES;
  const path = (value: unknown): boolean => typeof value === "string" && /^\/[^\0]+$/.test(value) && !value.endsWith("/");
  if (!isObject(files) || !path(files.check) || !path(files.configuration) || files.check === files.configuration) {
    problems.push("The field files does not have two different absolute paths of files.");
  }
  return problems;
}

/** This record is one VM of the pool, as the list of the cluster shows it. */
interface Row {
  readonly vmid: number;
  readonly node: string;
  readonly name: string;
  readonly status: string;
  readonly lock: string;
  readonly tags: readonly string[];
}

/** This function gives the text of a value, or the empty text. */
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** This function gives the tags of a VM. Proxmox VE accepts semicolons, commas and spaces between two tags. */
const tagsOf = (value: unknown): readonly string[] => text(value).split(/[;,\s]+/).filter((tag) => tag.length > 0);

/**
 * This function reads the VMs of a pool from the list of the resources of the cluster. A template is not a VM of the pool.
 * It gives `null` when a VM of the pool has no readable VMID or node.
 */
function rowsOf(data: unknown, pool: string): Row[] | null {
  if (!Array.isArray(data)) return null;
  const rows: Row[] = [];
  for (const item of data) {
    if (!isObject(item) || item["type"] !== "qemu" || item["pool"] !== pool || item["template"] === 1) continue;
    const vmid = item["vmid"];
    const node = item["node"];
    if (!isVmid(vmid) || typeof node !== "string" || !NODE.test(node)) return null;
    rows.push({ vmid, node, name: text(item["name"]), status: text(item["status"]), lock: text(item["lock"]), tags: tagsOf(item["tags"]) });
  }
  return rows;
}

/** This type is the state of a task of Proxmox VE. */
type TaskState =
  | { readonly kind: "running" }
  | { readonly kind: "ok" }
  | { readonly kind: "failed"; readonly text: string }
  | { readonly kind: "unknown"; readonly text: string };

/** This type is the step of a machine that the provider makes. */
type Stage =
  | { readonly kind: "cloning"; readonly task: string }
  | { readonly kind: "starting"; readonly task: string }
  | { readonly kind: "booting" }
  | { readonly kind: "tagging" }
  | { readonly kind: "failed" };

/** This record is a machine that the provider makes. The process memory is the only place of its configuration. */
interface Making {
  readonly machine: MachineRecord;
  readonly size: ProxmoxSize;
  readonly vmid: number;
  readonly check: string;
  configuration: string | null;
  stage: Stage;
  noted: boolean;
}

/** This record is a machine that the provider destroys. */
interface Ending {
  readonly machine: MachineRecord;
  readonly vmid: number;
  task: string | null;
}

/**
 * This function makes a provider of the machines on Proxmox VE. Each machine is a linked clone of the template of its size, in one pool.
 *
 * - The description of each VM has the record of its machine. The provider finds its machines from the pool and these records.
 * - The method `machines` also moves each machine to its next step: the size, the start, and the files through the guest agent.
 * - The configuration goes only in the body of one file write, and the provider keeps it only in the process memory.
 * - A VM with no tag `delivered` and with no configuration in the memory cannot operate. The provider shows it as stopped.
 * - The provider stops and deletes only a VM of the pool with the record of the machine.
 *
 * @param options - The client of the API, the pool, the sizes, the paths of the files and the receiver of the problems
 * @returns The provider
 * @throws RangeError when the options are not valid
 */
export function createProxmoxProvider<Signal extends StopSignal = StopSignal>(options: ProxmoxProviderOptions<Signal>): MachineProvider<Signal> {
  const problems = optionsProblems(options as ProxmoxProviderOptions<StopSignal>);
  if (problems.length > 0) throw new RangeError(`The options of the Proxmox provider are not valid. ${problems.join(" ")}`);
  const { api, pool } = options;
  const files = options.files ?? MACHINE_FILES;
  const sizes = new Map(Object.entries(options.sizes));
  const making = new Map<string, Making>();
  const ending = new Map<string, Ending>();
  const picking = new Set<number>();
  const records = new Map<number, { readonly name: string; readonly machine: MachineRecord | null }>();

  const tell = (problem: string): void => {
    try {
      options.problem?.(problem);
    } catch {
      // A receiver that throws does not stop the provider.
    }
  };
  const call = (method: ProxmoxMethod, path: string, parameters: Readonly<Record<string, string | number>>, signal: Signal) =>
    api.request({ method, path, parameters }, signal);
  const vmPath = (node: string, vmid: number): string => `/nodes/${node}/qemu/${vmid}`;
  const said = (answer: ProxmoxAnswer): string => `the status ${answer.status}, ${show(answer.message)}`;

  const list = async (signal: Signal): Promise<Row[]> => {
    const answer = await call("GET", "/cluster/resources", { type: "vm" }, signal);
    if (answer.status !== 200) throw new Error(`Proxmox VE did not list the VMs: ${said(answer)}.`);
    const rows = rowsOf(answer.data, pool);
    if (rows === null) throw new Error("Proxmox VE gave a list of the VMs that is not readable.");
    return rows;
  };

  /** This function gives the record of the machine of a VM. It gives `null` for a VM that is not a machine of this provider. */
  const recordOf = async (row: Row, signal: Signal): Promise<MachineRecord | null> => {
    const known = records.get(row.vmid);
    if (known !== undefined && known.name === row.name) return known.machine;
    // A VM that the provider deletes has no description. The provider read the record of each of its machines before.
    if (row.lock === "destroyed") return null;
    const answer = await call("GET", `${vmPath(row.node, row.vmid)}/config`, {}, signal);
    if (answer.status !== 200 || !isObject(answer.data)) {
      if (GONE.test(answer.message)) return null;
      throw new Error(`Proxmox VE did not give the configuration of the VM ${row.vmid}: ${said(answer)}.`);
    }
    const parsed = parseMachineDescription(answer.data["description"]);
    const machine = parsed !== null && parsed.name === row.name ? parsed : null;
    if (machine === null) tell(`The VM ${row.vmid} of the pool ${show(pool)} has no record of a machine with its name. The provider does not touch it.`);
    records.set(row.vmid, { name: row.name, machine });
    return machine;
  };

  const taskOf = async (task: string, signal: Signal): Promise<TaskState> => {
    const answer = await call("GET", `/nodes/${nodeOfTask(task)}/tasks/${task}/status`, {}, signal);
    if (answer.status !== 200 || !isObject(answer.data)) return { kind: "unknown", text: said(answer) };
    if (answer.data["status"] === "running") return { kind: "running" };
    if (answer.data["status"] !== "stopped") return { kind: "unknown", text: `the task status ${show(answer.data["status"])}` };
    const exit = text(answer.data["exitstatus"]);
    return exit === "OK" || /^WARNINGS: \d+$/.test(exit) ? { kind: "ok" } : { kind: "failed", text: exit };
  };

  /** This function stops the work on a machine that cannot operate. The configuration leaves the memory. */
  const fail = (entry: Making, problem: string): MachineStatus => {
    entry.stage = { kind: "failed" };
    entry.configuration = null;
    tell(problem);
    return "stopped";
  };

  const write = async (entry: Making, row: Row, file: string, content: string, secret: boolean, signal: Signal): Promise<boolean> => {
    const answer = await call("POST", `${vmPath(row.node, row.vmid)}/agent/file-write`, { file, content }, signal);
    if (answer.status === 200) return true;
    // The text of the answer to the write of a credential can have a part of the credential. Thus the problem has only the status.
    const reason = secret ? `the status ${answer.status}` : said(answer);
    tell(`Proxmox VE did not write the file ${show(file)} in the machine ${show(entry.machine.name)}: ${reason}.`);
    return false;
  };

  /** This function moves a machine that the provider makes to its next step, and gives its status. */
  const advanceMaking = async (entry: Making, row: Row | null, signal: Signal): Promise<MachineStatus> => {
    const name = show(entry.machine.name);
    const stage = entry.stage;
    switch (stage.kind) {
      case "failed":
        return "stopped";
      case "cloning": {
        const task = await taskOf(stage.task, signal);
        if (task.kind === "failed") return fail(entry, `The clone of the machine ${name} failed: ${show(task.text)}.`);
        if (task.kind === "unknown") tell(`Proxmox VE did not give the state of the clone of the machine ${name}: ${task.text}.`);
        // The VM joins the pool at the end of the clone. Until the list shows it, the machine waits.
        if (task.kind !== "ok" || row === null) return "making";
        const change: Record<string, string | number> = {};
        if (entry.size.cores !== undefined) change["cores"] = entry.size.cores;
        if (entry.size.memory !== undefined) change["memory"] = entry.size.memory;
        // A clone gets the tags of its template. A tag `delivered` of the template does not tell that this machine has its configuration.
        if (row.tags.includes(DELIVERED_TAG)) {
          const kept = row.tags.filter((tag) => tag !== DELIVERED_TAG);
          if (kept.length > 0) change["tags"] = kept.join(";");
          else change["delete"] = "tags";
        }
        if (Object.keys(change).length > 0) {
          const answer = await call("PUT", `${vmPath(row.node, row.vmid)}/config`, change, signal);
          if (answer.status !== 200) return fail(entry, `Proxmox VE did not set the size of the machine ${name}: ${said(answer)}.`);
        }
        const start = await call("POST", `${vmPath(row.node, row.vmid)}/status/start`, {}, signal);
        if (start.status !== 200 || !isTask(start.data)) return fail(entry, `Proxmox VE did not start the machine ${name}: ${said(start)}.`);
        entry.stage = { kind: "starting", task: start.data };
        return "making";
      }
      case "starting": {
        const task = await taskOf(stage.task, signal);
        if (task.kind === "failed") return fail(entry, `The start of the machine ${name} failed: ${show(task.text)}.`);
        if (task.kind === "unknown") tell(`Proxmox VE did not give the state of the start of the machine ${name}: ${task.text}.`);
        // The row of this list can be older than the end of the start. Thus the next list reads the machine.
        if (task.kind === "ok") entry.stage = { kind: "booting" };
        return "making";
      }
      case "booting": {
        // The VM was in the pool before its start. When the list does not show it, an operator removed it.
        if (row === null) return fail(entry, `The machine ${name} is not in the pool.`);
        if (row.status !== "running") return fail(entry, `The machine ${name} stopped before it got its configuration.`);
        const ping = await call("POST", `${vmPath(row.node, row.vmid)}/agent/ping`, {}, signal);
        if (ping.status !== 200) {
          if (NO_AGENT.test(ping.message) && !entry.noted) {
            entry.noted = true;
            tell(`The machine ${name} has no guest agent. The template of the size ${show(entry.machine.size)} needs the option agent 1.`);
          }
          return "making";
        }
        const configuration = entry.configuration;
        if (configuration === null) return "stopped";
        if (!(await write(entry, row, files.check, entry.check, false, signal))) return "making";
        if (!(await write(entry, row, files.configuration, configuration, true, signal))) return "making";
        entry.configuration = null;
        entry.stage = { kind: "tagging" };
        return advanceMaking(entry, row, signal);
      }
      case "tagging": {
        if (row === null) return "operating";
        const tags = [...row.tags.filter((tag) => tag !== DELIVERED_TAG), DELIVERED_TAG].join(";");
        const answer = await call("PUT", `${vmPath(row.node, row.vmid)}/config`, { tags }, signal);
        // The machine has its configuration. When the tag fails, the provider tries it again at the next list.
        if (answer.status !== 200) tell(`Proxmox VE did not tag the machine ${name}: ${said(answer)}.`);
        else making.delete(entry.machine.name);
        return "operating";
      }
    }
  };

  /** This function moves a machine that the provider destroys to its next step. It gives `null` when the machine is not there. */
  const advanceEnding = async (entry: Ending, row: Row | null, signal: Signal): Promise<MachineStatus | null> => {
    const name = show(entry.machine.name);
    if (entry.task !== null) {
      const task = await taskOf(entry.task, signal);
      if (task.kind === "running") return "stopped";
      if (task.kind === "unknown") {
        tell(`Proxmox VE did not give the state of a task of the machine ${name}: ${task.text}.`);
        return "stopped";
      }
      if (task.kind === "failed") tell(`A task of the machine ${name} failed: ${show(task.text)}.`);
      entry.task = null;
      // The row of this list can be older than the end of the task. Thus the next list reads the machine.
      return "stopped";
    }
    if (row === null) {
      ending.delete(entry.machine.name);
      records.delete(entry.vmid);
      return null;
    }
    if (row.lock === "destroyed") return "stopped";
    if (row.status === "running") {
      const answer = await call("POST", `${vmPath(row.node, row.vmid)}/status/stop`, {}, signal);
      if (answer.status === 200 && isTask(answer.data)) entry.task = answer.data;
      else tell(`Proxmox VE did not stop the machine ${name}: ${said(answer)}.`);
      return "stopped";
    }
    // Another task holds the VM, for example a backup. The provider tries again at the next list.
    if (row.lock !== "") return "stopped";
    const answer = await call("DELETE", vmPath(row.node, row.vmid), { purge: 1, "destroy-unreferenced-disks": 1 }, signal);
    if (answer.status === 200 && isTask(answer.data)) {
      entry.task = answer.data;
      return "stopped";
    }
    if (GONE.test(answer.message)) {
      ending.delete(entry.machine.name);
      records.delete(entry.vmid);
      return null;
    }
    tell(`Proxmox VE did not delete the machine ${name}: ${said(answer)}.`);
    return "stopped";
  };

  /** This function moves a machine to its next step, and gives its status. It gives `null` when the machine is not there. */
  const advance = async (machine: MachineRecord, row: Row | null, signal: Signal): Promise<MachineStatus | null> => {
    const end = ending.get(machine.name);
    if (end !== undefined) return advanceEnding(end, row, signal);
    const entry = making.get(machine.name);
    if (entry !== undefined) return advanceMaking(entry, row, signal);
    if (row === null) return null;
    return row.status === "running" && row.tags.includes(DELIVERED_TAG) ? "operating" : "stopped";
  };

  /** This function tells if a VMID is taken by a machine of this provider that the list does not show yet. */
  const claimed = (vmid: number): boolean =>
    picking.has(vmid) || [...making.values()].some((each) => each.vmid === vmid) || [...ending.values()].some((each) => each.vmid === vmid);

  /** This function finds a VMID that is free in Proxmox VE and not taken by a clone of this provider. */
  const freeVmid = async (signal: Signal): Promise<number> => {
    let candidate: number | null = null;
    for (let step = 0; step < VMID_TRIES; step += 1) {
      const answer = await call("GET", "/cluster/nextid", candidate === null ? {} : { vmid: candidate }, signal);
      const vmid = typeof answer.data === "string" || typeof answer.data === "number" ? Number(answer.data) : Number.NaN;
      const free = answer.status === 200 && isVmid(vmid) && (candidate === null || vmid === candidate);
      if (free && !claimed(vmid)) {
        picking.add(vmid);
        return vmid;
      }
      if (candidate === null && !free) throw new Error(`Proxmox VE gave no free VMID: ${said(answer)}.`);
      candidate = (candidate ?? vmid) + 1;
    }
    throw new Error(`The provider found no free VMID in ${VMID_TRIES} tries.`);
  };

  return {
    async make(request, signal) {
      const { machine, configuration } = request;
      const description = machineDescription(machine);
      const size = sizes.get(machine.size);
      if (size === undefined) throw new RangeError(`The size ${show(machine.size)} has no template.`);
      if (making.has(machine.name) || ending.has(machine.name)) throw new RangeError(`The provider has a machine with the name ${show(machine.name)}.`);
      if (typeof configuration !== "string" || configuration.length === 0 || configuration.length > FILE_WRITE_LIMIT) {
        throw new RangeError(`The configuration of the runner is empty, or it is longer than ${FILE_WRITE_LIMIT} characters.`);
      }
      const check = JSON.stringify(checkSettingsDocument(request.check));
      if (check.length > FILE_WRITE_LIMIT) throw new RangeError(`The document of the check is longer than ${FILE_WRITE_LIMIT} characters.`);
      for (let attempt = 1; ; attempt += 1) {
        const vmid = await freeVmid(signal);
        let answer: ProxmoxAnswer;
        try {
          answer = await call("POST", `${vmPath(size.node, size.template)}/clone`, { newid: vmid, name: machine.name, pool, description }, signal);
        } finally {
          picking.delete(vmid);
        }
        if (answer.status === 200 && isTask(answer.data)) {
          making.set(machine.name, { machine, size, vmid, check, configuration, stage: { kind: "cloning", task: answer.data }, noted: false });
          return;
        }
        // Two clones can get the same free VMID. The clone that comes second fails, and it tries a new VMID.
        if (!TAKEN.test(answer.message) || attempt >= VMID_TRIES) {
          throw new Error(`Proxmox VE did not clone the template ${size.template} for the machine ${show(machine.name)}: ${said(answer)}.`);
        }
      }
    },

    async machines(signal) {
      const rows = await list(signal);
      const found = await Promise.all(rows.map(async (row) => ({ row, machine: await recordOf(row, signal) })));
      const byName = new Map<string, { readonly row: Row; readonly machine: MachineRecord }>();
      for (const each of found) {
        if (each.machine === null) continue;
        const name = each.machine.name;
        const other = byName.get(name);
        if (other === undefined) {
          byName.set(name, { row: each.row, machine: each.machine });
          continue;
        }
        // A clone of a machine copies its description. The provider uses only the VM that it made.
        tell(`The VMs ${other.row.vmid} and ${each.row.vmid} have the record of the machine ${show(name)}.`);
        const vmid = (making.get(name) ?? ending.get(name))?.vmid;
        if (each.row.vmid === vmid) byName.set(name, { row: each.row, machine: each.machine });
      }
      const listed = [...byName.values()];
      const seen = new Set(byName.keys());
      const unseen: MachineRecord[] = [];
      for (const each of [...making.values(), ...ending.values()]) {
        if (!seen.has(each.machine.name) && !unseen.some((other) => other.name === each.machine.name)) unseen.push(each.machine);
      }
      const steps: { readonly row: Row | null; readonly machine: MachineRecord }[] = [...listed, ...unseen.map((machine) => ({ row: null, machine }))];
      const statuses = await Promise.all(steps.map((each) => advance(each.machine, each.row, signal)));
      const vmids = new Set(rows.map((row) => row.vmid));
      for (const vmid of records.keys()) if (!vmids.has(vmid)) records.delete(vmid);
      const shown: ProviderMachine[] = [];
      steps.forEach((each, index) => {
        const status = statuses[index];
        if (status !== null && status !== undefined) shown.push({ machine: each.machine, status });
      });
      return shown;
    },

    async destroy(name, signal) {
      const entry = making.get(name);
      if (entry !== undefined) {
        making.delete(name);
        const stage = entry.stage;
        const task = stage.kind === "cloning" || stage.kind === "starting" ? stage.task : null;
        ending.set(name, { machine: entry.machine, vmid: entry.vmid, task });
      }
      const rows = await list(signal);
      let row: Row | null = null;
      let machine: MachineRecord | null = null;
      for (const each of rows) {
        if (each.name !== name) continue;
        const record = await recordOf(each, signal);
        if (record !== null) {
          row = each;
          machine = record;
          break;
        }
      }
      let end = ending.get(name);
      if (end === undefined) {
        if (row === null || machine === null) return;
        end = { machine, vmid: row.vmid, task: null };
        ending.set(name, end);
      }
      await advanceEnding(end, row, signal);
    },
  };
}
