import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { StopSignal } from "./ports.ts";
import { createProxmoxProvider, DELIVERED_TAG, type ProxmoxApi, type ProxmoxMethod, type ProxmoxRequest } from "./proxmox.ts";
import {
  createProxmoxClient,
  isProxmoxToken,
  PROXMOX_API_PATH,
  PROXMOX_MESSAGE_LIMIT,
  proxmoxUrlProblems,
  type ProxmoxExchange,
  type ProxmoxReply,
  type ProxmoxTransport,
} from "./proxmox-client.ts";
import { fakeProxmox, type FakeProxmox } from "./testing.ts";

const URL_OF_HOST = "https://pve.example:8006";
const TOKEN = "dispatch@pve!runners=3f6c1e2a-9b8d-4c7e-a1f0-5d2b9e8c7a64";
const SECRET = "3f6c1e2a-9b8d-4c7e-a1f0-5d2b9e8c7a64";
const SIGNAL: StopSignal = { aborted: false };
const TASK = "UPID:pve1:0000ABCD:00112233:6745A1B2:qmclone:9000:dispatch@pve!runners:";

interface Recorder {
  readonly transport: ProxmoxTransport;
  readonly sent: ProxmoxExchange[];
}

/** This function gives a transport that records each exchange and gives one reply. */
const recorder = (reply: ProxmoxReply | ((exchange: ProxmoxExchange) => ProxmoxReply)): Recorder => {
  const sent: ProxmoxExchange[] = [];
  return {
    sent,
    transport: async (exchange) => {
      sent.push(exchange);
      return typeof reply === "function" ? reply(exchange) : reply;
    },
  };
};

const okReply = (data: unknown): ProxmoxReply => ({ status: 200, statusText: "OK", body: JSON.stringify({ data }) });
const clientOn = (transport: ProxmoxTransport): ProxmoxApi => createProxmoxClient({ url: URL_OF_HOST, token: TOKEN, transport });
const request = (method: ProxmoxMethod, path: string, parameters: ProxmoxRequest["parameters"] = {}): ProxmoxRequest => ({ method, path, parameters });

/**
 * This function gives the wire of a fake Proxmox VE: a transport that reads an exchange as Proxmox VE reads it.
 * It decodes the path and the form, and it gives each parameter as a text, as the HTTP server of Proxmox VE does.
 */
const wireOf = (api: ProxmoxApi): ProxmoxTransport => async (exchange, signal) => {
  const url = new URL(exchange.url);
  if (url.origin !== new URL(URL_OF_HOST).origin || !url.pathname.startsWith(`${PROXMOX_API_PATH}/`)) throw new Error("The exchange went to another place.");
  if (exchange.headers["authorization"] !== `PVEAPIToken=${TOKEN}`) return { status: 401, statusText: "authentication failure", body: '{"data":null}' };
  const form = exchange.body === undefined ? url.searchParams : new URLSearchParams(exchange.body);
  if (exchange.body !== undefined && (url.search !== "" || exchange.headers["content-type"] !== "application/x-www-form-urlencoded")) {
    throw new Error("A request with a body has a query, or its body is not a form.");
  }
  const path = url.pathname
    .slice(PROXMOX_API_PATH.length)
    .split("/")
    .map((part) => decodeURIComponent(part))
    .join("/");
  const answer = await api.request({ method: exchange.method, path, parameters: Object.fromEntries(form) }, signal);
  return { status: answer.status, statusText: answer.message, body: JSON.stringify({ data: answer.data }) };
};

