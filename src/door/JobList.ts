/**
 * The open jobs, for programs: where an outside agent finds work.
 *
 * The same facts as the wall, in a shape a program can rely on, with a version number so the shape
 * can change later without breaking agents that already read it. Everything about money and seats
 * is read from the contract at the moment of asking, never from our own records, because the
 * contract is what an agent will be dealing with when it takes a seat.
 *
 * What it never holds: the exam. The hidden checks are counted, never shown; the pod sees them when
 * the job has a verdict, like everybody else.
 */
import type { Address } from "viem";
import type { Kind, Mode, Role } from "../job.ts";
import { publicSpec } from "../job.ts";
import { checkFilePath, gitPath, jobPath, notesPath, ROUTES } from "../routes.ts";
import { SEATS } from "../seal.ts";
import type { JobStore } from "../store.ts";
import type { Doorkeeper } from "./Doorkeeper.ts";

/** Raised only when the shape changes in a way an agent reading the old one would misread */
export const JOB_LIST_VERSION = 1;

/** Money travels as whole numbers of wei, in strings, because JSON has no integers that large */
type Wei = string;

export interface ListedSeat {
  readonly role: Role;
  readonly pay: Wei;
  /** what taking it puts down, returned whether the work passes or not */
  readonly deposit: Wei;
  /** who holds it, or nothing if it is free */
  readonly heldBy?: { readonly agent: Address; readonly owner: Address };
}

export interface ListedJob {
  readonly jobId: string;
  /** where things are, as paths on this server */
  readonly at: { readonly page: string; readonly git: string; readonly notes: string };
  /** the contract to take a seat on, and the job's number there. The chain itself is at `market` */
  readonly contract: { readonly address: Address; readonly jobId: string };
  readonly price: Wei;
  readonly endsAt: string;
  readonly idea: string;
  readonly kind?: Kind;
  readonly mode: Mode;
  /** the checks the pod builds against, with where to fetch each one */
  readonly visibleChecks: readonly { readonly says: string; readonly run: string; readonly file?: string; readonly url?: string }[];
  /** how many checks are sealed until the verdict. Counted, never shown */
  readonly sealedChecks: number;
  readonly seats: readonly ListedSeat[];
  /** the owners already in the pod. One owner to a job, so an owner here has nothing left to take */
  readonly owners: readonly Address[];
  /** the roles that still have a free seat. The contract pays nobody until every one is filled */
  readonly free: readonly Role[];
}

export interface JobListing {
  readonly version: typeof JOB_LIST_VERSION;
  /** where to read the chain, the contract and the coin from */
  readonly market: string;
  readonly jobs: readonly ListedJob[];
}

export class JobList {
  constructor(private readonly options: { readonly keeper: Doorkeeper; readonly store: JobStore }) {}

  async handle(): Promise<Response> {
    return Response.json(await this.listing(), { headers: { "cache-control": "no-store" } });
  }

  /** Every job a seat can still be taken on: posted here, with its money on this contract, and its window open. */
  async listing(): Promise<JobListing> {
    const { keeper, store } = this.options;
    const now = await keeper.chain.now();
    const listed: ListedJob[] = [];
    for (const record of await store.all()) {
      const known = await keeper.job(record.jobId);
      if (!known.ok) continue;
      const { jobId, onChainId } = known.value;
      const onChain = await keeper.chain.job(onChainId);
      if (!onChain || (onChain.state !== "open" && onChain.state !== "working") || now >= onChain.endsAt) continue;
      const spec = await store.spec(jobId);
      if (!spec) continue;

      const [held, terms] = await Promise.all([keeper.chain.seats(onChainId), keeper.chain.terms(onChainId)]);
      const seats = SEATS.flatMap((role): ListedSeat[] => {
        const capacity = role === "reviewer" ? onChain.reviewers : 1;
        const holders = held.filter((seat) => seat.role === role);
        return Array.from({ length: capacity }, (_, index) => {
          const holder = holders[index];
          return {
            role, pay: terms[role].pay.toString(), deposit: terms[role].deposit.toString(),
            ...(holder ? { heldBy: { agent: holder.agent, owner: holder.owner } } : {}),
          };
        });
      });
      const shown = publicSpec(spec);
      listed.push({
        jobId,
        at: { page: jobPath(jobId), git: gitPath(jobId), notes: notesPath(jobId) },
        contract: { address: keeper.jobs, jobId: onChainId.toString() },
        price: onChain.price.toString(),
        endsAt: new Date(Number(onChain.endsAt) * 1000).toISOString(),
        idea: shown.idea,
        ...(shown.kind ? { kind: shown.kind } : {}),
        mode: shown.mode,
        visibleChecks: shown.checks.map((check) => ({
          says: check.says, run: check.run,
          ...(check.file ? { file: check.file, url: checkFilePath(jobId, check.file) } : {}),
        })),
        sealedChecks: spec.checks.length - shown.checks.length,
        seats,
        owners: [...new Set(held.map((seat) => seat.owner))],
        free: [...new Set(seats.filter((seat) => !seat.heldBy).map((seat) => seat.role))],
      });
    }
    return { version: JOB_LIST_VERSION, market: ROUTES.market, jobs: listed };
  }
}
