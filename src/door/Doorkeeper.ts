/**
 * Who may come in, for every door an agent uses: the git door and the notes.
 *
 * One answer, from one place: a job is one that has money on this contract, a seat is one the
 * contract says the key holds, and a job's window is the one the contract measures by the chain's
 * own clock. The doors differ in what they let a seat do once it is in, not in who a seat is.
 *
 * A seat signs for itself, or a key its wallet granted signs for it: an agent working under a
 * mandate was never handed the seat's key. Which keys a wallet granted is the chain's answer too,
 * read from the session key plugin.
 */
import { isAddressEqual, type Address } from "viem";
import type { HeldSeat, JobState } from "../jobs.ts";
import type { Role } from "../job.ts";
import { isWallName } from "../routes.ts";
import type { JobRecord, JobStore } from "../store.ts";
import type { Grants } from "../mandate.ts";
import { mayActAs, notTheSeatsKey, signatureOn, statementFrom, type Checked, type SignedWords, type Statement } from "./credentials.ts";
import { secondsNow } from "../clock.ts";

/** What the doors ask the chain. The contract is the only list of who sits in a pod, and the only clock for its window */
export interface DoorChain {
  readonly jobs: Address;
  /** which chain it is on, which a structured statement names so one deployment's cannot open another */
  readonly chainId: number;
  job(onChainId: bigint): Promise<ChainJob | undefined>;
  /**
   * Who holds each seat. A copy read a moment ago may be used; asked `afresh`, the chain is read again,
   * unless it was read just now, for a key the copy does not show seated.
   */
  seats(onChainId: bigint, afresh?: boolean): Promise<readonly HeldSeat[]>;
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

/** A job the doors answer for: on the wall, and with its money on one of the contracts the doors read. */
export interface DoorJob {
  readonly jobId: string;
  readonly onChainId: bigint;
  readonly record: JobRecord;
  /** the contract its money is on, read the way the doors need it */
  readonly chain: DoorChain;
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

/** How a refusal at the git door names a statement nobody who may act signed */
const OVER_THE_STATEMENT: SignedWords = { whose: "the address in the name", over: "over the statement for this job and this seat" };

export class Doorkeeper {
  /**
   * `chain` is the contract jobs are taken on now; `earlier` are contracts whose jobs are still on the
   * wall, so their seats keep their notes and their repositories after the switch to a newer one.
   */
  constructor(private readonly options: {
    readonly store: JobStore;
    readonly chain: DoorChain;
    readonly earlier?: readonly DoorChain[];
    /** what a wallet granted, read from the chain; without it only a seat's own key is let in */
    readonly grants?: Grants;
  }) {}

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
    const on = record.chain.jobs;
    const chain = [this.options.chain, ...(this.options.earlier ?? [])].find((known) => isAddressEqual(known.jobs, on));
    if (!chain) return refused(404, `${jobId} is on another contract than the ones this door answers to`);
    return { ok: true, value: { jobId, onChainId: BigInt(record.chain.jobId), record, chain } };
  }

  /** The seat asking, from the signed statement in its request, if it holds that seat on this job. */
  async admit(request: Request, job: DoorJob): Promise<Answer<Admitted>> {
    const read = statementFrom(request.headers.get("authorization"));
    if (!read.ok) return refused(401, read.why, true);
    const statement = read.value;
    const about = { jobId: job.jobId, onChainId: String(job.onChainId), jobs: job.chain.jobs, chainId: job.chain.chainId };
    const signed = await signatureOn(statement, about, secondsNow());
    if (!signed.ok) return refused(403, signed.why);
    const acting = await this.mayAct(signed.value, statement.agent, job, OVER_THE_STATEMENT);
    if (!acting.ok) return refused(403, acting.why);
    const notSeated = await this.notSeated(statement.agent, statement.role, job);
    if (notSeated) return refused(403, notSeated);
    return { ok: true, value: { ...job, statement } };
  }

  /**
   * Whether this signature may act as this seat: the seat's own key, as ever, or a key the seat's
   * wallet granted. The plugin is asked only for a seat the contract shows taken, so a knock with a
   * made-up key is refused without reading the chain at all.
   */
  async mayAct(signer: Address, agent: Address, job: DoorJob, words: SignedWords): Promise<Checked<Address>> {
    if (isAddressEqual(signer, agent)) return { ok: true, value: signer };
    const { grants } = this.options;
    if (!grants || (await this.seatsOf(agent, job)).length === 0) return { ok: false, why: notTheSeatsKey(words) };
    return mayActAs({ signer, agent, nowSeconds: secondsNow(), grants, words });
  }

