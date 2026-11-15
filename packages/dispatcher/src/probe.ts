/**
 * The probe of a real credential. It sends the requests of the dispatcher to GitHub with one token, and it measures four facts:
 *
 * - The permissions of each request, from the header `x-accepted-github-permissions`.
 * - The cost of an answer 304 for the primary limit of the rate.
 * - The labels of a one-job runner. The probe makes the runner and removes it at once.
 * - The runner groups of an organization, and a probe group with the visibility `selected`.
 *
 * The probe uses the REST client of `@procedures/gh`, as the program does. The record `github-probe/1` has no token
 * and no one-job configuration.
 */
import { isRepositoryName } from "@mark1russell7/runner-dispatch";
import { isOrganizationName, judgeRunnerGroup, type RunnerGroupCheck } from "@mark1russell7/runner-dispatch/github";
import type { Clock } from "@mark1russell7/service";
import { redactSecrets } from "@mark1russell7/text/redact";
import { createRestClient, type RestClient, type RestMethod, type RestReply, type RestTransport } from "@procedures/gh";

/** This constant is the format of the record of a probe. */
export const PROBE_FORMAT = "github-probe/1";

/** This constant is the default count of the conditional requests of the measure of an answer 304. */
export const PROBE_TRIES = 5;

/** This constant is the smallest count of the conditional requests of one probe. One request cannot show the requests of another client. */
export const PROBE_TRIES_MIN = 2;

/** This constant is the largest count of the conditional requests of one probe. */
export const PROBE_TRIES_MAX = 50;

/**
 * This constant is the most rounds of the measure of an answer 304. The primary limit of a token is the limit of its user.
 * Thus each other client of the user adds noise, and the probe repeats a round with noise.
 */
export const PROBE_ROUNDS = 3;

/** This text is the error of a probe when GitHub refuses the token with an answer 401. */
export const PROBE_TOKEN_REFUSED =
  "GitHub refused the token with an answer 401. The token is not valid, it expired, or the organization did not approve it. The probe made no runner and no group.";

/** This constant is the longest time of one request that removes a runner or a group, in milliseconds. A stop of the probe does not stop it. */
export const CLEANUP_MS = 30_000;

/** This constant is the start of the names of the runner and the group of a probe. */
export const PROBE_PREFIX = "runner-dispatch-probe";

/** This constant is the default label of the one-job runner of a probe. No job names it. */
export const PROBE_LABEL = "runner-dispatch-probe";

/** This record has the settings of a probe. */
export interface ProbeSettings {
  /** This field is the repository of the probe, as `owner/name`. */
  readonly repository: string;
  /** This field is the organization of the runners. When it is `null`, the runners register on the repository. */
  readonly organization: string | null;
  /** This list has the labels of the one-job runner. */
  readonly labels: readonly string[];
  /** This field is the count of the conditional requests of the measure of an answer 304. */
  readonly tries: number;
  /** This field is `true` when the probe makes a runner group in the organization, and removes it. */
  readonly group: boolean;
}

/** This record has the ports of a probe. */
export interface ProbePorts {
  /** This field is the token. No part of the record has it. */
  readonly token: string;
  /** This field is the base URL of the REST API. */
  readonly baseUrl: string;
  /** This field is the `user-agent` header. */
  readonly userAgent: string;
  /** This function sends one exchange. */
  readonly transport: RestTransport;
  /** This function gives the suffix of the names of the runner and the group, for example 8 random hexadecimal digits. */
  readonly suffix: () => string;
  /** This function gives the time of the start of the probe, as an ISO 8601 text. */
  readonly now: () => string;
  /** This signal stops the steps of the probe. It does not stop the removal of the runner and of the group. */
  readonly signal: AbortSignal;
  /** This function gives the signal of one removal. The default ends the removal after `CLEANUP_MS`. */
  readonly cleanupSignal?: (() => AbortSignal) | undefined;
  /** This clock is for a test. The default is the clock of the platform. */
  readonly clock?: Clock | undefined;
}

/** This type is the kind of a token of GitHub, from the start of its text. */
export type TokenKind = "fine-grained" | "classic" | "oauth" | "app-installation" | "app-user" | "unknown";

/** This record is one permission of a set: its name and its level. */
export interface Permission {
  readonly name: string;
  readonly level: string;
}

