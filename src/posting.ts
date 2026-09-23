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
import { recoverMessageAddress, type Address, type Hex } from "viem";
import { filesMatchSeal, sealSpec, type Spec } from "./job.ts";
import { openJob } from "./publish.ts";
import { isSafeName } from "./routes.ts";
import type { JobRecord, JobStore } from "./store.ts";
import { SEATS } from "./seal.ts";
import { postingMessage } from "./messages.ts";

export { postingMessage };

/** The spec as it travels. JSON has no bigint, and the price is money, so it moves as a string. */
export interface SpecOnTheWire extends Omit<Spec, "price"> {
  readonly price: string;
}

export interface Posting {
  /** the name the job is known by on the wall, chosen by the poster */
  readonly jobId: string;
  /** the job's number in the contract, which the poster's transaction produced */
  readonly onChainId: string;
  readonly spec: SpecOnTheWire;
  /** every check's file, by name. The hidden ones are held until there is a verdict */
  readonly files: Readonly<Record<string, string>>;
  readonly poster: Address;
  readonly signature: Hex;
}

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

function fromTheWire(spec: SpecOnTheWire): Spec | undefined {
  if (!/^[0-9]+$/.test(spec.price)) return undefined;
  return { ...spec, price: BigInt(spec.price) };
}

const refuse = (status: number, why: string): Accepted => ({ ok: false, status, why });

export async function acceptPosting(store: JobStore, chain: ChainReader, posting: Posting): Promise<Accepted> {
  if (!isSafeName(posting.jobId)) return refuse(400, "a job's name may use letters, numbers, dots, dashes and underscores");
  if (await store.read(posting.jobId)) return refuse(409, `there is already a job called ${posting.jobId}`);
  if (!/^[0-9]+$/.test(posting.onChainId)) return refuse(400, "the job number on the chain is a whole number");

  const spec = fromTheWire(posting.spec);
  if (!spec) return refuse(400, "the price is a whole number of wei");
  if (spec.checks.length === 0) return refuse(400, "a job with no checks has nothing to decide it");

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
  if (!files.ok) return refuse(409, files.why!);

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
