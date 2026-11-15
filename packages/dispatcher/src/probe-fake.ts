/**
 * This module is a fake REST API of GitHub for the tests of the probe. A test and a child process of a test use it.
 */
import type { RestExchange, RestReply, RestTransport } from "@procedures/gh";

/** This token is the token that the fake accepts. */
export const TOKEN = "github_pat_secret-of-the-probe";
/** This text is the configuration of a one-job runner that the fake gives. */
export const CONFIG = "SECRET-ONE-JOB-CONFIGURATION";

/** This record has the options of the fake GitHub of a probe. */
export interface FakeOptions {
  /** This field is the count of the used requests of one answer 304. The default is 0. */
  readonly cost304?: number;
  /** This function gives the requests of another client before the exchange with this index. */
  readonly others?: (index: number) => number;
  /** This field is the visibility that GitHub keeps for a new group. The default is the visibility of the request. */
  readonly keeps?: string;
  /** This function gives a status that refuses a request, or `null`. */
  readonly refuse?: (method: string, path: string) => number | null;
  /** This field is the count of the runs of the repository. The default is 1. */
  readonly runs?: number;
  /** This function runs before each exchange, with its method and path. */
  readonly before?: (method: string, path: string) => void;
}

/** This function gives the permissions header of a route of the fake. The names are the names of a test. */
const permissionsOf = (method: string, path: string): string => {
  if (path === "/repos/octo/app") return "metadata=read";
  if (path.includes("/actions/runs")) return "actions=read";
  if (path.startsWith("/orgs/")) return method === "GET" ? "organization_self_hosted_runners=read" : "organization_self_hosted_runners=write";
  return method === "GET" ? "administration=read; administration=write" : "administration=write";
};