/** This record is one request of a probe and the facts of its reply. It has no body. */
export interface ProbeStep {
  /** This field is the name of the step. */
  readonly step: string;
  readonly method: RestMethod;
  /** This field is the path of the request, with its query. */
  readonly path: string;
  /** This field is the status of the reply. It is `null` when the request got no reply. */
  readonly status: number | null;
  /** This field is the header `x-accepted-github-permissions`, as GitHub gives it, or `null`. */
  readonly permissions: string | null;
  /** This list has the sets of the header. Each set is sufficient for the request. */
  readonly sets: readonly (readonly Permission[])[];
  /** This field is the header `x-ratelimit-used`, or `null`. */
  readonly used: number | null;
  /** This field is the header `x-ratelimit-resource`, or `null`. */
  readonly resource: string | null;
  /** This field is the text of the error of a request with no reply, or `null`. */
  readonly problem: string | null;
}

/** This record is the measure of an answer 304. */
export interface ConditionalMeasure {
  /** This field is the count of the conditional requests. */
  readonly tries: number;
  /** This field is the count of the answers 304. */
  readonly notModified: number;
  /** This list has the counts of the used requests, in the sequence of the steps of the measure. */
  readonly used: readonly (number | null)[];
  /** This field is `true` when no other client used the token during the measure. */
  readonly clean: boolean;
  /** This field is `true` when the counts show the requests of another client. Another round can then give a read. */
  readonly noisy: boolean;
  /** This field is the count of the requests of the primary limit for one answer 304, or `null` with no read. */
  readonly cost: number | null;
  /** This field tells why the measure has no read, or it is `null`. */
  readonly reason: string | null;
}

/** This record is one runner group of an organization, as GitHub gives it, with no other field. */
export interface GroupFacts {
  readonly id: number | null;
  readonly name: string | null;
  readonly visibility: string | null;
  readonly default: boolean | null;
  readonly allowsPublicRepositories: boolean | null;
  readonly restrictedToWorkflows: boolean | null;
}

/** This record is the probe group: the group that GitHub made, and the check of the dispatcher on it. */
export interface ProbeGroup {
  /** This field is the group, as GitHub gave it after its creation, or `null` when GitHub made no group. */
  readonly made: GroupFacts | null;
  /** This field is the check of `judgeRunnerGroup` on the group and its repositories, or `null`. */
  readonly check: RunnerGroupCheck | null;
  /** This field is `true` when the runner group of the one-job runner was the probe group. */
  readonly runnerInGroup: boolean;
  /** This field is `true` when GitHub removed the group, or when GitHub made no group. */
  readonly removed: boolean;
}

/** This record is the one-job runner of a probe. */
export interface ProbeRunner {
  /** This field is `true` when GitHub made the runner. */
  readonly made: boolean;
  /** This list has each label of the runner, as GitHub gives it after the creation. */
  readonly labels: readonly { readonly name: string; readonly type: string }[];
  /** This field is `true` when GitHub removed the runner, or when GitHub made no runner. */
  readonly removed: boolean;
}

/** This record is the result of a probe. */
export interface ProbeRecord {
  readonly format: typeof PROBE_FORMAT;
  /** This field is the time of the start of the probe. */
  readonly at: string;
  readonly repository: string;
  readonly organization: string | null;
  /** This field is the kind of the token. The record has no other fact of the token. */
  readonly token: TokenKind;
  /** This field is the header `x-oauth-scopes` of a classic token, or `null`. */
  readonly scopes: string | null;
  readonly steps: readonly ProbeStep[];
  /** This field is the measure of the last round. */
  readonly conditional: ConditionalMeasure;
  /** This field is the count of the rounds of the measure, from 1 to `PROBE_ROUNDS`. */
  readonly rounds: number;
  readonly runner: ProbeRunner;
  /** This list has the runner groups of the organization, or it is `null` with no organization or no read. */
  readonly groups: readonly GroupFacts[] | null;
  /** This field is the probe group, or `null` when the probe did not make one. */
  readonly group: ProbeGroup | null;
  /** This field is `true` when the probe left no runner and no group on GitHub. */
  readonly clean: boolean;
}

/** This function gives the value of a field of an object, or `undefined`. */
const field = (value: unknown, key: string): unknown => (typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined);

/** This function gives a whole number from 1, or `null`. */
const idOf = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null);