  /** Why this key cannot act as this seat on this job, or nothing if it holds it. */
  async notSeated(agent: Address, role: Role, job: DoorJob): Promise<string | undefined> {
    const mine = await this.seatsOf(agent, job, role);
    if (mine.some((seat) => seat.role === role)) return undefined;
    if (mine.length > 0) return `that key holds the ${mine.map((seat) => seat.role).join(" and ")} seat on job ${job.onChainId}, not the ${role} seat`;
    return `that key holds no seat on job ${job.onChainId}. Take one on the contract first`;
  }

  /** Which seats this address holds on this job, read from the chain; `role` is the seat it asked about. */
  private async seatsOf(agent: Address, job: DoorJob, role?: Role): Promise<readonly HeldSeat[]> {
    const heldBy = async (afresh: boolean): Promise<readonly HeldSeat[]> =>
      (await job.chain.seats(job.onChainId, afresh)).filter((seat) => isAddressEqual(seat.agent, agent));
    // seats are only ever added: a key the copy shows seated is seated, and one it does not may have
    // taken its seat a moment ago, so the chain is asked again before it is refused
    const mine = await heldBy(false);
    const shows = role === undefined ? mine.length > 0 : mine.some((seat) => seat.role === role);
    return shows ? mine : heldBy(true);
  }

  /** Why nothing more may be added to this job, or nothing if its window is open. */
  async closed(doorJob: DoorJob): Promise<string | undefined> {
    const { onChainId } = doorJob;
    const job = await doorJob.chain.job(onChainId);
    if (!job) return `there is no job ${onChainId} on the contract`;
    if (job.state === "settled" || job.state === "refunded") return `job ${onChainId} is ${job.state}: nothing more can be added to it`;
    if ((await doorJob.chain.now()) >= job.endsAt) {
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
    const recent = this.recent(seat);
    const allowed = recent.length < this.most;
    this.times.set(seat, allowed ? [...recent, Date.now()] : recent);
    return allowed;
  }

  /** Whether this seat could do it now, without counting it. */
  wouldAllow(seat: string): boolean {
    return this.recent(seat).length < this.most;
  }

  private recent(seat: string): number[] {
    const now = Date.now();
    return (this.times.get(seat) ?? []).filter((at) => now - at < A_MINUTE_MS);
  }
}

const A_MINUTE_MS = 60_000;

/**
 * How long a job's seats, read from the chain, are used before they are read again. Anybody can make
 * up a key and knock, so without this every knock would be a paid read of the chain; seats are only
 * ever added, so a copy this old can at worst keep a seat taken a moment ago waiting that moment.
 */
export const SEATS_FRESH_FOR_MS = 2_000;

/**
 * How soon after a read the seats may be read again for a key not shown seated. A key taking its seat
 * is let in at once; made-up keys knocking cost at most two reads a second.
 */
export const SEATS_RECHECK_MS = 500;

/** The contract, read the way the doors need it. */
export function doorChainFor(input: {
  readonly jobs: Address;
  readonly chainId: number;
  readonly readJob: (onChainId: bigint) => Promise<ChainJob & { readonly poster: Address }>;
  readonly readSeats: (onChainId: bigint) => Promise<readonly HeldSeat[]>;
  readonly readTerms: DoorChain["terms"];
  readonly latestBlockTime: () => Promise<bigint>;
}): DoorChain {
  const seatsRead = new Map<bigint, { readonly at: number; readonly seats: Promise<readonly HeldSeat[]> }>();
  return {
    jobs: input.jobs,
    chainId: input.chainId,
    async job(onChainId) {
      const found = await input.readJob(onChainId);
      // the contract answers zeroes for a job that was never posted, rather than refusing
      return /^0x0{40}$/i.test(found.poster) ? undefined : found;
    },
    seats(onChainId, afresh = false) {
      const kept = seatsRead.get(onChainId);
      if (kept && Date.now() - kept.at < (afresh ? SEATS_RECHECK_MS : SEATS_FRESH_FOR_MS)) return kept.seats;
      const seats = input.readSeats(onChainId);
      seatsRead.set(onChainId, { at: Date.now(), seats });
      // a read that failed is not kept: the next knock reads again
      seats.catch(() => seatsRead.delete(onChainId));
      return seats;
    },
    terms: input.readTerms,
    now: input.latestBlockTime,
  };
}
