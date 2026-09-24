/**
 * A stranger posts a job.
 *
 * This is the first thing in the product that lets somebody other than a reader change anything, so
 * it settles the rule for every write path after it: a signature, never a session. There are no
 * accounts here, no cookies and no passwords — nothing to steal and nothing to reset. A request that
 * changes something says who it is from and proves it, and the server checks that proof against the
 * chain rather than against anything it holds itself.
 *
 * By the time a posting reaches us the poster has already paid, from their own wallet, into the
 * contract. What they send afterwards is the spec and the check files. We accept it only when three
 * independent things agree:
 *
 *   the signature   the address that signed is the address that posted
 *   the chain       the job exists, that address posted it, with this seal and this price
 *   the files       every check file is the file whose fingerprint was sealed
 *
 * Any one of them failing is a refusal that says which, because "no" with no reason is how a real
 * person gives up on a form.
 */
import { isAddress, recoverMessageAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import { filesMatchSeal, KINDS, MODE_NAMES, sealSpec, type Spec } from "./job.ts";
import { openJob } from "./publish.ts";
import { isSafeName, isWallName } from "./routes.ts";
import type { JobRecord, JobStore } from "./store.ts";
import { SEATS } from "./seal.ts";
import { postingMessage } from "./messages.ts";

export { postingMessage };

const HEX = /^0x[0-9a-fA-F]*$/;
const FINGERPRINT = /^0x[0-9a-f]{64}$/;

/** The spec as it travels. JSON has no bigint, and the price is money, so it moves as a string of wei. */
const SpecOnTheWireSchema = z.object({
  idea: z.string(),
  kind: z.enum(KINDS).optional(),
  mode: z.enum(MODE_NAMES),
  price: z.string().regex(/^[0-9]+$/, "the price is a whole number of wei"),
  checks: z.array(z.object({
    says: z.string(),
    run: z.string(),
    hidden: z.boolean(),
    file: z.string().optional(),
    digest: z.string().refine((digest): digest is `0x${string}` => FINGERPRINT.test(digest), "a check's fingerprint is 32 bytes of hex").optional(),
  })).readonly(),
  allowed: z.array(z.object({ host: z.string(), why: z.string() })).readonly(),
  salt: z.string(),
});

/**
 * A posting, as it arrives from anybody. Everything in it is read through this before anything else
 * is asked of it, so a missing field is a refusal that says which, not a crash.
 */
export const PostingSchema = z.object({
  /** the name the job is known by on the wall, chosen by the poster */
  jobId: z.string(),
  /** the job's number in the contract, which the poster's transaction produced */
  onChainId: z.string().regex(/^[0-9]+$/, "the job number on the chain is a whole number"),
  spec: SpecOnTheWireSchema,
  /** every check's file, by name. The hidden ones are held until there is a verdict */
  files: z.record(z.string(), z.string()),
  poster: z.string().refine((value): value is Address => isAddress(value), "the poster is not an address"),
  signature: z.string().refine((value): value is Hex => HEX.test(value), "the signature is not hex"),
});

export type SpecOnTheWire = z.input<typeof SpecOnTheWireSchema>;
export type Posting = z.input<typeof PostingSchema>;

/** What the chain says about one job. Read, never assumed. */
export interface OnChainJob {
  readonly poster: Address;
  readonly price: bigint;
  readonly seal: Hex;
  readonly endsAt: bigint;
  readonly state: "open" | "working" | "settled" | "refunded";
}

export interface ChainReader {
  readonly jobs: Address;
  job(onChainId: bigint): Promise<OnChainJob | undefined>;
}

export type Accepted =
  | { readonly ok: true; readonly record: JobRecord }
  | { readonly ok: false; readonly status: number; readonly why: string };

const refuse = (status: number, why: string): Accepted => ({ ok: false, status, why });

/**
 * Where proven checks are looked up. Only `has` is needed here, so anything that can answer it will
 * do; the server passes the record the check writer keeps.
 */
export interface ProvenLookup {
  has(digest: string): Promise<boolean>;
}

export async function acceptPosting(store: JobStore, chain: ChainReader, asked: unknown, proven: ProvenLookup): Promise<Accepted> {
  const parsed = PostingSchema.safeParse(asked);
  if (!parsed.success) return refuse(400, parsed.error.issues[0]?.message ?? "that is not a posting");
  const posting = parsed.data;

  if (!isWallName(posting.jobId)) return refuse(400, "a job's name is lower-case letters, numbers and dashes, from 3 to 64 of them");
  if (await store.read(posting.jobId)) return refuse(409, `there is already a job called ${posting.jobId}`);

  const spec: Spec = { ...posting.spec, price: BigInt(posting.spec.price) };
  if (spec.checks.length === 0) return refuse(400, "a job with no checks has nothing to decide it");
  const unsafeFile = spec.checks.find((check) => check.file !== undefined && !isSafeName(check.file));
  if (unsafeFile) return refuse(400, `a check's file name may use letters, numbers, dots, dashes and underscores: ${unsafeFile.file}`);

  // the signature: whoever signed this is who the rest of the checks are about
  const seal = await sealSpec(spec);
  let signer: Address;
  try {
    signer = await recoverMessageAddress({
      message: postingMessage({ jobId: posting.jobId, onChainId: posting.onChainId, jobs: chain.jobs, seal }),
      signature: posting.signature,
    });
  } catch {
    return refuse(401, "that signature could not be read");
  }
  if (signer.toLowerCase() !== posting.poster.toLowerCase()) {
    return refuse(401, "that signature is not from the address that says it posted");
  }

  // the chain: the money is where the poster says it is, under the seal of what they sent
  const onChain = await chain.job(BigInt(posting.onChainId));
  if (!onChain) return refuse(404, `there is no job ${posting.onChainId} on the contract`);
  if (onChain.poster.toLowerCase() !== signer.toLowerCase()) {
    return refuse(403, `job ${posting.onChainId} was posted by somebody else`);
  }
  if (onChain.seal.toLowerCase() !== seal.toLowerCase()) {
    return refuse(409, "what you sent is not what you sealed: the seal on the chain does not match it");
  }
  if (onChain.price !== spec.price) return refuse(409, "the price you sent is not the price you paid");
  if (onChain.state !== "open") return refuse(409, `job ${posting.onChainId} is not open any more`);

  // the files: the checks that decide payment are the ones that were sealed
  const files = await filesMatchSeal(spec, posting.files);
  if (!files.ok) return refuse(409, files.why ?? "the files are not the files that were sealed");

  // and every one of them passed its three trials here: a check nobody could pass, or one that
  // passes anything, is refused even if the poster wrote it by hand and sent it without the page
  for (const check of spec.checks) {
    if (!check.digest || !(await proven.has(check.digest))) {
      return refuse(409, `"${check.says}" was never tried here: write the checks on the posting page, and post the ones that passed`);
    }
  }

  const opened = await openJob(store, {
    jobId: posting.jobId,
    seal,
    spec,
    endsAt: new Date(Number(onChain.endsAt) * 1000),
    seats: SEATS.map((role) => ({ role })),
  });
  const record: JobRecord = {
    ...opened,
    chain: { network: "monad-testnet", jobId: posting.onChainId, jobs: chain.jobs },
  };
  // the check files go in with the record. The store refuses to publish them while the job is open
  await store.save(record, posting.files);
  return { ok: true, record };
}

/** A reader for the deployed contract, which is the only authority on who paid what under which seal. */
export function readerFor(input: {
  readonly jobs: Address;
  readonly read: (onChainId: bigint) => Promise<{ poster: Address; price: bigint; seal: Hex; endsAt: bigint; state: OnChainJob["state"] }>;
}): ChainReader {
  return {
    jobs: input.jobs,
    async job(onChainId) {
      const found = await input.read(onChainId);
      // the contract answers zeroes for a job that was never posted, rather than refusing
      return /^0x0{40}$/i.test(found.poster) ? undefined : found;
    },
  };
}
