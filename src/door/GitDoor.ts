/**
 * The git door: each job's repository, over git's ordinary protocol, for the agents seated on it.
 *
 * Agents clone, fetch and push with plain git. What the door adds is who may, decided the way every
 * write here is decided: a signature, never a session, checked against the chain rather than against
 * anything we hold.
 *
 *   read    any seat on the job reads every branch of that job, and nothing of any other job
 *   write   a seat writes its own branch, while the job's window is open, a few times a minute and
 *           never more than a push should weigh. What a push may change is decided inside git, in
 *           preReceive.ts, before anything moves
 *
 * The main branch is written by the worker alone, with work that passed, and never through here.
 * The hidden checks are never in a repository at all, so no branch can leak them.
 */
import type { Address } from "viem";
import type { JobState, HeldSeat } from "../jobs.ts";
import { openRepository } from "../repo.ts";
import { isWallName, ROUTES } from "../routes.ts";
import type { JobStore } from "../store.ts";
import { gitHttpBackend } from "./backend.ts";
import { statementFrom, statementHolds, type Statement } from "./credentials.ts";
import { agentEmail, branchFor } from "./seat.ts";

/** What the door asks the chain. The contract is the only list of who sits in a pod, and the only clock for its window */
export interface DoorChain {
  readonly jobs: Address;
  job(onChainId: bigint): Promise<{ readonly endsAt: bigint; readonly state: JobState } | undefined>;
  seats(onChainId: bigint): Promise<readonly HeldSeat[]>;
  /** the time of the chain's latest block, which is the time the contract's window is measured by */
  now(): Promise<bigint>;
}

export interface GitDoorOptions {
  /** the folder every job's repository lives in, one bare repository per job */
  readonly repositories: string;
  readonly store: JobStore;
  readonly chain: DoorChain;
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
const A_MINUTE_MS = 60_000;
const LIMITS: PushLimits = { mostAPushMayWeigh: MOST_A_PUSH_MAY_WEIGH, pushesASeatMayMakeAMinute: PUSHES_A_SEAT_MAY_MAKE_A_MINUTE };

const HOOKS = new URL("./hooks", import.meta.url).pathname;
const PRE_RECEIVE = new URL("./preReceive.ts", import.meta.url).pathname;

type Service = "git-upload-pack" | "git-receive-pack";
const SERVICES: readonly Service[] = ["git-upload-pack", "git-receive-pack"];
const isService = (name: string | null): name is Service => SERVICES.includes(name as Service);

/** `/git/<job>.git/<what git asked for>` */
const DOOR_PATH = /^([^/]+)\.git\/(.+)$/;

export class GitDoor {
  /** when each seat last pushed, newest last, for the limit on how often */
  private readonly pushedAt = new Map<string, number[]>();

  private readonly limits: PushLimits;

  constructor(private readonly options: GitDoorOptions) {
    this.limits = options.limits ?? LIMITS;
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const matched = DOOR_PATH.exec(url.pathname.slice(ROUTES.git.length));
    const jobId = matched?.[1] ?? "";
    const asked = matched?.[2] ?? "";
    if (!isWallName(jobId)) return refuse(404, "there is no job at that address");

    const service = serviceOf(request.method, asked, url.searchParams.get("service"));
    if (!service) return refuse(404, "this door speaks git's own protocol for clone, fetch and push, and nothing else");

    const record = await this.options.store.read(jobId);
    if (!record?.chain) return refuse(404, `there is no job called ${jobId} with money on the chain`);
    if (record.chain.jobs.toLowerCase() !== this.options.chain.jobs.toLowerCase()) {
      return refuse(404, `${jobId} is on another contract than the one this door answers to`);
    }
    const onChainId = record.chain.jobId;

    const read = statementFrom(request.headers.get("authorization"));
    if (!read.ok) return new Response(`${read.why}\n`, { status: 401, headers: { ...TEXT, "www-authenticate": 'Basic realm="pod"' } });
    const held = await statementHolds(read.value, { jobId, onChainId, jobs: this.options.chain.jobs }, Math.floor(Date.now() / 1000));
    if (!held.ok) return refuse(403, held.why);
    const statement = held.value;

    const seated = await this.seatOf(statement, BigInt(onChainId));
    if (seated) return refuse(403, seated);

    const pushing = service === "git-receive-pack";
    if (pushing) {
      const closed = await this.closed(BigInt(onChainId));
      if (closed) return refuse(403, closed);
      // counted on the first of a push's two requests, which asks what is there: every push makes
      // exactly one, and git shows the agent a refusal given there, where one given to the second
      // request reaches it only as a status code
      if (request.method === "GET" && !this.mayPushNow(`${jobId}:${statement.agent.toLowerCase()}`)) {
        return refuse(429, `a seat may push ${this.limits.pushesASeatMayMakeAMinute} times a minute. Wait a moment and push again`);
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

  /** Why this key cannot use this seat on this job, or nothing if it holds it. */
  private async seatOf(statement: Statement, onChainId: bigint): Promise<string | undefined> {
    const mine = (await this.options.chain.seats(onChainId))
      .filter((seat) => seat.agent.toLowerCase() === statement.agent.toLowerCase());
    if (mine.some((seat) => seat.role === statement.role)) return undefined;
    if (mine.length > 0) return `that key holds the ${mine.map((seat) => seat.role).join(" and ")} seat on job ${onChainId}, not the ${statement.role} seat`;
    return `that key holds no seat on job ${onChainId}. Take one on the contract first`;
  }

  /** Why nothing more may be pushed to this job, or nothing if its window is open. */
  private async closed(onChainId: bigint): Promise<string | undefined> {
    const job = await this.options.chain.job(onChainId);
    if (!job) return `there is no job ${onChainId} on the contract`;
    if (job.state === "settled" || job.state === "refunded") return `job ${onChainId} is ${job.state}: nothing more can be pushed to it`;
    if ((await this.options.chain.now()) >= job.endsAt) {
      return `job ${onChainId}'s window closed at ${new Date(Number(job.endsAt) * 1000).toISOString()}: nothing more can be pushed to it`;
    }
    return undefined;
  }

  private mayPushNow(seat: string): boolean {
    const now = Date.now();
    const recent = (this.pushedAt.get(seat) ?? []).filter((at) => now - at < A_MINUTE_MS);
    if (recent.length >= this.limits.pushesASeatMayMakeAMinute) {
      this.pushedAt.set(seat, recent);
      return false;
    }
    this.pushedAt.set(seat, [...recent, now]);
    return true;
  }
}

const TEXT = { "content-type": "text/plain; charset=utf-8" } as const;

/** A refusal git shows the agent: it prints a plain-text answer's lines after `remote:` */
function refuse(status: number, why: string): Response {
  return new Response(`${why}\n`, { status, headers: TEXT });
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

/** The contract, read the way the door needs it. */
export function doorChainFor(input: {
  readonly jobs: Address;
  readonly readJob: (onChainId: bigint) => Promise<{ readonly poster: Address; readonly endsAt: bigint; readonly state: JobState }>;
  readonly readSeats: (onChainId: bigint) => Promise<readonly HeldSeat[]>;
  readonly latestBlockTime: () => Promise<bigint>;
}): DoorChain {
  return {
    jobs: input.jobs,
    async job(onChainId) {
      const found = await input.readJob(onChainId);
      // the contract answers zeroes for a job that was never posted, rather than refusing
      return /^0x0{40}$/i.test(found.poster) ? undefined : found;
    },
    seats: input.readSeats,
    now: input.latestBlockTime,
  };
}
