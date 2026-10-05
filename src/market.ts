/**
 * What the posting page needs to know about the market it posts to.
 *
 * The server hands this to the page, and the page builds its wallet connection from it: which chain,
 * which contract, what the money is called. A schema, because it crosses the network and the page
 * checks it rather than trusting it; safe to use on both sides.
 */
import { isAddress, type Address } from "viem";
import { z } from "zod";

export const MarketConfigSchema = z.object({
  chainId: z.number().int().positive(),
  chainName: z.string(),
  rpc: z.url(),
  jobs: z.string().refine((value): value is Address => isAddress(value), "the contract is not an address"),
  explorer: z.url(),
  coin: z.string(),
  /**
   * The ERC-8004 registries, where an agent asks for the verdict on its seat to be recorded. Absent
   * on a server that records nothing there.
   */
  registries: z.object({
    identity: z.string().refine((value): value is Address => isAddress(value), "the identity registry is not an address"),
    validation: z.string().refine((value): value is Address => isAddress(value), "the validation registry is not an address"),
  }).optional(),
  /** where a new, empty wallet can be sent the chain's coin, when the chain has such a place */
  faucet: z.url().optional(),
  /**
   * What writing a job's checks costs, when the contract prepares jobs: the poster pays the job's
   * price and this many writings at once, and each writing after them on its own. Absent on a contract
   * that takes the checks with the payment.
   */
  writing: z.object({
    price: z.string().regex(/^[0-9]+$/, "a writing's price is a whole number of wei"),
    included: z.number().int().positive(),
  }).optional(),
});

export type MarketConfig = z.infer<typeof MarketConfigSchema>;

/**
 * What the server says back to anything the page sends it: where to look next, or why not. Every
 * write route answers in this one shape, so the page reads them all the same way.
 */
export const AnswerSchema = z.object({ url: z.string().optional(), why: z.string().optional() });

/** Whether a job by some name already exists, which the page asks before anybody pays for the name. */
export const NameTakenSchema = z.object({ taken: z.boolean() });

/** Where a block explorer shows an address and a transaction, after its own address. */
export const EXPLORER_PATHS = { address: "/address/", transaction: "/tx/" } as const;

export const explorerAddress = (explorer: string, address: string): string => `${explorer}${EXPLORER_PATHS.address}${address}`;
export const explorerTransaction = (explorer: string, hash: string): string => `${explorer}${EXPLORER_PATHS.transaction}${hash}`;
