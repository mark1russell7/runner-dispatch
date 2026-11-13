import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { checkSettingsDocument, parseCheckSettings, type CheckSettings } from "./check.ts";
import type { TrustRules } from "./policy.ts";
import type { MachineProvider, MachineStatus, StopSignal } from "./ports.ts";
import {
  createProxmoxProvider,
  DELIVERED_TAG,
  FILE_WRITE_LIMIT,
  MACHINE_DESCRIPTION_FORMAT,
  MACHINE_FILES,
  machineDescription,
  parseMachineDescription,
  type ProxmoxProviderOptions,
  type ProxmoxRequest,
} from "./proxmox.ts";
import type { MachineRecord } from "./records.ts";
import { fakeProxmox, type FakeProxmox, type FakeProxmoxOptions, type FakeTaskKind, type FakeVm } from "./testing.ts";

const POOL = "runners";
const NODE = "pve1";
const TEMPLATE = 9000;
const FOREIGN = 500;
const OUTSIDE = 600;
const SIGNAL: StopSignal = { aborted: false };
const RULES: TrustRules = { repositories: ["octo/app"], events: ["push"], actors: ["octo"] };
const SECRET = "jit-configuration-SECRET-7f3a";

const record = (name: string, runId = 42): MachineRecord => ({ name, size: "small", repository: "octo/app", runId, runAttempt: 1 });
const settingsOf = (machine: MachineRecord): CheckSettings => ({
  rules: RULES,
  run: { repository: machine.repository, runId: machine.runId, runAttempt: machine.runAttempt },
});

interface Setup {
  readonly fake: FakeProxmox;
  readonly provider: MachineProvider;
  readonly problems: string[];
}

interface SetupOptions {
  readonly ticks?: FakeProxmoxOptions["ticks"];
  readonly agent?: boolean;
  readonly templateTags?: readonly string[];
}

function setup(options: SetupOptions = {}): Setup {
  const fake = fakeProxmox({
    pool: POOL,
    templates: [{ vmid: TEMPLATE, node: NODE, agent: options.agent ?? true, tags: options.templateTags ?? [] }],
    ...(options.ticks === undefined ? {} : { ticks: options.ticks }),
  });
  return { fake, ...providerOn(fake) };
}

function providerOn(fake: FakeProxmox): { provider: MachineProvider; problems: string[] } {
  const problems: string[] = [];
  const provider = createProxmoxProvider({
    api: fake.api,
    pool: POOL,
    sizes: { small: { node: NODE, template: TEMPLATE, cores: 2, memory: 2048 } },
    problem: (text) => problems.push(text),
  });
  return { provider, problems };
}

const make = (s: Setup, machine: MachineRecord, configuration = SECRET): Promise<void> =>
  s.provider.make({ machine, configuration, check: settingsOf(machine) }, SIGNAL);

async function statuses(s: Setup): Promise<Record<string, MachineStatus>> {
  const listed = await s.provider.machines(SIGNAL);
  return Object.fromEntries(listed.map((each) => [each.machine.name, each.status]));
}

/** This function lists and ticks until the machine has the status. It gives the count of the lists. */
async function until(s: Setup, name: string, wanted: MachineStatus | "absent", lists = 30): Promise<number> {
  for (let list = 1; list <= lists; list += 1) {
    const status = (await statuses(s))[name] ?? "absent";
    if (status === wanted) return list;
    s.fake.tick();
  }
  throw new Error(`The machine ${name} did not get the status ${wanted} in ${lists} lists.`);
}

const vmNamed = (fake: FakeProxmox, name: string): FakeVm | undefined => fake.vms().find((vm) => vm.name === name && !vm.template);
const changes = (requests: readonly ProxmoxRequest[]): ProxmoxRequest[] => requests.filter((request) => request.method !== "GET");
const vmidOfPath = (path: string): number | null => {
  const match = /^\/nodes\/[^/]+\/qemu\/(\d+)(?:\/|$)/.exec(path);
  return match === null ? null : Number(match[1]);
};
const carries = (request: ProxmoxRequest, secret: string): boolean =>
  Object.values(request.parameters).some((value) => String(value).includes(secret)) || request.path.includes(secret);

