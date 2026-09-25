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
import { isAddress, type Address } from "viem";
import { z } from "zod";
import { KINDS, MODE_NAMES, publicSpec } from "../job.ts";
import { checkFilePath, gitPath, jobPath, notesPath, ROUTES } from "../routes.ts";
import { SEATS } from "../seal.ts";
import type { JobStore } from "../store.ts";
import type { Doorkeeper } from "./Doorkeeper.ts";

/** Raised only when the shape changes in a way an agent reading the old one would misread */
export const JOB_LIST_VERSION = 1;

const AddressSchema = z.string().refine((value): value is Address => isAddress(value), "an address");
/** Money travels as whole numbers of wei, in strings, because JSON has no integers that large */
const WeiSchema = z.string().regex(/^[0-9]+$/, "a whole number of wei");

/**
 * The list's shape, as a schema: the server writes it, and an agent reads it through this rather
 * than trusting it, which is what the reference agent does.
 */
export const ListedSeatSchema = z.object({
  role: z.enum(SEATS),
  pay: WeiSchema,
  /** what taking it puts down, returned whether the work passes or not */
  deposit: WeiSchema,
  /** who holds it, or nothing if it is free */
  heldBy: z.object({ agent: AddressSchema, owner: AddressSchema }).optional(),
});

export const ListedJobSchema = z.object({
  jobId: z.string(),
  /** where things are, as paths on this server */
  at: z.object({ page: z.string(), git: z.string(), notes: z.string() }),
  /** the contract to take a seat on, and the job's number there. The chain itself is at `market` */
  contract: z.object({ address: AddressSchema, jobId: z.string().regex(/^[0-9]+$/) }),
  price: WeiSchema,
  endsAt: z.string(),
  idea: z.string(),
  kind: z.enum(KINDS).optional(),
  mode: z.enum(MODE_NAMES),
  /** the hosts the work may reach, and why. Anything else is refused when it runs */
  allowedHosts: z.array(z.object({ host: z.string(), why: z.string() })),
  /** the checks the pod builds against, with where to fetch each one */
  visibleChecks: z.array(z.object({ says: z.string(), run: z.string(), file: z.string().optional(), url: z.string().optional() })),
  /** how many checks are sealed until the verdict. Counted, never shown */
  sealedChecks: z.number().int().nonnegative(),
  seats: z.array(ListedSeatSchema),
  /** the owners already in the pod. One owner to a job, so an owner here has nothing left to take */
  owners: z.array(AddressSchema),
  /** the roles that still have a free seat. The contract pays nobody until every one is filled */
  free: z.array(z.enum(SEATS)),
});

export const JobListingSchema = z.object({
  version: z.literal(JOB_LIST_VERSION),
  /** everything an agent does on its side, in words: read it first */
  guide: z.string(),
  /** where to read the chain, the contract and the coin from */
  market: z.string(),
  jobs: z.array(ListedJobSchema),
});

export type ListedSeat = z.infer<typeof ListedSeatSchema>;
export type ListedJob = z.infer<typeof ListedJobSchema>;
export type JobListing = z.infer<typeof JobListingSchema>;

/**
 * How long the list, read from the chain, is served before it is read again. Anybody may ask for it,
 * and each reading is several reads of the chain for every job, so a flood of asking is a flood of
 * paid reads without this; a seat taken a moment ago shows a moment later.
 */
export const LIST_FRESH_FOR_MS = 2_000;

export class JobList {
  private kept?: { readonly at: number; readonly listing: Promise<JobListing> };

  constructor(private readonly options: { readonly keeper: Doorkeeper; readonly store: JobStore }) {}

  async handle(): Promise<Response> {
    return Response.json(await this.fresh(), { headers: { "cache-control": "no-store" } });
  }

  private fresh(): Promise<JobListing> {
    if (this.kept && Date.now() - this.kept.at < LIST_FRESH_FOR_MS) return this.kept.listing;
    const listing = this.listing();
    this.kept = { at: Date.now(), listing };
    // a reading that failed is not kept: the next ask reads again
    listing.catch(() => { this.kept = undefined; });
    return listing;
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
        allowedHosts: shown.allowed.map((allowed) => ({ host: allowed.host, why: allowed.why })),
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
    return { version: JOB_LIST_VERSION, guide: ROUTES.guide, market: ROUTES.market, jobs: listed };
  }
}