/** This function gives a whole number from 0, or `null`. */
const countOf = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);

/** This function gives a text, or `null`. */
const textOf = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** This function gives a boolean, or `null`. */
const flagOf = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

/** This function gives the text of a thrown value. It does not throw. */
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * This function gives the kind of a token of GitHub from the start of its text. It does not keep the token.
 *
 * @param token - The token
 * @returns The kind
 */
export function tokenKind(token: string): TokenKind {
  if (token.startsWith("github_pat_")) return "fine-grained";
  if (token.startsWith("ghp_")) return "classic";
  if (token.startsWith("gho_")) return "oauth";
  if (token.startsWith("ghs_")) return "app-installation";
  if (token.startsWith("ghu_")) return "app-user";
  return "unknown";
}

/**
 * This function reads the header `x-accepted-github-permissions`. A semicolon separates two sets, and a comma separates
 * two permissions of one set. Each set is sufficient for the request. The docs of GitHub do not fix the format, thus the
 * record also keeps the text of the header.
 *
 * @param header - The text of the header
 * @returns The sets, each with its permissions
 */
export function parsePermissions(header: string): Permission[][] {
  return header
    .split(";")
    .map((set) =>
      set
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .map((part): Permission => {
          const at = part.indexOf("=");
          return at > 0 ? { name: part.slice(0, at).trim(), level: part.slice(at + 1).trim() } : { name: part, level: "" };
        }),
    )
    .filter((set) => set.length > 0);
}

/**
 * This function gives a header of a reply, with no difference between small and capital letters. Two values of one
 * header become one text with a comma.
 *
 * @param reply - The reply
 * @param name - The name of the header, in small letters
 * @returns The value, or `null`
 */
export function headerOf(reply: RestReply, name: string): string | null {
  for (const [key, value] of Object.entries(reply.headers)) {
    if (key.toLowerCase() !== name) continue;
    return typeof value === "string" ? value : value.join(", ");
  }
  return null;
}

/**
 * This function calculates the cost of an answer 304 from the counts of the used requests. It has no effect.
 * The sequence starts with two reads of the rate and the first request of the list. Then come the conditional
 * requests and a last read of the rate. A read of the rate costs nothing.
 *
 * - With no other client, the two first reads are equal, and the first request adds 1.
 * - Each conditional request adds the same count, and the last read is equal to the last conditional request.
 * - Else the measure is not clean, and it has no read. The probe does not guess the requests of the other clients.
 * - Thus the requests of another client in one gap of the sequence give no read, and not a wrong cost.
 *
 * @param used - The counts of the used requests of the steps of the measure
 * @param statuses - The statuses of the conditional requests
 * @returns The measure
 */
export function conditionalCost(used: readonly (number | null)[], statuses: readonly (number | null)[]): ConditionalMeasure {
  const tries = statuses.length;
  const notModified = statuses.filter((status) => status === 304).length;
  const base = { tries, notModified, used: [...used] };
  const none = (reason: string, noisy = false): ConditionalMeasure => ({ ...base, clean: false, noisy, cost: null, reason });
  if (tries < PROBE_TRIES_MIN) return none(`The measure needs ${PROBE_TRIES_MIN} conditional requests or more.`);
  if (used.length !== tries + 4 || used.some((count) => count === null)) return none("A step of the measure has no count of the used requests.");
  const [before, again, first] = used as [number, number, number];
  const last = used[used.length - 2] as number;
  const after = used[used.length - 1] as number;
  if (notModified !== tries) return none("GitHub did not answer each conditional request with the status 304.");
  if (before !== again) return none("The count changed between two reads of the rate: another client used the token.", true);
  if (first !== again + 1) return none("The first request did not add 1 to the count: another client used the token.", true);
  if (after !== last) return none("The count changed after the last conditional request: another client used the token.", true);
  const counts = used.slice(2, used.length - 1) as number[];
  const added = counts.slice(1).map((count, index) => count - (counts[index] as number));
  const cost = added[0] as number;
  if (added.some((each) => each !== cost) || cost < 0) return none("The conditional requests added different counts: another client used the token.", true);
  return { ...base, clean: true, noisy: false, cost, reason: null };
}