const NAME = "rd-42-1-0000abcd";

describe("machineDescription and parseMachineDescription", () => {
  const machine = record(NAME);

  it("write the record as JSON with the format id, and read it back, also with a line end", () => {
    const text = machineDescription(machine);
    expect(JSON.parse(text)).toEqual({ format: MACHINE_DESCRIPTION_FORMAT, ...machine });
    expect(parseMachineDescription(text)).toEqual(machine);
    expect(parseMachineDescription(`${text}\n`)).toEqual(machine);
  });

  it("read back each valid record", () => {
    const name = fc.stringMatching(/^[a-z][a-z0-9-]{0,40}[a-z0-9]$/);
    const id = fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER });
    fc.assert(
      fc.property(name, id, id, (each, runId, runAttempt) => {
        const value: MachineRecord = { name: each, size: "small", repository: "octo/app", runId, runAttempt };
        expect(parseMachineDescription(machineDescription(value))).toEqual(value);
      }),
    );
  });

  it("give null for a text that is not the record of a machine", () => {
    const good = { format: MACHINE_DESCRIPTION_FORMAT, ...machine };
    const bad: unknown[] = [
      undefined,
      42,
      "",
      "not JSON",
      "[]",
      JSON.stringify({ ...good, format: "runner-machine/2" }),
      JSON.stringify({ ...good, configuration: SECRET }),
      JSON.stringify({ ...good, name: "Rd-42" }),
      JSON.stringify({ ...good, repository: "octo" }),
      JSON.stringify({ ...good, runId: 0 }),
      JSON.stringify({ ...good, runAttempt: 1.5 }),
      JSON.stringify({ ...good, size: undefined }),
    ];
    for (const value of bad) expect(parseMachineDescription(value)).toBeNull();
  });

  it("refuses to write a record that is not valid", () => {
    expect(() => machineDescription({ ...machine, name: "a name" })).toThrow(RangeError);
    expect(() => machineDescription({ ...machine, runId: -1 })).toThrow(RangeError);
  });
});

describe("checkSettingsDocument", () => {
  it("gives a document that parseCheckSettings reads back to the same settings", () => {
    const text = fc.stringMatching(/^[a-z][a-z0-9]{0,8}$/);
    const repository = fc.tuple(text, text).map(([owner, name]) => `${owner}/${name}`);
    const id = fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER });
    fc.assert(
      fc.property(fc.uniqueArray(repository, { minLength: 1, maxLength: 4 }), id, id, (repositories, runId, runAttempt) => {
        const settings: CheckSettings = {
          rules: { repositories, events: ["push"], actors: ["octo"] },
          run: { repository: repositories[0]!, runId, runAttempt },
        };
        const read = parseCheckSettings(JSON.parse(JSON.stringify(checkSettingsDocument(settings))));
        expect(read.ok).toBe(true);
        if (read.ok) expect(read.settings).toEqual(settings);
      }),
    );
  });
});

describe("createProxmoxProvider", () => {
  const fake = fakeProxmox({ pool: POOL, templates: [{ vmid: TEMPLATE, node: NODE }] });
  const base: ProxmoxProviderOptions = { api: fake.api, pool: POOL, sizes: { small: { node: NODE, template: TEMPLATE } } };

  it("accepts good options, and refuses each option that is not valid", () => {
    expect(() => createProxmoxProvider(base)).not.toThrow();
    const bad: ProxmoxProviderOptions[] = [
      { ...base, pool: "a pool" },
      { ...base, sizes: {} },
      { ...base, sizes: { Small: { node: NODE, template: TEMPLATE } } },
      { ...base, sizes: { small: { node: "node one", template: TEMPLATE } } },
      { ...base, sizes: { small: { node: NODE, template: 99 } } },
      { ...base, sizes: { small: { node: NODE, template: TEMPLATE, cores: 0 } } },
      { ...base, sizes: { small: { node: NODE, template: TEMPLATE, memory: 8 } } },
      { ...base, files: { check: "/run/a", configuration: "/run/a" } },
      { ...base, files: { check: "run/a", configuration: "/run/b" } },
      { ...base, files: { check: "/run/a", configuration: "/run/" } },
    ];
    for (const options of bad) expect(() => createProxmoxProvider(options)).toThrow(RangeError);
  });
});

