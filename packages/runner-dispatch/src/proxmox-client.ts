import { isObject, show } from "./policy.ts";
import type { StopSignal } from "./ports.ts";
import type { ProxmoxAnswer, ProxmoxApi, ProxmoxMethod, ProxmoxRequest } from "./proxmox.ts";

/** This record is one HTTP exchange that the transport of a Proxmox client sends. */
export interface ProxmoxExchange {
  /** This field is the method of the exchange. */
  readonly method: ProxmoxMethod;
  /** This field is the whole URL. The URL of a `GET` or a `DELETE` has the parameters in its query. */
  readonly url: string;
  /** This field has the headers, with names in lowercase. The header `authorization` has the API token. */
  readonly headers: Readonly<Record<string, string>>;
  /** This field is the form body of a `POST` or a `PUT`. It is `undefined` for a `GET` or a `DELETE`. */
  readonly body: string | undefined;
}

/** This record is the reply to one exchange. */
export interface ProxmoxReply {
  /** This field is the HTTP status. */
  readonly status: number;
  /** This field is the reason phrase of the status line. Proxmox VE puts the text of an error there. */
  readonly statusText: string;
  /** This field is the body, as text. */
  readonly body: string;
}

/**
 * This type is the transport of a Proxmox client: it sends one exchange.
 * Each status is a reply. The transport throws only when it gets no reply, or when the signal stops it.
 * It does not follow a redirect, because the token must not go to another host.
 */
export type ProxmoxTransport<Signal extends StopSignal = StopSignal> = (exchange: ProxmoxExchange, signal: Signal) => Promise<ProxmoxReply>;

/** This record has the options of a Proxmox client. */
export interface ProxmoxClientOptions<Signal extends StopSignal = StopSignal> {
  /** This field is the base URL of the host, for example `https://pve.example:8006`. It has the scheme `https`, and no path, query or user. */
  readonly url: string;
  /** This field is the API token, as `USER@REALM!TOKENID=SECRET`. No error text of the client has it. */
  readonly token: string;
  /** This field is the transport of the exchanges. */
  readonly transport: ProxmoxTransport<Signal>;
}

/** This constant is the path of the API under the base URL. */
export const PROXMOX_API_PATH = "/api2/json";

/** This constant is the most characters of the message of an answer. */
export const PROXMOX_MESSAGE_LIMIT = 500;

const METHODS: ReadonlySet<string> = new Set<ProxmoxMethod>(["GET", "POST", "PUT", "DELETE"]);
const BODY_METHODS: ReadonlySet<string> = new Set<ProxmoxMethod>(["POST", "PUT"]);
// The user, the realm, the token id and the secret. The secret has only printable characters of ASCII, thus a header has no line break.
const TOKEN = /^[^\s@!=:]+@[A-Za-z][A-Za-z0-9._-]*![A-Za-z][A-Za-z0-9._-]*=[!-~]+$/;
const SEGMENT = /^[^\s/?#]+$/;
const REDACTED = "[token]";
// The scheme, the authority and the rest of a URL. The client reads a URL with no type of a platform, thus it runs on each runtime.
const URL_PARTS = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^]*)$/;
// A host name, an IPv4 address or an IPv6 address in brackets, and an optional port.
const HOST_PORT = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)(?::(\d{1,5}))?$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * This function tells if a text is an API token of Proxmox VE, as `USER@REALM!TOKENID=SECRET`.
 *
 * @param value - The value
 * @returns `true` for a token of the form
 */
export function isProxmoxToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value);
}

/**
 * This function gives the problems of a base URL of Proxmox VE. The text of a problem has no part of the URL after the host.
 *
 * @param value - The URL
 * @returns The problems. The list is empty for a valid URL.
 */
export function proxmoxUrlProblems(value: unknown): string[] {
  return readBase(value).problems;
}

/** This function reads a base URL: its origin, or its problems. The origin has the host in lowercase, and no port 443. */
function readBase(value: unknown): { readonly origin: string; readonly problems: string[] } {
  if (typeof value !== "string") return { origin: "", problems: [`The URL of Proxmox VE is not a text: ${show(value)}.`] };
  const parts = URL_PARTS.exec(value);
  if (parts === null) return { origin: "", problems: ["The URL of Proxmox VE is not a URL."] };
  const [, scheme = "", authority = "", rest = ""] = parts;
  const problems: string[] = [];
  const named = `${scheme.toLowerCase()}:`;
  if (named !== "https:") problems.push(`The URL of Proxmox VE has the scheme ${show(named)}. The scheme must be https, because each request has the token.`);
  const at = authority.lastIndexOf("@");
  if (at >= 0) problems.push("The URL of Proxmox VE has a user. The client sends the token in a header.");
  if (rest !== "" && rest !== "/") problems.push("The URL of Proxmox VE has a path, a query or a fragment. It has only the scheme, the host and the port.");
  const hostPort = HOST_PORT.exec(authority.slice(at + 1));
  const port = hostPort?.[2] === undefined ? 443 : Number(hostPort[2]);
  if (hostPort === null || port < 1 || port > 65_535) {
    problems.push("The URL of Proxmox VE has no valid host and port. The host is a name, an IPv4 address or an IPv6 address in brackets.");
    return { origin: "", problems };
  }
  const host = (hostPort[1] ?? "").toLowerCase();
  return { origin: `https://${host}${port === 443 ? "" : `:${port}`}`, problems };
}

