/**
 * A job on the contract as it stands now, and the chain's own time, as the server reads them for a
 * page. The server reads the chain with grouping and waiting built in, which Monad's public node needs,
 * and a browser asking it directly waited ten seconds and more. Only for showing: anything that moves
 * money is sent to the contract by the person's own wallet, and the contract decides.
 */
import { isAddress, type Address } from "viem";
import { z } from "zod";
import type { OnChainJob } from "./posting.ts";

const WHOLE = z.string().regex(/^[0-9]+$/, "a whole number").transform((value) => BigInt(value));

export const ChainJobSchema = z.object({
  poster: z.string().refine((value): value is Address => isAddress(value), "an address"),
  price: WHOLE,
  endsAt: WHOLE,
  state: z.enum(["open", "working", "settled", "refunded", "preparing"]),
  /** the chain's time when it was read, in seconds, which is what the contract's windows are measured by */
  now: WHOLE,
});
export type ChainJob = z.output<typeof ChainJobSchema>;

export function chainJobToTheWire(job: OnChainJob, now: bigint): z.input<typeof ChainJobSchema> {
  return { poster: job.poster, price: job.price.toString(), endsAt: job.endsAt.toString(), state: job.state, now: now.toString() };
}
