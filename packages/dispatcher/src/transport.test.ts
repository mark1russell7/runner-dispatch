import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hostSettings, proxmoxTransport } from "./transport.ts";

/** This record is one request that the local server got. */
interface Got {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
}

const got: Got[] = [];
let server: Server;
let base = "";

const answer = (request: IncomingMessage, response: ServerResponse, body: string): void => {
  got.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers, body });
  if (request.url?.startsWith("/api2/json/moved") === true) {
    // The redirect goes to the same server: a transport that follows it gets the status 200.
    response.writeHead(302, { location: "/api2/json/version" }).end();
    return;
  }
  if (request.url?.startsWith("/api2/json/forbidden") === true) {
    response.writeHead(403, "Permission check failed (/vms/101, VM.Allocate)", { "content-type": "application/json" }).end('{"data":null}');
    return;
  }
  response.writeHead(200, "OK", { "content-type": "application/json" }).end('{"data":{"version":"9.0"}}');
};

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (part: string) => (body += part));
    request.on("end", () => answer(request, response, body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const SIGNAL = new AbortController().signal;
const HEADERS = { accept: "application/json", authorization: "PVEAPIToken=dispatch@pve!runners=secret" };

describe("hostSettings", () => {
  it("allows only the host and the port of the URL, with the default port of the scheme", () => {
    const texts = (url: string): readonly string[] => hostSettings(url).policy.entries.map((entry) => entry.text);
    expect(texts("https://pve.example:8006")).toEqual(["pve.example:8006"]);
    expect(texts("https://pve.example")).toEqual(["pve.example:443"]);
    expect(texts("https://[fd00::5]:8006")).toEqual(["[fd00::5]:8006"]);
    expect(hostSettings("https://pve.example:8006").policy.publicHosts).toBe(false);
  });
});

describe("proxmoxTransport", () => {
  it("sends a GET with its headers and no body, and gives the status, the reason phrase and the body", async () => {
    const send = proxmoxTransport(base);
    const reply = await send({ method: "GET", url: `${base}/api2/json/version?a=1`, headers: HEADERS, body: undefined }, SIGNAL);
    expect(reply).toEqual({ status: 200, statusText: "OK", body: '{"data":{"version":"9.0"}}' });
    const last = got.at(-1);
    expect(last?.method).toBe("GET");
    expect(last?.url).toBe("/api2/json/version?a=1");
    expect(last?.headers["authorization"]).toBe(HEADERS.authorization);
    expect(last?.body).toBe("");
  });

  it("sends a POST with its form body and its content type", async () => {
    const send = proxmoxTransport(base);
    const headers = { ...HEADERS, "content-type": "application/x-www-form-urlencoded" };
    await send({ method: "POST", url: `${base}/api2/json/nodes/pve1/qemu/9000/clone`, headers, body: "newid=101&pool=runners" }, SIGNAL);
    const last = got.at(-1);
    expect(last?.method).toBe("POST");
    expect(last?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(last?.body).toBe("newid=101&pool=runners");
  });

  it("gives an error status as a reply, with the text of Proxmox VE in the reason phrase", async () => {
    const send = proxmoxTransport(base);
    const reply = await send({ method: "DELETE", url: `${base}/api2/json/forbidden`, headers: HEADERS, body: undefined }, SIGNAL);
    expect(reply).toEqual({ status: 403, statusText: "Permission check failed (/vms/101, VM.Allocate)", body: '{"data":null}' });
  });

  it("does not follow a redirect", async () => {
    const send = proxmoxTransport(base);
    const before = got.length;
    await expect(send({ method: "GET", url: `${base}/api2/json/moved`, headers: HEADERS, body: undefined }, SIGNAL)).rejects.toThrow();
    expect(got.length).toBe(before + 1);
  });

  it("refuses a URL on another host or another port, and sends nothing", async () => {
    const send = proxmoxTransport(base);
    const before = got.length;
    const port = Number(new URL(base).port);
    const other = "The exchange goes to another origin than the URL of Proxmox VE.";
    await expect(send({ method: "GET", url: `http://127.0.0.1:${port + 1}/api2/json/version`, headers: HEADERS, body: undefined }, SIGNAL)).rejects.toThrow(other);
    await expect(send({ method: "GET", url: `http://localhost:${port}/api2/json/version`, headers: HEADERS, body: undefined }, SIGNAL)).rejects.toThrow(other);
    await expect(send({ method: "GET", url: `https://127.0.0.1:${port}/api2/json/version`, headers: HEADERS, body: undefined }, SIGNAL)).rejects.toThrow(other);
    expect(got.length).toBe(before);
  });

  it("stops at an aborted signal", async () => {
    const send = proxmoxTransport(base);
    await expect(send({ method: "GET", url: `${base}/api2/json/version`, headers: HEADERS, body: undefined }, AbortSignal.abort())).rejects.toThrow();
  });
});