/** This function encodes one name or one value of a form, as the encoding `application/x-www-form-urlencoded` does. */
function formPart(text: string): string {
  return encodeURIComponent(text.replace(LONE_SURROGATE, "�"))
    .replace(/[!'()~]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+");
}

/** This function gives the path of a request in a URL. Each part of the path is encoded, and the parts `.` and `..` are refused. */
function encodedPath(path: string): string | null {
  if (!path.startsWith("/")) return null;
  const parts = path.slice(1).split("/");
  if (parts.some((part) => !SEGMENT.test(part) || part === "." || part === "..")) return null;
  // A task id has the characters `:` and `@`, and the API reads them in a path with no encoding.
  return parts.map((part) => `/${encodeURIComponent(part).replace(/%3A/g, ":").replace(/%40/g, "@")}`).join("");
}

/** This function gives the parameters as a form, sorted by name. Thus one request has one URL and one body. */
function formOf(parameters: Readonly<Record<string, string | number>>): string | null {
  const parts: string[] = [];
  for (const name of Object.keys(parameters).sort()) {
    const value: unknown = parameters[name];
    if (typeof value === "number" && Number.isFinite(value)) parts.push(`${formPart(name)}=${formPart(String(value))}`);
    else if (typeof value === "string") parts.push(`${formPart(name)}=${formPart(value)}`);
    else return null;
  }
  return parts.join("&");
}

/** This function gives the field `data` of a JSON body, or `undefined` when the body is not JSON. */
function dataOf(body: string): unknown {
  if (body.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  return isObject(parsed) && Object.hasOwn(parsed, "data") ? (parsed["data"] ?? null) : null;
}

/**
 * This function makes a client of the API of Proxmox VE on a transport.
 *
 * - The client adds the header `authorization: PVEAPIToken=<token>` to each request. An API token needs no ticket and no CSRF header.
 * - The parameters of a `GET` or a `DELETE` go in the query. The parameters of a `POST` or a `PUT` go in a form body, thus the access log of the host has no value of them.
 * - The message of an answer is the reason phrase of its status line. The data is the field `data` of the JSON body.
 * - A body of a status 2xx that is not JSON is not an answer, thus the client throws. A body of an error that is not JSON gives the data `null`.
 *
 * @param options - The base URL, the token and the transport
 * @returns The client
 * @throws RangeError when the URL or the token is not valid. The text of the error has no part of the token.
 */
export function createProxmoxClient<Signal extends StopSignal = StopSignal>(options: ProxmoxClientOptions<Signal>): ProxmoxApi<Signal> {
  const read = readBase(options.url);
  const problems = [...read.problems];
  if (!isProxmoxToken(options.token)) problems.push("The API token is not of the form USER@REALM!TOKENID=SECRET.");
  if (typeof options.transport !== "function") problems.push("The transport is not a function.");
  if (problems.length > 0) throw new RangeError(`The options of the Proxmox client are not valid. ${problems.join(" ")}`);
  const base = `${read.origin}${PROXMOX_API_PATH}`;
  const { token, transport } = options;
  const headers: Readonly<Record<string, string>> = Object.freeze({ accept: "application/json", authorization: `PVEAPIToken=${token}` });
  const formHeaders: Readonly<Record<string, string>> = Object.freeze({ ...headers, "content-type": "application/x-www-form-urlencoded" });
  const clean = (text: string): string => text.split(token).join(REDACTED);

  return {
    async request(request: ProxmoxRequest, signal: Signal): Promise<ProxmoxAnswer> {
      if (!METHODS.has(request.method)) throw new RangeError(`The method ${show(request.method)} is not a method of the client.`);
      const path = typeof request.path === "string" ? encodedPath(request.path) : null;
      if (path === null) throw new RangeError(`The path ${show(request.path)} is not a path of the API.`);
      const form = formOf(request.parameters);
      if (form === null) throw new RangeError(`A parameter of ${request.method} ${path} is not a text or a finite number.`);
      const what = `${request.method} ${path}`;
      if (signal.aborted) throw new Error(`The signal stopped the request ${what}.`);
      const inBody = BODY_METHODS.has(request.method);
      const query = form;
      const exchange: ProxmoxExchange = {
        method: request.method,
        url: `${base}${path}${!inBody && query !== "" ? `?${query}` : ""}`,
        headers: inBody ? formHeaders : headers,
        body: inBody ? query : undefined,
      };
      let reply: ProxmoxReply;
      try {
        reply = await transport(exchange, signal);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Proxmox VE gave no answer to ${what}: ${clean(reason)}`);
      }
      const ok = reply.status >= 200 && reply.status < 300;
      const data = dataOf(typeof reply.body === "string" ? reply.body : "");
      if (data === undefined && ok) throw new Error(`The answer ${reply.status} of Proxmox VE to ${what} is not JSON.`);
      const message = typeof reply.statusText === "string" ? clean(reply.statusText.trim()).slice(0, PROXMOX_MESSAGE_LIMIT) : "";
      return { status: reply.status, message, data: data ?? null };
    },
  };
}