describe("make and machines", () => {
  it("make a linked clone in the pool, set its size, start it, write the two files, and only then show it operating", async () => {
    const s = setup({ ticks: { clone: 2, start: 2, boot: 3 } });
    const machine = record(NAME);
    await make(s, machine);
    const seen: MachineStatus[] = [];
    for (let list = 0; list < 30; list += 1) {
      const status = (await statuses(s))[NAME];
      expect(status).toBeDefined();
      seen.push(status!);
      const vm = vmNamed(s.fake, NAME);
      if (status === "operating") {
        expect(vm?.files.get(MACHINE_FILES.configuration)).toBe(SECRET);
        break;
      }
      expect(vm?.files.has(MACHINE_FILES.configuration) ?? false).toBe(false);
      s.fake.tick();
    }
    expect(seen.at(-1)).toBe("operating");
    expect(seen.slice(0, -1).every((status) => status === "making")).toBe(true);

    const vm = vmNamed(s.fake, NAME)!;
    expect(vm).toMatchObject({ pool: POOL, status: "running", cores: 2, memory: 2048, lock: "" });
    expect(vm.tags).toEqual([DELIVERED_TAG]);
    expect(parseMachineDescription(vm.description)).toEqual(machine);
    const check = parseCheckSettings(JSON.parse(vm.files.get(MACHINE_FILES.check)!));
    expect(check).toEqual({ ok: true, settings: settingsOf(machine) });
    expect(s.fake.vm(TEMPLATE)).toMatchObject({ pool: null, tags: [], status: "stopped", lock: "" });
    expect(s.fake.vm(TEMPLATE)?.files.size).toBe(0);
    expect(s.problems).toEqual([]);
    expect(await statuses(s)).toEqual({ [NAME]: "operating" });
  });

  it("send the configuration only in the body of the file write to its path", async () => {
    const s = setup();
    await make(s, record(NAME));
    await until(s, NAME, "operating");
    const sent = s.fake.requests.filter((request) => carries(request, SECRET));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: "POST", parameters: { file: MACHINE_FILES.configuration, content: SECRET } });
    expect(sent[0]!.path).toBe(`/nodes/${NODE}/qemu/${vmNamed(s.fake, NAME)!.vmid}/agent/file-write`);
    expect(s.problems.join("\n")).not.toContain(SECRET);
  });

  it("show a delivered machine as operating after a restart, and a machine with no delivery as stopped", async () => {
    const s = setup();
    const other = "rd-43-1-0000abcd";
    await make(s, record(NAME));
    await until(s, NAME, "operating");
    await make(s, record(other, 43));
    s.fake.tick();
    const later = providerOn(s.fake);
    const listed = await later.provider.machines(SIGNAL);
    expect(Object.fromEntries(listed.map((each) => [each.machine.name, each.status]))).toEqual({ [NAME]: "operating", [other]: "stopped" });
  });

  it("remove a tag delivered that the clone got from its template", async () => {
    const s = setup({ templateTags: ["ci", DELIVERED_TAG], ticks: { boot: 4 } });
    await make(s, record(NAME));
    s.fake.tick();
    await statuses(s);
    expect(vmNamed(s.fake, NAME)?.tags).toEqual(["ci"]);
    s.fake.tick();
    expect(vmNamed(s.fake, NAME)?.status).toBe("running");
    const later = providerOn(s.fake);
    expect((await later.provider.machines(SIGNAL)).map((each) => each.status)).toEqual(["stopped"]);
    await until(s, NAME, "operating");
    expect(vmNamed(s.fake, NAME)?.tags).toEqual(["ci", DELIVERED_TAG]);
  });

  it("give two makes at the same time two different VMIDs", async () => {
    const s = setup();
    const other = "rd-43-1-0000abcd";
    await Promise.all([make(s, record(NAME)), make(s, record(other, 43))]);
    const ids = [vmNamed(s.fake, NAME)?.vmid, vmNamed(s.fake, other)?.vmid];
    expect(ids.every((id) => id !== undefined)).toBe(true);
    expect(new Set(ids).size).toBe(2);
  });

  it("try a new VMID when the clone finds the VMID taken", async () => {
    const s = setup();
    s.fake.answerNext((request) => request.path.endsWith("/clone"), {
      status: 500,
      message: "unable to create VM 100: config file already exists",
      data: null,
    });
    await make(s, record(NAME));
    expect(s.fake.requests.filter((request) => request.path.endsWith("/clone"))).toHaveLength(2);
    await until(s, NAME, "operating");
  });

  it("refuse a size with no template, a name that it has, and a configuration that is empty or too long", async () => {
    const s = setup();
    await expect(s.provider.make({ machine: { ...record(NAME), size: "large" }, configuration: SECRET, check: settingsOf(record(NAME)) }, SIGNAL)).rejects.toThrow(
      RangeError,
    );
    await expect(make(s, record(NAME), "")).rejects.toThrow(RangeError);
    await expect(make(s, record(NAME), "x".repeat(FILE_WRITE_LIMIT + 1))).rejects.toThrow(RangeError);
    await make(s, record(NAME));
    await expect(make(s, record(NAME))).rejects.toThrow(RangeError);
  });

  it("stop a machine whose clone fails, and tell the problem", async () => {
    const s = setup();
    s.fake.failNext("clone", "storage full");
    await make(s, record(NAME));
    await until(s, NAME, "stopped");
    expect(s.problems.some((text) => text.includes("clone") && text.includes("storage full"))).toBe(true);
    await s.provider.destroy(NAME, SIGNAL);
    await until(s, NAME, "absent");
  });

  it("keep a machine with no guest agent in making, and tell it once", async () => {
    const s = setup({ agent: false });
    await make(s, record(NAME));
    for (let list = 0; list < 10; list += 1) {
      expect((await statuses(s))[NAME]).toBe("making");
      s.fake.tick();
    }
    expect(s.problems.filter((text) => text.includes("no guest agent"))).toHaveLength(1);
    expect(s.fake.requests.some((request) => request.path.endsWith("/file-write"))).toBe(false);
  });

  it("stop a machine whose guest powers off before its delivery", async () => {
    const s = setup({ ticks: { boot: 5 } });
    await make(s, record(NAME));
    for (let list = 0; list < 10 && vmNamed(s.fake, NAME)?.status !== "running"; list += 1) {
      await statuses(s);
      s.fake.tick();
    }
    s.fake.powerOff(vmNamed(s.fake, NAME)!.vmid);
    await until(s, NAME, "stopped");
    expect(s.fake.requests.some((request) => carries(request, SECRET))).toBe(false);
  });

  it("stop a machine when Proxmox VE refuses its size", async () => {
    const s = setup();
    s.fake.answerNext((request) => request.method === "PUT" && request.parameters["cores"] !== undefined, {
      status: 500,
      message: "VM is locked (backup)",
      data: null,
    });
    await make(s, record(NAME));
    await until(s, NAME, "stopped");
    expect(s.problems.some((text) => text.includes("size") && text.includes("locked"))).toBe(true);
  });

  it("tell only the status when the write of the configuration fails, and try it again", async () => {
    const s = setup();
    s.fake.answerNext((request) => request.parameters["file"] === MACHINE_FILES.configuration, {
      status: 500,
      message: `cannot write ${SECRET}`,
      data: null,
    });
    await make(s, record(NAME));
    await until(s, NAME, "operating");
    expect(s.problems.some((text) => text.includes("the status 500"))).toBe(true);
    expect(s.problems.join("\n")).not.toContain(SECRET);
    expect(vmNamed(s.fake, NAME)?.files.get(MACHINE_FILES.configuration)).toBe(SECRET);
  });

  it("show a machine that an operator removed as absent", async () => {
    const s = setup();
    await make(s, record(NAME));
    await until(s, NAME, "operating");
    s.fake.remove(vmNamed(s.fake, NAME)!.vmid);
    expect(await statuses(s)).toEqual({});
    await s.provider.destroy(NAME, SIGNAL);
  });

  it("never touch a VM of the pool with no record, nor a VM outside the pool", async () => {
    const s = setup();
    s.fake.occupy(FOREIGN, NODE, true);
    s.fake.occupy(OUTSIDE, NODE, false);
    await make(s, record(NAME));
    await until(s, NAME, "operating");
    await s.provider.destroy(`vm-${FOREIGN}`, SIGNAL);
    await s.provider.destroy(`vm-${OUTSIDE}`, SIGNAL);
    await statuses(s);
    const touched = s.fake.requests.map((request) => ({ request, vmid: vmidOfPath(request.path) }));
    expect(touched.filter((each) => each.vmid === OUTSIDE)).toEqual([]);
    expect(touched.filter((each) => each.vmid === FOREIGN).map((each) => `${each.request.method} ${each.request.path}`)).toEqual([
      `GET /nodes/${NODE}/qemu/${FOREIGN}/config`,
    ]);
    expect(s.problems.filter((text) => text.includes(`The VM ${FOREIGN} `))).toHaveLength(1);
    expect(s.fake.vm(FOREIGN)).toMatchObject({ status: "stopped", lock: "", pool: POOL });
  });
});

