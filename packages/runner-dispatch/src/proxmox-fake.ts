import { FILE_WRITE_LIMIT, isVmid, type ProxmoxAnswer, type ProxmoxApi, type ProxmoxRequest } from "./proxmox.ts";

/** This record is one VM of a fake Proxmox VE. A test reads it, and it can change it. */
export interface FakeVm {
  /** This field is the VMID. */
  readonly vmid: number;
  /** This field is the node of the VM. */
  readonly node: string;
  /** This field is the name of the VM. */
  name: string;
  /** This field is the description of the VM. */
  description: string;
  /** This field is the pool of the VM. It is `null` when the VM is in no pool. */
  pool: string | null;
  /** This list has the tags of the VM. */
  tags: string[];
  /** This field is the status of the QEMU process. */
  status: "running" | "stopped";
  /** This field is the lock of the configuration, or the empty text. */
  lock: string;
  /** This field is `true` for a template. */
  readonly template: boolean;
  /** This field is `true` when the configuration has the option `agent: 1`. */
  readonly agent: boolean;
  /** This field is the count of the processor cores. */
  cores: number;
  /** This field is the memory in MiB. */
  memory: number;
  /** This field is the count of the ticks until the guest agent answers. */
  boot: number;
  /** This map has each file that the guest agent wrote, by its path. */
  readonly files: Map<string, string>;
}

/** This type is the kind of a task of a fake Proxmox VE. */
export type FakeTaskKind = "clone" | "start" | "stop" | "delete";

/** This record has the options of a fake Proxmox VE. */
export interface FakeProxmoxOptions {
  /** This field is the pool of the token. The token can read and change only the VMs of this pool, and clone the templates. */
  readonly pool: string;
  /** This list has the templates. A template is in no pool. */
  readonly templates: readonly { readonly vmid: number; readonly node: string; readonly agent?: boolean; readonly tags?: readonly string[] }[];
  /** This field has the count of the ticks of each kind of task, and of the boot of a guest. The default of each is 1. */
  readonly ticks?: Partial<Readonly<Record<FakeTaskKind | "boot", number>>>;
}

/** This record is a fake Proxmox VE: a client of its API, and the controls of a test. */
export interface FakeProxmox {
  /** This field is the client of the API, with the rights of a token on the pool. */
  readonly api: ProxmoxApi;
  /** This list has each request that the client got, in order. */
  readonly requests: readonly ProxmoxRequest[];
  /** This method gives a VM, or `undefined`. */
  vm(vmid: number): FakeVm | undefined;
  /** This method gives each VM, also each template. */
  vms(): readonly FakeVm[];
  /** This method moves each task and each boot of a guest by one tick, or by the count. */
  tick(count?: number): void;
  /** This method gives the answer to the next request that matches, in place of the work of the request. */
  answerNext(match: (request: ProxmoxRequest) => boolean, answer: ProxmoxAnswer): void;
  /** This method makes the next task of the kind fail with the text. */
  failNext(kind: FakeTaskKind, text: string): void;
  /** This method adds a stopped VM that the provider did not make. It is in the pool only when `inPool` is `true`. */
  occupy(vmid: number, node: string, inPool?: boolean): void;
  /** This method stops the QEMU process of a VM, as a power-off in the guest does. */
  powerOff(vmid: number): void;
  /** This method removes a VM, as an operator does. */
  remove(vmid: number): void;
}

const TASK_TYPES: Readonly<Record<FakeTaskKind, string>> = { clone: "qmclone", start: "qmstart", stop: "qmstop", delete: "qmdestroy" };

interface FakeTask {
  readonly node: string;
  left: number;
  exit: string | null;
  readonly failure: string | undefined;
  readonly finish: () => void;
  readonly undo: () => void;
}

/**
 * This function makes a fake Proxmox VE for tests. It copies these facts of Proxmox VE 9:
 *
 * - A clone is a task. The new VM has the lock `clone`, and it joins the pool at the end of the task.
 * - The token reads and changes only the VMs of its pool. A request on another VM gets the status 403.
 * - A start, a stop and a delete are tasks. A VM with a lock refuses a start and a delete, and a running VM refuses a delete.
 * - The guest agent answers only some ticks after the start, and only with the option `agent: 1`.
 *
 * @param options - The pool of the token, the templates and the counts of the ticks
 * @returns The fake
 */