describe("createProxmoxClient", () => {
  it("sends a GET with the parameters in a sorted query, the token in a header and no body", async () => {
    const wire = recorder(okReply([{ vmid: 100 }]));
    const answer = await clientOn(wire.transport).request(request("GET", "/cluster/resources", { type: "vm", b: 2 }), SIGNAL);
    expect(answer).toEqual({ status: 200, message: "OK", data: [{ vmid: 100 }] });
    expect(wire.sent).toEqual([
      {
        method: "GET",
        url: `${URL_OF_HOST}/api2/json/cluster/resources?b=2&type=vm`,
        headers: { accept: "application/json", authorization: `PVEAPIToken=${TOKEN}` },
        body: undefined,
      },
    ]);
  });

  it("sends a DELETE with the parameters in the query, and a GET with no parameters with no query", async () => {
    const wire = recorder(okReply(null));
    const client = clientOn(wire.transport);
    await client.request(request("DELETE", "/nodes/pve1/qemu/101", { purge: 1, "destroy-unreferenced-disks": 1 }), SIGNAL);
    await client.request(request("GET", "/cluster/nextid"), SIGNAL);
    expect(wire.sent.map((each) => [each.url, each.body])).toEqual([
      [`${URL_OF_HOST}/api2/json/nodes/pve1/qemu/101?destroy-unreferenced-disks=1&purge=1`, undefined],
      [`${URL_OF_HOST}/api2/json/cluster/nextid`, undefined],
    ]);
  });

  for (const method of ["POST", "PUT"] as const) {
    it(`sends the parameters of a ${method} in a form body, and none in the URL`, async () => {
      const wire = recorder(okReply(TASK));
      await clientOn(wire.transport).request(request(method, "/nodes/pve1/qemu/101/agent/file-write", { file: "/run/a b", content: "x=1&y=2\n" }), SIGNAL);
      expect(wire.sent).toEqual([
        {
          method,
          url: `${URL_OF_HOST}/api2/json/nodes/pve1/qemu/101/agent/file-write`,
          headers: { accept: "application/json", authorization: `PVEAPIToken=${TOKEN}`, "content-type": "application/x-www-form-urlencoded" },
          body: "content=x%3D1%26y%3D2%0A&file=%2Frun%2Fa+b",
        },
      ]);
    });
  }

  it("keeps the characters : and @ of a task id in the path, and encodes each other character of a part", async () => {
    const wire = recorder(okReply({ status: "stopped" }));
    await clientOn(wire.transport).request(request("GET", `/nodes/pve1/tasks/${TASK}/status`), SIGNAL);
    expect(wire.sent[0]?.url).toBe(`${URL_OF_HOST}/api2/json/nodes/pve1/tasks/${TASK}/status`);
    await clientOn(wire.transport).request(request("GET", "/a%2f/b\"c"), SIGNAL);
    expect(wire.sent[1]?.url).toBe(`${URL_OF_HOST}/api2/json/a%252f/b%22c`);
  });

  it.each([
    ["no slash at the start", "cluster/nextid"],
    ["an empty part", "/cluster//nextid"],
    ["a slash at the end", "/cluster/"],
    ["the part ..", "/nodes/../access"],
    ["the part .", "/nodes/./qemu"],
    ["a query", "/cluster/nextid?vmid=1"],
    ["a fragment", "/cluster/nextid#x"],
    ["a space", "/nodes/pve 1"],
    ["a line break", "/nodes/pve\n1"],
  ])("refuses a path with %s, and sends nothing", async (_name, path) => {
    const wire = recorder(okReply(null));
    await expect(clientOn(wire.transport).request(request("GET", path), SIGNAL)).rejects.toThrow(RangeError);
    expect(wire.sent).toEqual([]);
  });

  it.each([
    ["NaN", Number.NaN],
    ["an infinity", Number.POSITIVE_INFINITY],
    ["an object", {} as unknown as string],
    ["null", null as unknown as string],
  ])("refuses a parameter that is %s, and sends nothing", async (_name, value) => {
    const wire = recorder(okReply(null));
    await expect(clientOn(wire.transport).request(request("POST", "/cluster/nextid", { vmid: value }), SIGNAL)).rejects.toThrow(
      new RangeError("A parameter of POST /cluster/nextid is not a text or a finite number."),
    );
    expect(wire.sent).toEqual([]);
  });

  it("refuses a method that the API port does not have", async () => {
    const wire = recorder(okReply(null));
    await expect(clientOn(wire.transport).request(request("PATCH" as ProxmoxMethod, "/cluster/nextid"), SIGNAL)).rejects.toThrow(RangeError);
    expect(wire.sent).toEqual([]);
  });

  it("gives an error status as an answer, with the reason phrase as the message", async () => {
    const wire = recorder({ status: 500, statusText: " VM 101 already exists on node 'pve1' ", body: '{"data":null}' });
    const answer = await clientOn(wire.transport).request(request("POST", "/nodes/pve1/qemu/9000/clone", { newid: 101 }), SIGNAL);
    expect(answer).toEqual({ status: 500, message: "VM 101 already exists on node 'pve1'", data: null });
  });

  it("gives the data null for an error with a body that is not JSON, and for an empty body", async () => {
    const html = await clientOn(recorder({ status: 502, statusText: "Bad Gateway", body: "<html>proxy</html>" }).transport).request(request("GET", "/version"), SIGNAL);
    expect(html).toEqual({ status: 502, message: "Bad Gateway", data: null });
    const empty = await clientOn(recorder({ status: 200, statusText: "OK", body: "" }).transport).request(request("GET", "/version"), SIGNAL);
    expect(empty).toEqual({ status: 200, message: "OK", data: null });
    const noData = await clientOn(recorder({ status: 200, statusText: "OK", body: '{"errors":{}}' }).transport).request(request("GET", "/version"), SIGNAL);
    expect(noData.data).toBeNull();
  });

  it("throws for a body of a status 2xx that is not JSON, because it is not an answer of the API", async () => {
    const wire = recorder({ status: 200, statusText: "OK", body: "<html>login</html>" });
    await expect(clientOn(wire.transport).request(request("GET", "/version"), SIGNAL)).rejects.toThrow(
      new Error("The answer 200 of Proxmox VE to GET /version is not JSON."),
    );
  });

  it("removes the token from the message of an answer, and cuts a long message", async () => {
    const leak = await clientOn(recorder({ status: 401, statusText: `bad token ${TOKEN}`, body: "" }).transport).request(request("GET", "/version"), SIGNAL);
    expect(leak.message).toBe("bad token [token]");
    const long = await clientOn(recorder({ status: 500, statusText: "x".repeat(2000), body: "" }).transport).request(request("GET", "/version"), SIGNAL);
    expect(long.message).toHaveLength(PROXMOX_MESSAGE_LIMIT);
  });

  it("throws when the transport gets no reply, with no part of the token in the text", async () => {
    const transport: ProxmoxTransport = async () => {
      throw new Error(`connect ECONNREFUSED with the header PVEAPIToken=${TOKEN}`);
    };
    const failure = await clientOn(transport)
      .request(request("POST", "/nodes/pve1/qemu/101/status/start"), SIGNAL)
      .then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Proxmox VE gave no answer to POST /nodes/pve1/qemu/101/status/start: connect ECONNREFUSED with the header PVEAPIToken=[token]");
    expect((failure as Error).message).not.toContain(SECRET);
  });

  it("sends nothing when the signal stopped the pass", async () => {
    const wire = recorder(okReply(null));
    await expect(clientOn(wire.transport).request(request("GET", "/version"), { aborted: true })).rejects.toThrow("The signal stopped the request GET /version.");
    expect(wire.sent).toEqual([]);
  });

  it("gives the signal of the request to the transport", async () => {
    const signals: StopSignal[] = [];
    const signal: StopSignal = { aborted: false };
    await clientOn(async (_exchange, given) => {
      signals.push(given);
      return okReply(null);
    }).request(request("GET", "/version"), signal);
    expect(signals).toEqual([signal]);
    expect(signals[0]).toBe(signal);
  });

  describe("options", () => {
    it.each([
      ["http", "http://pve.example:8006", "The scheme must be https"],
      ["a path", "https://pve.example:8006/api2/json", "has a path"],
      ["a query", "https://pve.example:8006/?a=1", "has a path"],
      ["a user", "https://root:pw@pve.example:8006", "has a user"],
      ["no URL", "pve example", "is not a URL"],
      ["a space in the host", "https://pve example:8006", "has no valid host and port"],
      ["a port out of range", "https://pve.example:70000", "has no valid host and port"],
      ["no host", "https://:8006", "has no valid host and port"],
      ["a fragment", "https://pve.example:8006#a", "has a path"],
    ])("refuses a URL with %s", (_name, url, problem) => {
      expect(() => createProxmoxClient({ url, token: TOKEN, transport: recorder(okReply(null)).transport })).toThrow(problem);
      expect(proxmoxUrlProblems(url)).toHaveLength(1);
    });

    it("accepts a base URL with a slash at its end, and an address in place of a name", async () => {
      expect(proxmoxUrlProblems("https://pve.example:8006/")).toEqual([]);
      expect(proxmoxUrlProblems("https://[fd00::5]:8006")).toEqual([]);
      const wire = recorder(okReply(null));
      await createProxmoxClient({ url: "https://10.0.0.5:8006/", token: TOKEN, transport: wire.transport }).request(request("GET", "/version"), SIGNAL);
      expect(wire.sent[0]?.url).toBe("https://10.0.0.5:8006/api2/json/version");
    });

    it("sends each request to the origin of the URL: the host in lowercase, and no port 443", async () => {
      for (const [url, origin] of [
        ["HTTPS://PVE.Example:8006", "https://pve.example:8006"],
        ["https://pve.example:443/", "https://pve.example"],
        ["https://pve.example", "https://pve.example"],
        ["https://[FD00::5]:8006", "https://[fd00::5]:8006"],
      ] as const) {
        const wire = recorder(okReply(null));
        await createProxmoxClient({ url, token: TOKEN, transport: wire.transport }).request(request("GET", "/version"), SIGNAL);
        expect(wire.sent[0]?.url).toBe(`${origin}/api2/json/version`);
      }
    });

    it.each([
      ["no realm", "dispatch!runners=abc"],
      ["no token id", "dispatch@pve=abc"],
      ["no secret", "dispatch@pve!runners="],
      ["a line break in the secret", "dispatch@pve!runners=abc\r\nx: y"],
      ["a space", "dispatch @pve!runners=abc"],
    ])("refuses a token with %s, and the error has no part of the token", (_name, token) => {
      let text = "";
      try {
        createProxmoxClient({ url: URL_OF_HOST, token, transport: recorder(okReply(null)).transport });
      } catch (error) {
        text = (error as Error).message;
      }
      expect(text).toBe("The options of the Proxmox client are not valid. The API token is not of the form USER@REALM!TOKENID=SECRET.");
      expect(isProxmoxToken(token)).toBe(false);
    });

    it("accepts a token of Proxmox VE", () => {
      expect(isProxmoxToken(TOKEN)).toBe(true);
      expect(isProxmoxToken("root@pam!ci-1=abc")).toBe(true);
      expect(isProxmoxToken(42)).toBe(false);
    });
  });

  it("keeps each path part and each parameter through the wire: Proxmox VE reads the request that the provider wrote", async () => {
    const part = fc.string({ minLength: 1, maxLength: 12, unit: "grapheme" }).filter((text) => /^[^\s/?#]+$/.test(text) && text !== "." && text !== "..");
    const value = fc.oneof(fc.string({ maxLength: 40, unit: "grapheme" }), fc.integer(), fc.double({ noNaN: true, noDefaultInfinity: true }));
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<ProxmoxMethod>("GET", "POST", "PUT", "DELETE"),
        fc.array(part, { minLength: 1, maxLength: 5 }),
        fc.dictionary(fc.string({ minLength: 1, maxLength: 10, unit: "grapheme" }), value, { maxKeys: 5 }),
        async (method, parts, parameters) => {
          const seen: ProxmoxRequest[] = [];
          const echo: ProxmoxApi = {
            request: async (got) => {
              seen.push(got);
              return { status: 200, message: "OK", data: null };
            },
          };
          const path = `/${parts.join("/")}`;
          await clientOn(wireOf(echo)).request({ method, path, parameters }, SIGNAL);
          const texts = Object.fromEntries(Object.entries(parameters).map(([name, each]) => [name, String(each)]));
          expect(seen).toEqual([{ method, path, parameters: texts }]);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("encodes a form as URLSearchParams encodes it, for each code unit and each lone surrogate", async () => {
    // Each code unit from 0 to 0xFFFF. Thus the texts have lone surrogates, controls and each mark of ASCII.
    const unit = fc.integer({ min: 0, max: 0xffff }).map((code) => String.fromCharCode(code));
    const text = fc.string({ maxLength: 24, unit });
    await fc.assert(
      fc.asyncProperty(fc.dictionary(fc.string({ minLength: 1, maxLength: 8, unit }), text, { maxKeys: 4 }), async (parameters) => {
        const wire = recorder(okReply(null));
        await clientOn(wire.transport).request(request("POST", "/nodes/pve1/qemu", parameters), SIGNAL);
        const sorted = Object.keys(parameters)
          .sort()
          .map((name) => [name, parameters[name] ?? ""]);
        expect(wire.sent[0]?.body).toBe(new URLSearchParams(sorted).toString());
      }),
      { numRuns: 500 },
    );
  });

  it("makes, delivers and destroys a machine on a fake Proxmox VE through the wire", async () => {
    const fake: FakeProxmox = fakeProxmox({ pool: "runners", templates: [{ vmid: 9000, node: "pve1", agent: true }] });
    const problems: string[] = [];
    const provider = createProxmoxProvider({
      api: clientOn(wireOf(fake.api)),
      pool: "runners",
      sizes: { small: { node: "pve1", template: 9000, cores: 2, memory: 4096 } },
      problem: (text) => problems.push(text),
    });
    const machine = { name: "rd-42-1-0a0b0c0d", size: "small", repository: "octo/app", runId: 42, runAttempt: 1 };
    await provider.make(
      { machine, configuration: "jit-configuration", check: { rules: { repositories: ["octo/app"], events: ["push"], actors: ["octo"] }, run: { repository: "octo/app", runId: 42, runAttempt: 1 } } },
      SIGNAL,
    );
    const statusOf = async (): Promise<string> => (await provider.machines(SIGNAL)).find((each) => each.machine.name === machine.name)?.status ?? "absent";
    const until = async (wanted: string): Promise<void> => {
      for (let list = 0; list < 30 && (await statusOf()) !== wanted; list += 1) fake.tick();
      expect(await statusOf()).toBe(wanted);
    };
    await until("operating");
    const made = fake.vms().find((vm) => vm.name === machine.name);
    expect(made?.tags).toContain(DELIVERED_TAG);
    expect(made?.cores).toBe(2);
    expect(made?.memory).toBe(4096);
    expect(made?.files.get("/run/runner-dispatch/configuration")).toBe("jit-configuration");
    await provider.destroy(machine.name, SIGNAL);
    await until("absent");
    expect(problems).toEqual([]);
  });
});
