/**
 * Who a job belongs to: who paid for it, and who holds its title now.
 *
 * Both are the chain's to say. The poster is kept on the record when the job is posted, since it never
 * changes, and asked of the contract for jobs posted before it was kept. The holder is always asked,
 * because a title can be sold, and a page that remembered the first holder would be wrong after a sale.
 */
import type { Address } from "viem";
import type { OnChainJob } from "./posting.ts";
import type { JobRecord } from "./store.ts";

export interface Owners {
  /** who paid for the job, or undefined when it never reached the chain */
  posterOf(record: JobRecord): Promise<Address | undefined>;
  /** who holds the job's title now, or undefined when no title was minted */
  holderOf(record: JobRecord): Promise<Address | undefined>;
  /** the job as the contract has it now, or undefined when it never reached the chain */
  onChain(record: JobRecord): Promise<OnChainJob | undefined>;
}

export function ownersFrom(read: {
  /** the job, by its number on the contract */
  readonly job: (onChainId: bigint) => Promise<OnChainJob | undefined>;
  /** the holder of a title, when this server knows the title contract */
  readonly holder?: (tokenId: bigint) => Promise<Address>;
}): Owners {
  const onChain = async (record: JobRecord): Promise<OnChainJob | undefined> =>
    record.chain ? await read.job(BigInt(record.chain.jobId)) : undefined;
  return {
    onChain,
    async posterOf(record) {
      return record.poster ?? (await onChain(record))?.poster;
    },
    async holderOf(record) {
      const tokenId = record.chain?.tokenId;
      return tokenId !== undefined && read.holder ? await read.holder(BigInt(tokenId)) : undefined;
    },
  };
}