describe("destroy", () => {
  it("stop an operating machine, delete it, and then show it as absent", async () => {
    const s = setup();
    await make(s, record(NAME));
    await until(s, NAME, "operating");
    const vmid = vmNamed(s.fake, NAME)!.vmid;
    await s.provider.destroy(NAME, SIGNAL);
    await until(s, NAME, "absent");
    expect(s.fake.vm(vmid)).toBeUndefined();
    const ends = changes(s.fake.requests).filter((request) => vmidOfPath(request.path) === vmid).map((request) => request.method);
    expect(ends.slice(-2)).toEqual(["POST", "DELETE"]);
    expect(s.fake.requests.find((request) => request.method === "DELETE")?.parameters).toEqual({ purge: 1, "destroy-unreferenced-disks": 1 });
    expect(s.fake.vms().map((vm) => vm.vmid)).toEqual([TEMPLATE]);
  });

  it("wait for a clone in flight, then delete the VM, with no start and no file", async () => {
    const s = setup({ ticks: { clone: 3 } });
    await make(s, record(NAME));
    await s.provider.destroy(NAME, SIGNAL);
    await until(s, NAME, "absent");
    expect(s.fake.vms().map((vm) => vm.vmid)).toEqual([TEMPLATE]);
    expect(s.fake.requests.some((request) => request.path.endsWith("/status/start") || request.path.endsWith("/file-write"))).toBe(false);
  });

  it("succeed for a machine that is not there", async () => {
    const s = setup();
    await s.provider.destroy("rd-1-1-00000000", SIGNAL);
    expect(changes(s.fake.requests)).toEqual([]);
  });

  it("try a failed delete again", async () => {
    const s = setup();
    await make(s, record(NAME));
    await until(s, NAME, "operating");
    s.fake.failNext("delete", "storage busy");
    await s.provider.destroy(NAME, SIGNAL);
    await until(s, NAME, "absent");
    expect(s.fake.vms().map((vm) => vm.vmid)).toEqual([TEMPLATE]);
    expect(s.problems.some((text) => text.includes("storage busy"))).toBe(true);
  });
});

