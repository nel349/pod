/**
 * Who a job belongs to: who paid for it, and who holds its title now.
 *
 * Both are the chain's to say. The poster is kept on the record when the job is posted, since it never
 * changes, and asked of the contract for jobs posted before it was kept. The holder is always asked,
 * because a title can be sold, and a page that remembered the first holder would be wrong after a sale.
 *
 * A record is asked of the contract it names, and only of a contract this server answers to: the one
 * jobs are posted to now, and the one they were posted to before (R12). A record from any other
 * contract has its own numbering, so asking one of these by that number would answer about somebody
 * else's job.
 */
import { isAddressEqual, type Address } from "viem";
import type { OnChainJob } from "./posting.ts";
import type { JobRecord } from "./store.ts";

/** A job on a contract, by its number there, whether or not it was ever published here. */
export interface PaidJob {
  /** the contract it is on */
  readonly jobs: Address;
  readonly onChainId: bigint;
  readonly job: OnChainJob;
}

/** One contract, read the way owners need it. */
export interface OwnedContract {
  readonly jobs: Address;
  /** the job, by its number on the contract, or nothing when the contract never numbered one so */
  readonly job: (onChainId: bigint) => Promise<OnChainJob | undefined>;
  /** the highest number the contract has given out */
  readonly count: () => Promise<bigint>;
}

export interface Owners {
  /** whether a record is of a job on a contract these answers come from */
  isAnswered(record: JobRecord): boolean;
  /** who paid for the job, or undefined when it is not on a contract answered here */
  posterOf(record: JobRecord): Promise<Address | undefined>;
  /** who holds the job's title now, or undefined when no title was minted */
  holderOf(record: JobRecord): Promise<Address | undefined>;
  /** the job as its contract has it now, or undefined when it is not on a contract answered here */
  onChain(record: JobRecord): Promise<OnChainJob | undefined>;
  /**
   * Every job a wallet paid for on the contracts, published or not, as each has it now. Found by
   * reading every job by its number: who paid for one never changes, so each is asked once and
   * remembered, and only the wallet's own are asked again, for where their money is now.
   */
  paidBy(wallet: Address): Promise<readonly PaidJob[]>;
}

export function ownersFrom(read: {
  readonly contracts: readonly OwnedContract[];
  /** the holder of a title, when this server knows the title contract; one for every contract, numbered by the job */
  readonly holder?: (tokenId: bigint) => Promise<Address>;
}): Owners {
  const contractOf = (record: JobRecord): OwnedContract | undefined => {
    const on = record.chain?.jobs;
    return on === undefined ? undefined : read.contracts.find((contract) => isAddressEqual(contract.jobs, on));
  };
  const onChain = async (record: JobRecord): Promise<OnChainJob | undefined> => {
    const contract = contractOf(record);
    return contract && record.chain ? await contract.job(BigInt(record.chain.jobId)) : undefined;
  };
  /** who paid for each number on each contract read so far, or that nobody did, which never changes either */
  const payers = new Map<string, Address | null>();
  const key = (jobs: Address, id: bigint): string => `${jobs.toLowerCase()}:${id}`;

  async function paidOn(contract: OwnedContract, wallet: Address): Promise<readonly PaidJob[]> {
    const count = await contract.count();
    const unread = Array.from({ length: Number(count) }, (_, index) => BigInt(index + 1)).filter((id) => !payers.has(key(contract.jobs, id)));
    const readNow = new Map<bigint, OnChainJob>();
    await Promise.all(unread.map(async (id) => {
      const job = await contract.job(id);
      // a number below the count with no job is one this contract never gave out, as when it began after another
      payers.set(key(contract.jobs, id), job ? job.poster : null);
      if (job) readNow.set(id, job);
    }));
    const theirs = Array.from({ length: Number(count) }, (_, index) => BigInt(index + 1)).filter((id) => {
      const poster = payers.get(key(contract.jobs, id));
      return poster !== undefined && poster !== null && isAddressEqual(poster, wallet);
    });
    const found = await Promise.all(theirs.map(async (id): Promise<PaidJob | undefined> => {
      const job = readNow.get(id) ?? (await contract.job(id));
      return job ? { jobs: contract.jobs, onChainId: id, job } : undefined;
    }));
    return found.filter((paid): paid is PaidJob => paid !== undefined);
  }

  return {
    isAnswered: (record) => contractOf(record) !== undefined,
    onChain,
    async posterOf(record) {
      return record.poster ?? (await onChain(record))?.poster;
    },
    async holderOf(record) {
      // a title minted for a job on a contract not answered here is numbered by that contract's title, not this one's
      const tokenId = contractOf(record) ? record.chain?.tokenId : undefined;
      return tokenId !== undefined && read.holder ? await read.holder(BigInt(tokenId)) : undefined;
    },
    async paidBy(wallet) {
      const each = await Promise.all(read.contracts.map((contract) => paidOn(contract, wallet)));
      return each.flat().sort((a, b) => Number(b.onChainId - a.onChainId));
    },
  };
}