/** This function gives the facts of a runner group, as GitHub gives it. */
export function groupFacts(value: unknown): GroupFacts {
  return {
    id: idOf(field(value, "id")),
    name: textOf(field(value, "name")),
    visibility: textOf(field(value, "visibility")),
    default: flagOf(field(value, "default")),
    allowsPublicRepositories: flagOf(field(value, "allows_public_repositories")),
    restrictedToWorkflows: flagOf(field(value, "restricted_to_workflows")),
  };
}

/** This function gives the labels of a runner, as GitHub gives them. */
const labelsOf = (runner: unknown): { name: string; type: string }[] => {
  const labels = field(runner, "labels");
  if (!Array.isArray(labels)) return [];
  return labels.flatMap((label) => {
    const name = textOf(field(label, "name"));
    return name === null ? [] : [{ name, type: textOf(field(label, "type")) ?? "" }];
  });
};

/** This pattern is a label of a runner: no space, no comma and at most 100 characters. */
const LABEL = /^[^\s,]{1,100}$/;

/**
 * This function examines the settings of a probe. It has no effect.
 *
 * @param settings - The settings
 * @returns Each problem, as one sentence. The list is empty for valid settings.
 */
export function settingsProblems(settings: ProbeSettings): string[] {
  const problems: string[] = [];
  if (!isRepositoryName(settings.repository)) problems.push(`The repository ${JSON.stringify(settings.repository)} is not a name as owner/name.`);
  if (settings.organization !== null && !isOrganizationName(settings.organization)) {
    problems.push(`The organization ${JSON.stringify(settings.organization)} is not a name of GitHub.`);
  }
  if (settings.organization !== null && isRepositoryName(settings.repository)) {
    const owner = settings.repository.slice(0, settings.repository.indexOf("/"));
    if (owner.toLowerCase() !== settings.organization.toLowerCase()) problems.push("The repository is not a repository of the organization.");
  }
  if (settings.labels.length === 0) problems.push("The one-job runner has no label.");
  for (const label of settings.labels) if (!LABEL.test(label)) problems.push(`The label ${JSON.stringify(label)} has a space, a comma or more than 100 characters.`);
  if (!Number.isSafeInteger(settings.tries) || settings.tries < PROBE_TRIES_MIN || settings.tries > PROBE_TRIES_MAX) {
    problems.push(`The count of the conditional requests is not a whole number from ${PROBE_TRIES_MIN} to ${PROBE_TRIES_MAX}.`);
  }
  if (settings.group && settings.organization === null) problems.push("A probe group needs an organization.");
  return problems;
}

/** This record is one sent step: its record and the body of the answer. The body stays out of the record. */
interface Sent {
  readonly step: ProbeStep;
  readonly body: unknown;
}

/**
 * This function makes a probe with a real credential. Its requests are the requests of the dispatcher.
 *
 * 1. Two reads of the rate, a list of runs, the same list again with its `ETag` `tries` times, and a read of the rate.
 * 2. The repository, the newest run and its jobs, and the runners of the scope.
 * 3. With an organization: its runner groups. With `group`: a probe group with the visibility `selected` and the repository.
 * 4. A one-job runner with the labels, in the probe group or in the default group 1. The probe reads it and removes it.
 * 5. The probe removes the probe group.
 *
 * No other request of the probe comes between the steps of the measure. A round with the requests of another client
 * gives no read, thus the probe repeats it, at most `PROBE_ROUNDS` times. Each round has a new client with no stored answer.
 *
 * The probe keeps only the id of the runner from the answer of the creation, thus the record has no one-job configuration.
 * A stop of the signal does not stop the two removals.
 *
 * @param settings - The repository, the organization, the labels, the tries and the probe group
 * @param ports - The token, the transport, the names and the signal
 * @returns The record of the probe
 * @throws RangeError when the settings are not valid
 * @throws Error with the text `PROBE_TOKEN_REFUSED` when GitHub answers 401 to the read of the rate, before the probe makes a runner or a group
 */
