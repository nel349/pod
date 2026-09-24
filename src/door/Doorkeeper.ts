/**
 * Who may come in, for every door an agent uses: the git door and the notes.
 *
 * One answer, from one place: a job is one that has money on this contract, a seat is one the
 * contract says the key holds, and a job's window is the one the contract measures by the chain's
 * own clock. The doors differ in what they let a seat do once it is in, not in who a seat is.
 */
import type { Address } from "viem";
import type { HeldSeat, JobState } from "../jobs.ts";
import type { Role } from "../job.ts";
import { isWallName } from "../routes.ts";
import type { JobRecord, JobStore } from "../store.ts";
import { statementFrom, statementHolds, type Statement } from "./credentials.ts";

/** What the doors ask the chain. The contract is the only list of who sits in a pod, and the only clock for its window */
export interface DoorChain {
  readonly jobs: Address;
  job(onChainId: bigint): Promise<ChainJob | undefined>;
  seats(onChainId: bigint): Promise<readonly HeldSeat[]>;
  /** what each seat pays and costs to take */
  terms(onChainId: bigint): Promise<Readonly<Record<Role, { readonly pay: bigint; readonly deposit: bigint }>>>;
  /** the time of the chain's latest block, which is the time the contract's window is measured by */
  now(): Promise<bigint>;
}

/** A job as the contract holds it, as much of it as the doors need. */
export interface ChainJob {
  readonly price: bigint;
  readonly endsAt: bigint;
  readonly state: JobState;
  /** how many reviewer seats it has; every other role has one */
  readonly reviewers: number;
}

/** A job the doors answer for: on the wall, and with its money on this contract. */
export interface DoorJob {
  readonly jobId: string;
  readonly onChainId: bigint;
  readonly record: JobRecord;
}

/** A seat that proved itself at the door, on the job it asked about. */
export interface Admitted extends DoorJob {
  readonly statement: Statement;
}

/**
 * Either what was asked for, or a refusal with its status and its reason. `challenge` means nobody
 * said who they were at all, which is the one refusal that asks the client to try again with a name.
 */
export type Answer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: number; readonly why: string; readonly challenge?: boolean };

const refused = (status: number, why: string, challenge = false): Answer<never> => ({ ok: false, status, why, challenge });

export class Doorkeeper {
  constructor(private readonly options: { readonly store: JobStore; readonly chain: DoorChain }) {}

  get jobs(): Address {
    return this.options.chain.jobs;
  }

  /** The chain as the doors read it, for a door that shows more of it than who may come in. */
  get chain(): DoorChain {
    return this.options.chain;
  }

  /** The job at this name, if it is one the doors answer for. */
  async job(jobId: string): Promise<Answer<DoorJob>> {
    if (!isWallName(jobId)) return refused(404, "there is no job at that address");
    const record = await this.options.store.read(jobId);
    if (!record?.chain) return refused(404, `there is no job called ${jobId} with money on the chain`);
    if (record.chain.jobs.toLowerCase() !== this.jobs.toLowerCase()) {
      return refused(404, `${jobId} is on another contract than the one this door answers to`);
    }
    return { ok: true, value: { jobId, onChainId: BigInt(record.chain.jobId), record } };
  }

  /** The seat asking, from the signed statement in its request, if it holds that seat on this job. */
  async admit(request: Request, job: DoorJob): Promise<Answer<Admitted>> {
    const read = statementFrom(request.headers.get("authorization"));
    if (!read.ok) return refused(401, read.why, true);
    const about = { jobId: job.jobId, onChainId: String(job.onChainId), jobs: this.jobs };
    const held = await statementHolds(read.value, about, Math.floor(Date.now() / 1000));
    if (!held.ok) return refused(403, held.why);
    const notSeated = await this.notSeated(held.value.agent, held.value.role, job.onChainId);
    if (notSeated) return refused(403, notSeated);
    return { ok: true, value: { ...job, statement: held.value } };
  }

  /** Why this key cannot act as this seat on this job, or nothing if it holds it. */
  async notSeated(agent: Address, role: Role, onChainId: bigint): Promise<string | undefined> {
    const mine = (await this.options.chain.seats(onChainId)).filter((seat) => seat.agent.toLowerCase() === agent.toLowerCase());
    if (mine.some((seat) => seat.role === role)) return undefined;
    if (mine.length > 0) return `that key holds the ${mine.map((seat) => seat.role).join(" and ")} seat on job ${onChainId}, not the ${role} seat`;
    return `that key holds no seat on job ${onChainId}. Take one on the contract first`;
  }

  /** Why nothing more may be added to this job, or nothing if its window is open. */
  async closed(onChainId: bigint): Promise<string | undefined> {
    const job = await this.options.chain.job(onChainId);
    if (!job) return `there is no job ${onChainId} on the contract`;
    if (job.state === "settled" || job.state === "refunded") return `job ${onChainId} is ${job.state}: nothing more can be added to it`;
    if ((await this.options.chain.now()) >= job.endsAt) {
      return `job ${onChainId}'s window closed at ${new Date(Number(job.endsAt) * 1000).toISOString()}: nothing more can be added to it`;
    }
    return undefined;
  }
}

/** How often one seat may do something, counted over the last minute. */
export class PerMinute {
  private readonly times = new Map<string, number[]>();

  constructor(private readonly most: number) {}

  /** Whether this seat may do it now, and if so, counts it. */
  allow(seat: string): boolean {
    const now = Date.now();
    const recent = (this.times.get(seat) ?? []).filter((at) => now - at < A_MINUTE_MS);
    const allowed = recent.length < this.most;
    this.times.set(seat, allowed ? [...recent, now] : recent);
    return allowed;
  }
}

const A_MINUTE_MS = 60_000;

/** The contract, read the way the doors need it. */
export function doorChainFor(input: {
  readonly jobs: Address;
  readonly readJob: (onChainId: bigint) => Promise<ChainJob & { readonly poster: Address }>;
  readonly readSeats: (onChainId: bigint) => Promise<readonly HeldSeat[]>;
  readonly readTerms: DoorChain["terms"];
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
    terms: input.readTerms,
    now: input.latestBlockTime,
  };
}