describe("the property of the provider", () => {
  type Action =
    | { readonly kind: "make"; readonly index: number }
    | { readonly kind: "list" }
    | { readonly kind: "tick"; readonly count: number }
    | { readonly kind: "destroy"; readonly index: number }
    | { readonly kind: "power-off"; readonly index: number }
    | { readonly kind: "remove"; readonly index: number }
    | { readonly kind: "fail"; readonly task: FakeTaskKind };

  const index = fc.integer({ min: 0, max: 2 });
  const action: fc.Arbitrary<Action> = fc.oneof(
    index.map((each) => ({ kind: "make" as const, index: each })),
    fc.constant({ kind: "list" as const }),
    fc.integer({ min: 1, max: 3 }).map((count) => ({ kind: "tick" as const, count })),
    index.map((each) => ({ kind: "destroy" as const, index: each })),
    index.map((each) => ({ kind: "power-off" as const, index: each })),
    index.map((each) => ({ kind: "remove" as const, index: each })),
    fc.constantFrom<FakeTaskKind>("clone", "start", "stop", "delete").map((task) => ({ kind: "fail" as const, task })),
  );
  const names = [0, 1, 2].map((each) => `rd-7-1-0000000${each}`);
  const secretOf = (each: number): string => `jit-SECRET-${each}-${"q".repeat(each + 1)}`;

  it("keeps each configuration in its own machine, touches only its own VMs, and ends with an empty pool", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(action, { maxLength: 40 }), fc.integer({ min: 1, max: 3 }), async (actions, boot) => {
        const s = setup({ ticks: { clone: 2, start: 1, stop: 1, delete: 1, boot } });
        s.fake.occupy(FOREIGN, NODE, true);
        s.fake.occupy(OUTSIDE, NODE, false);
        const made = new Set<number>();

        const holds = (shown: Record<string, MachineStatus>): void => {
          const vmidOfName = new Map<string, number>();
          for (const request of s.fake.requests) {
            if (request.path.endsWith("/clone")) vmidOfName.set(String(request.parameters["name"]), Number(request.parameters["newid"]));
          }
          for (const request of s.fake.requests) {
            for (const [each, name] of names.entries()) {
              if (!carries(request, secretOf(each))) continue;
              expect(request.method).toBe("POST");
              expect(request.parameters["file"]).toBe(MACHINE_FILES.configuration);
              expect(request.path).toBe(`/nodes/${NODE}/qemu/${vmidOfName.get(name)}/agent/file-write`);
            }
            const vmid = vmidOfPath(request.path);
            expect(vmid === OUTSIDE).toBe(false);
            if (request.method !== "GET") {
              expect(vmid === FOREIGN).toBe(false);
              if (vmid === TEMPLATE) expect(request.path.endsWith("/clone")).toBe(true);
            }
          }
          const problems = s.problems.join("\n");
          for (const each of names.keys()) expect(problems).not.toContain(secretOf(each));
          for (const [each, name] of names.entries()) {
            if (shown[name] === "operating") expect(vmNamed(s.fake, name)?.files.get(MACHINE_FILES.configuration)).toBe(secretOf(each));
          }
          expect(s.fake.vm(TEMPLATE)).toMatchObject({ pool: null, tags: [], status: "stopped", lock: "", description: "" });
          expect(s.fake.vm(FOREIGN)).toMatchObject({ pool: POOL, status: "stopped", lock: "" });
        };

        for (const step of actions) {
          switch (step.kind) {
            case "make":
              if (made.has(step.index)) break;
              made.add(step.index);
              await s.provider.make({ machine: record(names[step.index]!, 7), configuration: secretOf(step.index), check: settingsOf(record(names[step.index]!, 7)) }, SIGNAL);
              break;
            case "list":
              holds(await statuses(s));
              break;
            case "tick":
              s.fake.tick(step.count);
              break;
            case "destroy":
              await s.provider.destroy(names[step.index]!, SIGNAL);
              break;
            case "power-off":
            case "remove": {
              const vm = vmNamed(s.fake, names[step.index]!);
              if (vm === undefined) break;
              if (step.kind === "remove") s.fake.remove(vm.vmid);
              else s.fake.powerOff(vm.vmid);
              break;
            }
            case "fail":
              s.fake.failNext(step.task, "a fault of the test");
              break;
          }
        }

        for (const each of names) await s.provider.destroy(each, SIGNAL);
        let shown = await statuses(s);
        for (let list = 0; list < 200 && Object.keys(shown).length > 0; list += 1) {
          s.fake.tick();
          shown = await statuses(s);
          // A destroy that the dispatcher repeats on its timer. The provider tolerates it in each state.
          if (list % 5 === 4) for (const name of Object.keys(shown)) await s.provider.destroy(name, SIGNAL);
        }
        holds(shown);
        expect(shown).toEqual({});
        expect(s.fake.vms().filter((vm) => vm.pool === POOL).map((vm) => vm.vmid)).toEqual([FOREIGN]);
        expect(s.fake.vms().filter((vm) => !vm.template && vm.vmid !== FOREIGN && vm.vmid !== OUTSIDE)).toEqual([]);
      }),
      { numRuns: 150 },
    );
  });
});