export async function probeGitHub(settings: ProbeSettings, ports: ProbePorts): Promise<ProbeRecord> {
  const problems = settingsProblems(settings);
  if (problems.length > 0) throw new RangeError(problems.join(" "));
  const at = ports.now();
  const replies: RestReply[] = [];
  const transport: RestTransport = async (exchange, signal) => {
    const reply = await ports.transport(exchange, signal);
    replies.push(reply);
    return reply;
  };
  const options = { token: ports.token, baseUrl: ports.baseUrl, userAgent: ports.userAgent, transport, ...(ports.clock === undefined ? {} : { clock: ports.clock }) };
  // The plain client stores no answer, thus each of its requests is a full request. A conditional client stores the answer with its ETag.
  const plain = createRestClient({ ...options, cacheEntries: 0 });
  const cleanupSignal = ports.cleanupSignal ?? ((): AbortSignal => AbortSignal.timeout(CLEANUP_MS));
  const steps: ProbeStep[] = [];

  const send = async (
    client: RestClient,
    step: string,
    method: RestMethod,
    path: string,
    query: Readonly<Record<string, string>> = {},
    body: unknown = null,
    signal: AbortSignal = ports.signal,
  ): Promise<Sent> => {
    const from = replies.length;
    const shown = Object.keys(query).length === 0 ? path : `${path}?${new URLSearchParams(Object.entries(query).sort(([a], [b]) => (a < b ? -1 : 1))).toString()}`;
    let answer: unknown = null;
    let problem: string | null = null;
    try {
      answer = (await client.request({ method, path, query, body }, signal)).body;
    } catch (error) {
      problem = redactSecrets(errorText(error), [ports.token]);
    }
    const reply = replies.length > from ? replies[replies.length - 1] : undefined;
    const permissions = reply === undefined ? null : headerOf(reply, "x-accepted-github-permissions");
    const used = reply === undefined ? null : headerOf(reply, "x-ratelimit-used");
    const record: ProbeStep = {
      step,
      method,
      path: shown,
      status: reply === undefined ? null : reply.status,
      permissions,
      sets: permissions === null ? [] : parsePermissions(permissions),
      used: used === null || !/^\d+$/.test(used.trim()) ? null : Number(used.trim()),
      resource: reply === undefined ? null : headerOf(reply, "x-ratelimit-resource"),
      problem,
    };
    steps.push(record);
    return { step: record, body: answer };
  };
  /** This function gives the count of the used requests of the primary limit from a read of the rate. */
  const rateUsed = (sent: Sent): number | null => (sent.step.status === 200 ? countOf(field(field(field(sent.body, "resources"), "core"), "used")) : null);

  const repo = `/repos/${settings.repository}`;
  const runnersAt = settings.organization === null ? `${repo}/actions/runners` : `/orgs/${settings.organization}/actions/runners`;
  const page = { per_page: "100", page: "1" };

  // 1. The measure of an answer 304: no other request of the probe comes between its steps.
  const list = { status: "queued", ...page };
  const round = async (): Promise<ConditionalMeasure> => {
    // A new client has no stored answer, thus the first request of the list of each round is a full request.
    const conditional = createRestClient(options);
    const before = await send(plain, "rate", "GET", "/rate_limit");
    // An answer 401 refuses the token itself, so no request after it measures a fact. No runner and no group exist yet.
    if (before.step.status === 401) throw new Error(PROBE_TOKEN_REFUSED);
    const again = await send(plain, "rate-again", "GET", "/rate_limit");
    const first = await send(conditional, "runs", "GET", `${repo}/actions/runs`, list);
    const tries: Sent[] = [];
    for (let index = 0; index < settings.tries; index += 1) tries.push(await send(conditional, "runs-conditional", "GET", `${repo}/actions/runs`, list));
    const after = await send(plain, "rate-after", "GET", "/rate_limit");
    return conditionalCost(
      [rateUsed(before), rateUsed(again), first.step.used, ...tries.map((each) => each.step.used), rateUsed(after)],
      tries.map((each) => each.step.status),
    );
  };
  let measure = await round();
  let rounds = 1;
  while (measure.noisy && rounds < PROBE_ROUNDS) {
    measure = await round();
    rounds += 1;
  }

  // 2. The repository, the newest run, its jobs, and the runners of the scope.
  const repository = await send(plain, "repository", "GET", repo);
  const repositoryId = repository.step.status === 200 ? idOf(field(repository.body, "id")) : null;
  const newest = await send(plain, "runs-newest", "GET", `${repo}/actions/runs`, { per_page: "1" });
  const run = field(newest.body, "workflow_runs");
  const runId = Array.isArray(run) ? idOf(field(run[0], "id")) : null;
  const attempt = Array.isArray(run) ? idOf(field(run[0], "run_attempt")) : null;
  if (runId !== null && attempt !== null) {
    await send(plain, "run", "GET", `${repo}/actions/runs/${runId}`);
    await send(plain, "jobs", "GET", `${repo}/actions/runs/${runId}/attempts/${attempt}/jobs`, page);
  }
  await send(plain, "runners", "GET", runnersAt, page);

  // 3. The runner groups of the organization, and the probe group.
  let groups: GroupFacts[] | null = null;
  let group: ProbeGroup | null = null;
  let groupId: number | null = null;
  const organizationAt = settings.organization === null ? null : `/orgs/${settings.organization}/actions/runner-groups`;
  if (organizationAt !== null) {
    const listed = await send(plain, "runner-groups", "GET", organizationAt, page);
    const items = field(listed.body, "runner_groups");
    groups = listed.step.status === 200 && Array.isArray(items) ? items.map(groupFacts) : null;
    if (settings.group && repositoryId !== null) {
      const made = await send(plain, "group-make", "POST", organizationAt, {}, {
        name: `${PROBE_PREFIX}-${ports.suffix()}`,
        visibility: "selected",
        selected_repository_ids: [repositoryId],
        allows_public_repositories: false,
      });
      groupId = made.step.status === 201 ? idOf(field(made.body, "id")) : null;
      group = { made: groupId === null ? null : groupFacts(made.body), check: null, runnerInGroup: false, removed: groupId === null };
    }
  }

  // 4. The one-job runner, in the probe group or in the default group. 5. The removal of the group.
  let runner: ProbeRunner = { made: false, labels: [], removed: true };
  try {
    if (organizationAt !== null && groupId !== null && group !== null) {
      const read = await send(plain, "group", "GET", `${organizationAt}/${groupId}`);
      const named = await send(plain, "group-repositories", "GET", `${organizationAt}/${groupId}/repositories`, page);
      const items = field(named.body, "repositories");
      if (read.step.status === 200) {
        const repositories = named.step.status === 200 && Array.isArray(items) ? items : null;
        group = { ...group, made: groupFacts(read.body), check: judgeRunnerGroup({ group: read.body, repositories }, { served: [settings.repository] }) };
      }
    }
    const registered = await send(plain, "register", "POST", `${runnersAt}/generate-jitconfig`, {}, {
      name: `${PROBE_PREFIX}-${ports.suffix()}`,
      runner_group_id: groupId ?? 1,
      labels: [...settings.labels],
    });
    // The answer has the one-job configuration. The probe keeps only the id of the runner.
    const runnerId = registered.step.status === 201 ? idOf(field(field(registered.body, "runner"), "id")) : null;
    if (runnerId !== null) {
      runner = { made: true, labels: [], removed: false };
      try {
        const read = await send(plain, "runner", "GET", `${runnersAt}/${runnerId}`);
        runner = { ...runner, labels: read.step.status === 200 ? labelsOf(read.body) : [] };
        if (group !== null && groupId !== null) {
          const members = await send(plain, "group-runners", "GET", `${organizationAt as string}/${groupId}/runners`, page);
          const each = field(members.body, "runners");
          group = { ...group, runnerInGroup: Array.isArray(each) && each.some((item) => field(item, "id") === runnerId) };
        }
      } finally {
        const removed = await send(plain, "runner-remove", "DELETE", `${runnersAt}/${runnerId}`, {}, null, cleanupSignal());
        runner = { ...runner, removed: removed.step.status === 204 || removed.step.status === 404 };
      }
    }
  } finally {
    if (organizationAt !== null && groupId !== null && group !== null) {
      const removed = await send(plain, "group-remove", "DELETE", `${organizationAt}/${groupId}`, {}, null, cleanupSignal());
      group = { ...group, removed: removed.step.status === 204 || removed.step.status === 404 };
    }
  }

  const scopes = replies.map((reply) => headerOf(reply, "x-oauth-scopes")).find((value) => value !== null) ?? null;
  return {
    format: PROBE_FORMAT,
    at,
    repository: settings.repository,
    organization: settings.organization,
    token: tokenKind(ports.token),
    scopes,
    steps,
    conditional: measure,
    rounds,
    runner,
    groups,
    group,
    clean: runner.removed && (group === null || group.removed),
  };
}
