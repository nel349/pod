/**
 * Who a job belongs to: who paid for it, and who holds its title now.
 *
 * Both are the chain's to say. The poster is kept on the record when the job is posted, since it never
 * changes, and asked of the contract for jobs posted before it was kept. The holder is always asked,
 * because a title can be sold, and a page that remembered the first holder would be wrong after a sale.
 *
 * Only the contract this server answers to is asked. A record from an earlier contract has its own
 * numbering, so asking this one by that number would answer about somebody else's job.
 */
import { isAddressEqual, type Address } from "viem";
import type { OnChainJob } from "./posting.ts";
import type { JobRecord } from "./store.ts";

/** A job on the contract, by its number there, whether or not it was ever published here. */
export interface PaidJob {
  readonly onChainId: bigint;
  readonly job: OnChainJob;
}

export interface Owners {
  /** the contract these answers come from */
  readonly jobs: Address;
  /** who paid for the job, or undefined when it is not on this contract */
  posterOf(record: JobRecord): Promise<Address | undefined>;
  /** who holds the job's title now, or undefined when no title was minted */
  holderOf(record: JobRecord): Promise<Address | undefined>;
  /** the job as the contract has it now, or undefined when it is not on this contract */
  onChain(record: JobRecord): Promise<OnChainJob | undefined>;
  /**
   * Every job a wallet paid for on the contract, published or not, as the contract has it now. Found
   * by reading every job by its number: who paid for one never changes, so each is asked once and
   * remembered, and only the wallet's own are asked again, for where their money is now.
   */
  paidBy(wallet: Address): Promise<readonly PaidJob[]>;
}

export function ownersFrom(read: {
  readonly jobs: Address;
  /** the job, by its number on the contract */
  readonly job: (onChainId: bigint) => Promise<OnChainJob | undefined>;
  /** how many jobs the contract has had */
  readonly count: () => Promise<bigint>;
  /** the holder of a title, when this server knows the title contract */
  readonly holder?: (tokenId: bigint) => Promise<Address>;
}): Owners {
  const isOnThisContract = (record: JobRecord): boolean => record.chain !== undefined && isAddressEqual(record.chain.jobs, read.jobs);
  const onChain = async (record: JobRecord): Promise<OnChainJob | undefined> =>
    record.chain && isOnThisContract(record) ? await read.job(BigInt(record.chain.jobId)) : undefined;
  /** who paid for each job number read so far, which never changes */
  const payers = new Map<bigint, Address>();

  return {
    jobs: read.jobs,
    onChain,
    async posterOf(record) {
      return record.poster ?? (await onChain(record))?.poster;
    },
    async holderOf(record) {
      // a title minted for an earlier contract's job is numbered by that contract's title, not this one's
      const tokenId = isOnThisContract(record) ? record.chain?.tokenId : undefined;
      return tokenId !== undefined && read.holder ? await read.holder(BigInt(tokenId)) : undefined;
    },
    async paidBy(wallet) {
      const count = await read.count();
      const unread = Array.from({ length: Number(count) }, (_, index) => BigInt(index + 1)).filter((id) => !payers.has(id));
      const readNow = new Map<bigint, OnChainJob>();
      await Promise.all(unread.map(async (id) => {
        const job = await read.job(id);
        if (!job) return;
        payers.set(id, job.poster);
        readNow.set(id, job);
      }));
      const theirs = [...payers].filter(([, poster]) => isAddressEqual(poster, wallet)).map(([id]) => id);
      const found = await Promise.all(theirs.map(async (id): Promise<PaidJob | undefined> => {
        const job = readNow.get(id) ?? (await read.job(id));
        return job ? { onChainId: id, job } : undefined;
      }));
      return found.filter((paid): paid is PaidJob => paid !== undefined).sort((a, b) => Number(b.onChainId - a.onChainId));
    },
  };
}
