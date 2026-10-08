/**
 * How much gas a call needs, asked the one way Monad's node answers it truthfully.
 *
 * A wallet library asks a node what a call will need with the fee it means to pay already stated.
 * Monad's node, asked that way about a call during which the contract pays the caller, answers with
 * far more than the call uses, and more the more the caller is paid. Measured on 8 October 2026 for a
 * poster taking a job's money back: 56,742 asked of the call alone, 1,183,207 with the fee stated.
 * Monad then holds back the whole limit times the fee before it will take the transaction, so a
 * poster holding 0.06 MON was refused, for "insufficient balance", a call that costs 0.007. Approving
 * a job's checks, which returns the writings not used, went the same way.
 *
 * Asked of the call alone, with no fee stated, the node says what the call needs. So that is how it
 * is asked here, and the answer is stated in the transaction so nothing asks again the other way.
 * Nothing here knows about Monad: on a chain whose node answers both ways alike, this is the same
 * question either way.
 */
import type { Address, Hex } from "viem";

/**
 * How much more than the node's answer is allowed for, as a fraction: the chain may have moved on by
 * the time the transaction lands. Monad charges for the limit and not for what was used, so this is
 * paid for, and is kept small.
 */
export const GAS_HEADROOM = { times: 5n, over: 4n } as const;

/** A call as a node is asked about it: who sends it, to what, with what. */
export interface CallToPrice {
  readonly account: Address;
  readonly to?: Address | null | undefined;
  readonly data?: Hex | undefined;
  readonly value?: bigint | undefined;
}

/** What reads a chain, as far as this needs it: any viem client that can ask what a call needs. */
export interface AsksWhatACallNeeds {
  estimateGas(call: { account: Address; to?: Address | null; data?: Hex; value?: bigint }): Promise<bigint>;
}

/** The gas to state for a call: what the node says the call alone needs, and a little over. */
export async function gasAskedPlainly(reads: AsksWhatACallNeeds, call: CallToPrice): Promise<bigint> {
  const needs = await reads.estimateGas({
    account: call.account,
    ...(call.to ? { to: call.to } : {}),
    ...(call.data ? { data: call.data } : {}),
    ...(call.value !== undefined ? { value: call.value } : {}),
  });
  return (needs * GAS_HEADROOM.times) / GAS_HEADROOM.over;
}