export function fakeProxmox(options: FakeProxmoxOptions): FakeProxmox {
  const ticks = { clone: 1, start: 1, stop: 1, delete: 1, boot: 1, ...options.ticks };
  const vms = new Map<number, FakeVm>();
  const tasks = new Map<string, FakeTask>();
  const failures = new Map<FakeTaskKind, string[]>();
  const canned: { readonly match: (request: ProxmoxRequest) => boolean; readonly answer: ProxmoxAnswer }[] = [];
  const requests: ProxmoxRequest[] = [];
  let count = 0;

  const vmOf = (vmid: number, node: string, template: boolean, agent: boolean, tags: readonly string[]): FakeVm => ({
    vmid,
    node,
    name: `vm-${vmid}`,
    description: "",
    pool: null,
    tags: [...tags],
    status: "stopped",
    lock: "",
    template,
    agent,
    cores: 1,
    memory: 1024,
    boot: 0,
    files: new Map(),
  });
  for (const template of options.templates) {
    vms.set(template.vmid, vmOf(template.vmid, template.node, true, template.agent ?? true, template.tags ?? []));
  }

  const answer = (status: number, data: unknown = null, message = status === 200 ? "OK" : "error"): ProxmoxAnswer => ({ status, message, data });
  const denied = (vmid: number, privilege: string): ProxmoxAnswer => answer(403, null, `Permission check failed (/vms/${vmid}, ${privilege})`);
  const locked = (vm: FakeVm): ProxmoxAnswer => answer(500, null, `VM is locked (${vm.lock})`);

  const startTask = (kind: FakeTaskKind, vm: FakeVm, finish: () => void, undo: () => void = () => {}): string => {
    count += 1;
    const hex = (value: number): string => value.toString(16).toUpperCase().padStart(8, "0");
    const task = `UPID:${vm.node}:${hex(4000 + count)}:${hex(count)}:${hex(1_800_000_000 + count)}:${TASK_TYPES[kind]}:${vm.vmid}:dispatch@pve!runner:`;
    tasks.set(task, { node: vm.node, left: ticks[kind], exit: null, failure: failures.get(kind)?.shift(), finish, undo });
    return task;
  };

  const tick = (): void => {
    for (const vm of vms.values()) if (vm.status === "running" && vm.boot > 0) vm.boot -= 1;
    for (const task of tasks.values()) {
      if (task.exit !== null) continue;
      task.left -= 1;
      if (task.left > 0) continue;
      if (task.failure === undefined) {
        task.exit = "OK";
        task.finish();
      } else {
        task.exit = task.failure;
        task.undo();
      }
    }
  };

  const resources = (): ProxmoxAnswer =>
    answer(
      200,
      [...vms.values()]
        .filter((vm) => vm.template || vm.pool === options.pool)
        .map((vm) => ({
          id: `qemu/${vm.vmid}`,
          type: "qemu",
          vmid: vm.vmid,
          node: vm.node,
          name: vm.name,
          status: vm.status,
          template: vm.template ? 1 : 0,
          ...(vm.pool === null ? {} : { pool: vm.pool }),
          ...(vm.tags.length === 0 ? {} : { tags: vm.tags.join(";") }),
          ...(vm.lock === "" ? {} : { lock: vm.lock }),
        })),
    );

  const nextId = (parameters: Readonly<Record<string, string | number>>): ProxmoxAnswer => {
    const asked = parameters["vmid"];
    if (asked !== undefined) {
      const vmid = Number(asked);
      return vms.has(vmid) ? answer(400, null, `VM ${vmid} already exists`) : answer(200, String(vmid));
    }
    let vmid = 100;
    while (vms.has(vmid)) vmid += 1;
    return answer(200, String(vmid));
  };

  const clone = (node: string, template: FakeVm | undefined, parameters: Readonly<Record<string, string | number>>): ProxmoxAnswer => {
    if (template === undefined || !template.template || template.node !== node) {
      return answer(500, null, `Configuration file 'nodes/${node}/qemu-server/${template?.vmid ?? 0}.conf' does not exist`);
    }
    const newid = Number(parameters["newid"]);
    if (parameters["pool"] !== options.pool) return denied(newid, "VM.Allocate");
    if (!isVmid(newid) || vms.has(newid)) return answer(500, null, `unable to create VM ${newid}: config file already exists`);
    const vm = vmOf(newid, node, false, template.agent, template.tags);
    vm.name = String(parameters["name"] ?? `Copy-of-VM-${template.vmid}`);
    vm.description = String(parameters["description"] ?? template.description);
    vm.cores = template.cores;
    vm.memory = template.memory;
    vm.lock = "clone";
    vms.set(newid, vm);
    const task = startTask(
      "clone",
      vm,
      () => {
        vm.lock = "";
        vm.pool = options.pool;
      },
      () => {
        vms.delete(newid);
      },
    );
    return answer(200, task);
  };

  const agentProblem = (vm: FakeVm): ProxmoxAnswer | null => {
    if (vm.status !== "running") return answer(500, null, `VM ${vm.vmid} is not running`);
    if (!vm.agent) return answer(500, null, "No QEMU guest agent configured");
    if (vm.boot > 0) return answer(500, null, "QEMU guest agent is not running");
    return null;
  };

  const onVm = (method: string, node: string, vm: FakeVm, rest: string, parameters: Readonly<Record<string, string | number>>): ProxmoxAnswer => {
    if (vm.node !== node) return answer(500, null, `Configuration file 'nodes/${node}/qemu-server/${vm.vmid}.conf' does not exist`);
    switch (`${method} ${rest}`) {
      case "GET config":
        return answer(200, {
          name: vm.name,
          // Proxmox VE keeps the description as comment lines, and it reads each line back with a line end.
          ...(vm.description === "" ? {} : { description: `${vm.description}\n` }),
          ...(vm.tags.length === 0 ? {} : { tags: vm.tags.join(";") }),
          ...(vm.lock === "" ? {} : { lock: vm.lock }),
          cores: vm.cores,
          memory: String(vm.memory),
          ...(vm.agent ? { agent: "1" } : {}),
        });
      case "PUT config": {
        if (vm.lock !== "") return locked(vm);
        if (parameters["cores"] !== undefined) vm.cores = Number(parameters["cores"]);
        if (parameters["memory"] !== undefined) vm.memory = Number(parameters["memory"]);
        if (parameters["tags"] !== undefined) vm.tags = String(parameters["tags"]).split(/[;,\s]+/).filter((tag) => tag.length > 0);
        if (parameters["delete"] !== undefined) {
          for (const key of String(parameters["delete"]).split(/[,;\s]+/)) if (key === "tags") vm.tags = [];
        }
        return answer(200);
      }
      case "POST status/start":
        if (vm.lock !== "") return locked(vm);
        if (vm.status === "running") return answer(500, null, `VM ${vm.vmid} already running`);
        return answer(
          200,
          startTask("start", vm, () => {
            vm.status = "running";
            vm.boot = ticks.boot;
          }),
        );
      case "POST status/stop":
        return answer(
          200,
          startTask("stop", vm, () => {
            vm.status = "stopped";
            vm.boot = 0;
          }),
        );
      case "DELETE ":
        if (vm.status === "running") return answer(500, null, `VM ${vm.vmid} is running - destroy failed`);
        if (vm.lock !== "") return locked(vm);
        vm.lock = "destroyed";
        return answer(
          200,
          startTask(
            "delete",
            vm,
            () => {
              vms.delete(vm.vmid);
            },
            () => {
              vm.lock = "";
            },
          ),
        );
      case "POST agent/ping":
        return agentProblem(vm) ?? answer(200, { result: {} });
      case "POST agent/file-write": {
        const problem = agentProblem(vm);
        if (problem !== null) return problem;
        const content = String(parameters["content"] ?? "");
        if (content.length > FILE_WRITE_LIMIT) return answer(400, null, "Parameter verification failed.");
        vm.files.set(String(parameters["file"]), content);
        return answer(200);
      }
      default:
        return answer(501, null, `Method '${method} /nodes/${node}/qemu/${vm.vmid}/${rest}' not implemented`);
    }
  };

  const handle = (request: ProxmoxRequest): ProxmoxAnswer => {
    const { method, path, parameters } = request;
    if (method === "GET" && path === "/cluster/resources") return resources();
    if (method === "GET" && path === "/cluster/nextid") return nextId(parameters);
    const parts = path.split("/").slice(1);
    if (parts[0] === "nodes" && parts[2] === "tasks" && parts[4] === "status" && parts.length === 5 && method === "GET") {
      const task = tasks.get(parts[3] ?? "");
      if (task === undefined || task.node !== parts[1]) return answer(500, null, "no such task");
      return answer(200, task.exit === null ? { status: "running" } : { status: "stopped", exitstatus: task.exit });
    }
    if (parts[0] === "nodes" && parts[2] === "qemu" && parts.length >= 4) {
      const node = parts[1] ?? "";
      const vmid = Number(parts[3]);
      const rest = parts.slice(4).join("/");
      const vm = vms.get(vmid);
      if (method === "POST" && rest === "clone") return clone(node, vm, parameters);
      if (vm === undefined || vm.pool !== options.pool) return denied(vmid, "VM.Audit");
      return onVm(method, node, vm, rest, parameters);
    }
    return answer(501, null, `Method '${method} ${path}' not implemented`);
  };

  return {
    api: {
      async request(request) {
        requests.push(request);
        const index = canned.findIndex((each) => each.match(request));
        if (index >= 0) return canned.splice(index, 1)[0]!.answer;
        return handle(request);
      },
    },
    requests,
    vm: (vmid) => vms.get(vmid),
    vms: () => [...vms.values()],
    tick(times = 1) {
      for (let step = 0; step < times; step += 1) tick();
    },
    answerNext(match, given) {
      canned.push({ match, answer: given });
    },
    failNext(kind, text) {
      failures.set(kind, [...(failures.get(kind) ?? []), text]);
    },
    occupy(vmid, node, inPool = false) {
      const vm = vmOf(vmid, node, false, true, []);
      vm.pool = inPool ? options.pool : null;
      vms.set(vmid, vm);
    },
    powerOff(vmid) {
      const vm = vms.get(vmid);
      if (vm !== undefined) {
        vm.status = "stopped";
        vm.boot = 0;
      }
    },
    remove(vmid) {
      vms.delete(vmid);
    },
  };
}
