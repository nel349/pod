/**
 * The git door: each job's repository, over git's ordinary protocol, for the agents seated on it.
 *
 * Agents clone, fetch and push with plain git. What the door adds is who may, decided the way every
 * write here is decided: a signature, never a session, checked against the chain rather than against
 * anything we hold. Who a seat is, is the doorkeeper's; what a seat may do with git is this.
 *
 *   read    any seat on the job reads every branch of that job, and nothing of any other job
 *   write   a seat writes its own branch, while the job's window is open, a few times a minute and
 *           never more than a push should weigh. What a push may change is decided inside git, in
 *           preReceive.ts, before anything moves
 *
 * The main branch is written by the worker alone, with work that passed, and never through here.
 * The hidden checks are never in a repository at all, so no branch can leak them.
 */
import { openRepository } from "../repo.ts";
import { ROUTES } from "../routes.ts";
import { gitHttpBackend } from "./backend.ts";
import { PerMinute, type Answer, type Doorkeeper } from "./Doorkeeper.ts";
import { agentEmail, branchFor } from "./seat.ts";

export interface GitDoorOptions {
  /** the folder every job's repository lives in, one bare repository per job */
  readonly repositories: string;
  readonly keeper: Doorkeeper;
  readonly limits?: PushLimits;
}

export interface PushLimits {
  /** bytes */
  readonly mostAPushMayWeigh: number;
  readonly pushesASeatMayMakeAMinute: number;
}

/** What one push may weigh. A pod's work is source, and a push heavier than this is filling a disk */
export const MOST_A_PUSH_MAY_WEIGH = 50 * 1024 * 1024;
/** How many pushes one seat may make in a minute. Plenty for work, too few to hammer the door */
export const PUSHES_A_SEAT_MAY_MAKE_A_MINUTE = 20;
const LIMITS: PushLimits = { mostAPushMayWeigh: MOST_A_PUSH_MAY_WEIGH, pushesASeatMayMakeAMinute: PUSHES_A_SEAT_MAY_MAKE_A_MINUTE };

const HOOKS = new URL("./hooks", import.meta.url).pathname;
const PRE_RECEIVE = new URL("./preReceive.ts", import.meta.url).pathname;

type Service = "git-upload-pack" | "git-receive-pack";
const SERVICES: readonly Service[] = ["git-upload-pack", "git-receive-pack"];
const isService = (name: string | null): name is Service => SERVICES.includes(name as Service);

/** `/git/<job>.git/<what git asked for>` */
const DOOR_PATH = /^([^/]+)\.git\/(.+)$/;

export class GitDoor {
  private readonly limits: PushLimits;
  private readonly pushes: PerMinute;

  constructor(private readonly options: GitDoorOptions) {
    this.limits = options.limits ?? LIMITS;
    this.pushes = new PerMinute(this.limits.pushesASeatMayMakeAMinute);
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const matched = DOOR_PATH.exec(url.pathname.slice(ROUTES.git.length));
    const asked = matched?.[2] ?? "";
    const service = serviceOf(request.method, asked, url.searchParams.get("service"));
    if (!service) return said(404, "this door speaks git's own protocol for clone, fetch and push, and nothing else");

    const { keeper } = this.options;
    const job = await keeper.job(matched?.[1] ?? "");
    if (!job.ok) return refusal(job);
    const admitted = await keeper.admit(request, job.value);
    if (!admitted.ok) return refusal(admitted);
    const { jobId, onChainId, statement } = admitted.value;

    if (service === "git-receive-pack") {
      const closed = await keeper.closed(onChainId);
      if (closed) return said(403, closed);
      // counted on the first of a push's two requests, which asks what is there: every push makes
      // exactly one, and git shows the agent a refusal given there, where one given to the second
      // request reaches it only as a status code
      if (request.method === "GET" && !this.pushes.allow(`${jobId}:${statement.agent.toLowerCase()}`)) {
        return said(429, `a seat may push ${this.limits.pushesASeatMayMakeAMinute} times a minute. Wait a moment and push again`);
      }
    }

    await openRepository(this.options.repositories, jobId);
    return gitHttpBackend({
      request,
      projectRoot: this.options.repositories,
      pathInfo: `/${jobId}.git/${asked}`,
      remoteUser: statement.agent.toLowerCase(),
      env: {
        ...gitSettings({
          "core.hooksPath": HOOKS,
          "http.receivepack": "true",
          "receive.denyNonFastForwards": "true",
          "receive.denyDeletes": "true",
          "receive.maxInputSize": String(this.limits.mostAPushMayWeigh),
        }),
        POD_BUN: process.execPath,
        POD_PRE_RECEIVE: PRE_RECEIVE,
        POD_BRANCH: branchFor(statement.role, statement.agent),
        POD_EMAIL: agentEmail(statement.agent),
      },
    });
  }
}

const TEXT = { "content-type": "text/plain; charset=utf-8" } as const;

/** A plain-text answer. Git shows the agent its lines after `remote:` when it refuses what git asked first */
function said(status: number, why: string): Response {
  return new Response(`${why}\n`, { status, headers: TEXT });
}

/** The doorkeeper's refusal, as git expects it: a request with no name at all is asked for one. */
function refusal(answer: Extract<Answer<unknown>, { ok: false }>): Response {
  if (!answer.challenge) return said(answer.status, answer.why);
  return new Response(`${answer.why}\n`, { status: answer.status, headers: { ...TEXT, "www-authenticate": 'Basic realm="pod"' } });
}

/** Which of git's two services a request is for, if it is for either: listing what is there, or the exchange itself. */
function serviceOf(method: string, asked: string, named: string | null): Service | undefined {
  if (method === "GET" && asked === "info/refs" && isService(named)) return named;
  if (method === "POST" && isService(asked)) return asked;
  return undefined;
}

/** Settings for one run of git, given the way git reads them from its environment. */
function gitSettings(settings: Readonly<Record<string, string>>): Record<string, string> {
  const entries = Object.entries(settings);
  return Object.fromEntries([
    ["GIT_CONFIG_COUNT", String(entries.length)],
    ...entries.flatMap(([key, value], i) => [[`GIT_CONFIG_KEY_${i}`, key], [`GIT_CONFIG_VALUE_${i}`, value]]),
  ]);
}
