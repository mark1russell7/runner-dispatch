/**
 * This module has the fakes of the tests of the package. They are a document of a program, the two secrets, a GitHub API
 * from a script, and a transport on a fake Proxmox VE. The program does not import this module.
 */
import type { GitHubAnswer, GitHubApi, GitHubRequest } from "@mark1russell7/runner-dispatch/github";
import type { ProxmoxApi } from "@mark1russell7/runner-dispatch/proxmox";
import { PROXMOX_API_PATH, type ProxmoxExchange, type ProxmoxTransport } from "@mark1russell7/runner-dispatch/proxmox-client";
import type { Secrets } from "./program.ts";

/** This constant is the repository of the tests. */
export const REPO = "octo/app";

/** This constant is the base URL of the fake Proxmox VE. */
export const PVE = "https://pve.example:8006";

/** This constant is the token of the fake Proxmox VE. */
export const PROXMOX_TOKEN = "dispatch@pve!runners=0123-secret-of-proxmox";

/** This constant is the token of the fake GitHub. */
export const GITHUB_TOKEN = "ghp_secret-of-github";

/** This record has the two secrets of the tests. */
export const SECRETS: Secrets = { github: GITHUB_TOKEN, proxmox: PROXMOX_TOKEN };

/** This record is the field `github` of a program with the organization octo and its runner group 3. */
export const ORGANIZATION: Record<string, unknown> = { github: { organization: "octo", runnerGroup: 3 } };

/** This function gives a valid document of a program, with the changes of a test. */
export const doc = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  format: "dispatcher-program/1",
  rules: { format: "trust-rules/1", repositories: [REPO], events: ["push"], actors: ["octo"] },
  times: { format: "machine-times/1", make: 60, register: 60, idle: 30, job: 600, retry: 5, retryMax: 40, pass: 10 },
  settings: { format: "dispatch-settings/1", prefix: "rd", capacity: 2, sizes: ["small"], standard: "small" },
  loop: { sleep: 5, bound: 2, retry: 1, retryMax: 2, close: 0.5 },
  profile: "local",
  stop: "/run/runner-dispatch/stop",
  github: {},
  proxmox: { url: PVE, pool: "runners", sizes: { small: { node: "pve1", template: 9000, cores: 2, memory: 4096 } } },
  ...over,
});

/** This function makes a transport on a fake Proxmox VE. It refuses a wrong token, as Proxmox VE does. */
export const wireOf =
  (api: ProxmoxApi, sent: ProxmoxExchange[] = []): ProxmoxTransport<AbortSignal> =>
  async (exchange, signal) => {
    sent.push(exchange);
    const url = new URL(exchange.url);
    if (url.origin !== new URL(PVE).origin || !url.pathname.startsWith(`${PROXMOX_API_PATH}/`)) throw new Error("The exchange went to another place.");
    if (exchange.headers["authorization"] !== `PVEAPIToken=${PROXMOX_TOKEN}`) return { status: 401, statusText: "authentication failure", body: '{"data":null}' };
    const form = exchange.body === undefined ? url.searchParams : new URLSearchParams(exchange.body);
    const path = url.pathname
      .slice(PROXMOX_API_PATH.length)
      .split("/")
      .map((part) => decodeURIComponent(part))
      .join("/");
    const answer = await api.request({ method: exchange.method, path, parameters: Object.fromEntries(form) }, signal);
    return { status: answer.status, statusText: answer.message, body: JSON.stringify({ data: answer.data }) };
  };

/** This transport refuses each exchange. A test that must send nothing to Proxmox VE uses it. */
export const noProxmox: ProxmoxTransport<AbortSignal> = () => Promise.reject(new Error("The test sends nothing to Proxmox VE."));

/** This record is a GitHub API from a script, with each request that it got. */
export interface ScriptedGitHub {
  readonly api: GitHubApi<AbortSignal>;
  readonly requests: GitHubRequest[];
}

/** This function makes a GitHub API that answers from a script, and keeps each request. */
export const scripted = (answer: (request: GitHubRequest) => GitHubAnswer): ScriptedGitHub => {
  const requests: GitHubRequest[] = [];
  const api: GitHubApi<AbortSignal> = {
    request: (request) => {
      requests.push(request);
      return Promise.resolve(answer(request));
    },
  };
  return { api, requests };
};

/** This function gives the record of the runner group 3, with the changes of a test. */
const group = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 3,
  name: "home",
  visibility: "selected",
  default: false,
  allows_public_repositories: false,
  ...over,
});

/** This function gives the GitHub API of a runner group 3 of the organization octo, with the repositories of a test. */
export const groupApi = (over: Record<string, unknown> = {}, repositories: readonly string[] = [REPO]): ScriptedGitHub =>
  scripted((request) => {
    if (request.path === "/orgs/octo/actions/runner-groups/3") return { status: 200, body: group(over) };
    if (request.path === "/orgs/octo/actions/runner-groups/3/repositories") {
      return { status: 200, body: { total_count: repositories.length, repositories: repositories.map((full_name, id) => ({ id, full_name, private: true })) } };
    }
    return { status: 404, body: null };
  });

/** This function waits until Node.js has done the work that is ready. */
export const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
