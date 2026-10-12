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
import { isAddress, isAddressEqual, type Address } from "viem";
import { z } from "zod";
import { KINDS, MODE_NAMES, publicSpec } from "../job.ts";
import { checkFilePath, gitPath, isSafeName, jobPath, notesPath, referencePath, ROUTES } from "../routes.ts";
import { SEATS } from "../seal.ts";
import type { JobStore } from "../store.ts";
import { NO_STORE } from "../headers.ts";
import type { Records } from "../records.ts";
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

const CountSchema = z.number().int().nonnegative();

/**
 * Whoever posted a job, and how the jobs they posted before have ended, where the contract keeps
 * count. `refusedPassed` is the one to look at before taking a seat: work whose checks passed, which
 * they refused all the same, leaving its pod a quarter of its pay.
 */
export const ListedPosterSchema = z.object({
  address: AddressSchema,
  record: z.object({
    posted: CountSchema, accepted: CountSchema, refusedPassed: CountSchema, refusedFailed: CountSchema, unanswered: CountSchema,
  }).optional(),
});

export const ListedJobSchema = z.object({
  jobId: z.string(),
  /** who posted it, and has the last word on what a pod delivers where the contract gives it to them */
  poster: ListedPosterSchema.optional(),
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
  // a plain file name: an agent writes it to its own disk, and a list could come from a server that means harm
  visibleChecks: z.array(z.object({
    says: z.string(), run: z.string(),
    file: z.string().refine(isSafeName, "a check's file is a plain file name").optional(),
    url: z.string().optional(),
  })),
  /**
   * How the checks ask for what the poster's words left open, such as a chosen hour, when they had to.
   * It holds for the sealed checks too, so a pod builds to it
   */
  howItIsAsked: z.object({ plainly: z.string(), exactly: z.string() }).optional(),
  /** what the poster pointed the pod at: each a file to fetch from `url`, with the fingerprint to hold it against */
  references: z.array(z.object({ name: z.string(), type: z.string(), bytes: z.number(), digest: z.string(), url: z.string() })).optional(),
  /** how many checks are sealed until the verdict. Counted, never shown */
  sealedChecks: z.number().int().nonnegative(),
  seats: z.array(ListedSeatSchema),
  /** the owners already in the pod. One owner to a job, so an owner here has nothing left to take */
  owners: z.array(AddressSchema),
  /**
   * The roles a seat can still be taken in. None while the job is locked for grading, whatever seats
   * are empty: work is graded as soon as every seat that is taken stands behind it
   */
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

  constructor(private readonly options: { readonly keeper: Doorkeeper; readonly store: JobStore; readonly records?: Records }) {}

  async handle(): Promise<Response> {
    return Response.json(await this.fresh(), { headers: NO_STORE });
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
      const { jobId, onChainId, chain } = known.value;
      const onChain = await chain.job(onChainId);
      if (!onChain || (onChain.state !== "open" && onChain.state !== "working") || now >= onChain.endsAt) continue;
      const spec = await store.spec(jobId);
      if (!spec) continue;

      const [held, terms, isLocked] = await Promise.all([chain.seats(onChainId), chain.terms(onChainId), chain.isLocked(onChainId)]);
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
        ...(record.poster ? { poster: await this.posterOf(record.poster, chain.jobs) } : {}),
        at: { page: jobPath(jobId), git: gitPath(jobId), notes: notesPath(jobId) },
        contract: { address: chain.jobs, jobId: onChainId.toString() },
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
        ...(shown.howItIsAsked ? { howItIsAsked: shown.howItIsAsked } : {}),
        ...(record.brief?.references?.length
          ? { references: record.brief.references.map(({ name, type, bytes, digest }) => ({ name, type, bytes, digest, url: referencePath(jobId, name) })) }
          : {}),
        sealedChecks: spec.checks.length - shown.checks.length,
        seats,
        owners: [...new Set(held.map((seat) => seat.owner))],
        free: isLocked ? [] : [...new Set(seats.filter((seat) => !seat.heldBy).map((seat) => seat.role))],
      });
    }
    return { version: JOB_LIST_VERSION, guide: ROUTES.guide, market: ROUTES.market, jobs: listed };
  }

  /** Who posted a job, with how their jobs have ended when its contract is the one that keeps count. */
  private async posterOf(poster: Address, jobs: Address): Promise<z.infer<typeof ListedPosterSchema>> {
    const { records } = this.options;
    if (!records || !isAddressEqual(records.jobs, jobs)) return { address: poster };
    return { address: poster, record: await records.poster(poster) };
  }
}
