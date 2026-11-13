import type { ProxmoxTransport } from "@mark1russell7/runner-dispatch/proxmox-client";
import { httpRequest, httpSettings, type HttpSettings } from "@procedures/http";

/** This constant is the longest time of one exchange with Proxmox VE, in milliseconds. The bound of a pass also stops it. */
export const EXCHANGE_TIMEOUT_MS = 30_000;

/**
 * This function gives the host policy of the transport: only the host and the port of the URL.
 * Proxmox VE is on a private network, and the default policy of `@procedures/http` refuses a private address.
 *
 * @param url - The base URL of Proxmox VE
 * @returns The settings of `httpRequest`
 */
export function hostSettings(url: string): HttpSettings {
  const base = new URL(url);
  const port = base.port !== "" ? base.port : base.protocol === "https:" ? "443" : "80";
  return httpSettings({ allow: [`${base.hostname}:${port}`], publicHosts: false });
}

/**
 * This function makes the transport of a Proxmox client on `httpRequest` of `@procedures/http`.
 *
 * - The transport sends each exchange only to the origin of the URL: its scheme, its host and its port.
 * - The host policy of `httpRequest` lets the transport reach only that host and port.
 * - It does not follow a redirect, thus the token goes to no other host.
 * - The trust of TLS is the trust of Node.js. Give the certificate authority of a host to `NODE_EXTRA_CA_CERTS`.
 *
 * @param url - The base URL of Proxmox VE
 * @returns The transport
 */
export function proxmoxTransport(url: string): ProxmoxTransport<AbortSignal> {
  const settings = hostSettings(url);
  const origin = new URL(url).origin;
  return async (exchange, signal) => {
    if (new URL(exchange.url).origin !== origin) throw new Error("The exchange goes to another origin than the URL of Proxmox VE.");
    const reply = await httpRequest(
      {
        method: exchange.method,
        url: exchange.url,
        headers: { ...exchange.headers },
        body: exchange.body,
        responseType: "text",
        redirect: "error",
        timeoutMs: EXCHANGE_TIMEOUT_MS,
      },
      { signal },
      settings,
    );
    return { status: reply.status, statusText: reply.statusText, body: typeof reply.body === "string" ? reply.body : "" };
  };
}