/** This function makes a fake REST API of GitHub at the level of a transport, with the counts of the primary limit. */
export const fakeGitHub = (options: FakeOptions = {}) => {
  let used = 40;
  let index = 0;
  let nextRunner = 50;
  let nextGroup = 10;
  const sent: RestExchange[] = [];
  const groups = new Map<number, { id: number; name: string; visibility: string; default: boolean; allows_public_repositories: boolean; repositories: number[] }>([
    [1, { id: 1, name: "Default", visibility: "all", default: true, allows_public_repositories: false, repositories: [] }],
  ]);
  const runners = new Map<number, { id: number; name: string; labels: string[]; group: number; scope: string }>();
  const reply = (status: number, body: unknown, method: string, path: string, extra: Record<string, string> = {}): RestReply => ({
    status,
    headers: {
      "X-Accepted-GitHub-Permissions": permissionsOf(method, path),
      "X-RateLimit-Used": String(used),
      "X-RateLimit-Resource": "core",
      ...extra,
    },
    body,
  });
  const runsBody = (count: number): unknown => ({
    total_count: count,
    workflow_runs: Array.from({ length: count }, (_, at) => ({ id: 900 + at, run_attempt: 1, status: "completed" })),
  });
  const transport: RestTransport = (exchange) => {
    sent.push(exchange);
    used += options.others?.(index) ?? 0;
    index += 1;
    const url = new URL(exchange.url);
    const path = url.pathname;
    const method = exchange.method;
    options.before?.(method, path);
    if (exchange.headers["authorization"] !== `Bearer ${TOKEN}`) return Promise.resolve({ status: 401, headers: {}, body: { message: "Bad credentials" } });
    if (path === "/rate_limit") return Promise.resolve(reply(200, { resources: { core: { limit: 5000, used, remaining: 5000 - used } } }, method, path));
    const refused = options.refuse?.(method, path) ?? null;
    if (refused !== null) {
      used += 1;
      return Promise.resolve(reply(refused, { message: "Resource not accessible by personal access token" }, method, path));
    }
    if (method === "GET" && path === "/repos/octo/app/actions/runs" && url.searchParams.get("status") === "queued") {
      if (exchange.headers["if-none-match"] === 'W/"runs-v1"') {
        used += options.cost304 ?? 0;
        return Promise.resolve(reply(304, null, method, path, { ETag: 'W/"runs-v1"' }));
      }
      used += 1;
      return Promise.resolve(reply(200, runsBody(0), method, path, { ETag: 'W/"runs-v1"' }));
    }
    used += 1;
    const answer = (status: number, body: unknown = null): Promise<RestReply> => Promise.resolve(reply(status, body, method, path));
    if (method === "GET" && path === "/repos/octo/app") return answer(200, { id: 77, full_name: "octo/app", private: true });
    if (method === "GET" && path === "/repos/octo/app/actions/runs") return answer(200, runsBody(Math.min(options.runs ?? 1, 1)));
    if (method === "GET" && path === "/repos/octo/app/actions/runs/900") return answer(200, { id: 900, run_attempt: 1 });
    if (method === "GET" && path === "/repos/octo/app/actions/runs/900/attempts/1/jobs") return answer(200, { total_count: 0, jobs: [] });
    const scope = /^(\/repos\/octo\/app|\/orgs\/octo)\/actions\/runners(?:\/(.+))?$/.exec(path);
    if (scope !== null) {
      const at = scope[1] as string;
      const rest = scope[2];
      const mine = [...runners.values()].filter((runner) => runner.scope === at);
      if (method === "GET" && rest === undefined) return answer(200, { total_count: mine.length, runners: mine });
      if (method === "POST" && rest === "generate-jitconfig") {
        const body = exchange.body as { name: string; labels: string[]; runner_group_id: number };
        if (!groups.has(body.runner_group_id)) return answer(404, { message: "Not Found" });
        const id = nextRunner;
        nextRunner += 1;
        runners.set(id, { id, name: body.name, labels: body.labels, group: body.runner_group_id, scope: at });
        return answer(201, { runner: { id, name: body.name }, encoded_jit_config: CONFIG });
      }
      const runner = rest === undefined ? undefined : mine.find((each) => String(each.id) === rest);
      if (runner === undefined) return answer(404, { message: "Not Found" });
      if (method === "GET") {
        const labels = [{ id: 1, name: "self-hosted", type: "read-only" }, ...runner.labels.map((name, at) => ({ id: at + 2, name, type: "custom" }))];
        return answer(200, { id: runner.id, name: runner.name, status: "offline", busy: false, labels });
      }
      if (method === "DELETE") {
        runners.delete(runner.id);
        return answer(204);
      }
    }
    const group = /^\/orgs\/octo\/actions\/runner-groups(?:\/(\d+)(?:\/(repositories|runners))?)?$/.exec(path);
    if (group !== null) {
      const id = group[1] === undefined ? null : Number(group[1]);
      const found = id === null ? undefined : groups.get(id);
      if (id === null && method === "GET") return answer(200, { total_count: groups.size, runner_groups: [...groups.values()] });
      if (id === null && method === "POST") {
        const body = exchange.body as { name: string; visibility: string; selected_repository_ids: number[]; allows_public_repositories: boolean };
        const made = { id: nextGroup, name: body.name, visibility: options.keeps ?? body.visibility, default: false, allows_public_repositories: body.allows_public_repositories, repositories: body.selected_repository_ids };
        nextGroup += 1;
        groups.set(made.id, made);
        return answer(201, made);
      }
      if (found === undefined) return answer(404, { message: "Not Found" });
      if (method === "GET" && group[2] === undefined) return answer(200, found);
      if (method === "GET" && group[2] === "repositories") {
        return answer(200, { total_count: found.repositories.length, repositories: found.repositories.map((each) => ({ id: each, full_name: "octo/app", private: true })) });
      }
      if (method === "GET" && group[2] === "runners") {
        const members = [...runners.values()].filter((runner) => runner.group === found.id);
        return answer(200, { total_count: members.length, runners: members });
      }
      if (method === "DELETE") {
        if ([...runners.values()].some((runner) => runner.group === found.id)) return answer(422, { message: "The group has runners" });
        groups.delete(found.id);
        return answer(204);
      }
    }
    return answer(404, { message: "Not Found" });
  };
  return { transport, sent, runners, groups, used: (): number => used };
};
